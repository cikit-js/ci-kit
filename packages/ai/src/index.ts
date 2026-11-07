import type { ImageProvider, TextProvider } from './providers'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { HttpError, request, requestJson } from '@ci-kit/http'
import { AiError, classifyStatus } from './errors'
import { resolveImageProvider, resolveTextProvider } from './providers'

export * from './errors'
export * from './providers'

/**
 * The subset of JSON Schema an output contract needs: a typed object with named,
 * required properties and optional enums.
 *
 * Deliberately narrow. A caller describing more than this is usually translating
 * a prompt into a schema, and a schema that cannot be honoured by a provider is
 * worse than a plain `json_object` request.
 */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, JsonProperty>
  required?: readonly string[]
  additionalProperties?: boolean
}

/**
 * One property of an object schema, or an array element.
 *
 * `items` is a node rather than an object schema so an array of strings is
 * expressible without inventing a wrapper object.
 */
export interface JsonProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'null'
  description?: string
  /** Fixed set of allowed values. */
  enum?: readonly string[]
  /** Element shape when `type` is `array`. */
  items?: JsonProperty
  /** Field shapes when `type` is `object`. */
  properties?: Record<string, JsonProperty>
  required?: readonly string[]
  additionalProperties?: boolean
  /**
   * Alternatives, for a field that is not one type — `string | null` above all.
   *
   * The JSON Schema that providers accept spells a nullable field this way, and
   * `type` itself stays a single string so existing schemas keep working.
   */
  anyOf?: readonly JsonProperty[]
}

export interface TextOptions {
  prompt: string
  system?: string
  /** Upper bound for the generated text. Providers that support it pass it through. */
  maxTokens?: number
  /** Ask the provider for a JSON object. Unsupported providers throw instead of ignoring it. */
  json?: boolean
  /**
   * JSON Schema the reply must satisfy.
   *
   * Passing a schema implies `json: true`: the schema is the contract, and a
   * provider that can only guarantee "some JSON object" is asked for exactly
   * that. Providers with structured output honour the schema; the rest still
   * get `json_object`, and the caller validates against the same schema.
   *
   * The schema is what replaces hand-written JSON in a prompt: the shape lives in
   * code, next to the parser that reads it, instead of being described in prose
   * the model may paraphrase.
   */
  schema?: JsonSchema
  temperature?: number
  /**
   * How hard a reasoning model should think before answering.
   *
   * Omitted means the provider's own default: the caller states a preference
   * only when it has one. Providers that always reason reject `none`; they
   * still honour the graded levels.
   *
   * This matters because reasoning and the answer share one `maxTokens`
   * budget. A model that thinks for 2000 tokens returns an empty answer when
   * the budget is 80, so a caller wanting a one-line reply either lowers the
   * effort or raises the budget.
   */
  reasoningEffort?: ReasoningEffort
  /**
   * Transport retries. Defaults to the http package value.
   * Pass 0 for paid or non-idempotent calls: the provider may already have
   * completed the request, and retrying charges again.
   */
  retries?: number
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ImageOptions {
  prompt: string
  size?: string
  retries?: number
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface TokenUsage {
  input: number
  output: number
}

export interface AiResult<T> {
  value: T
  provider: string
  model: string
  /** Present when the provider reports token usage. */
  usage?: TokenUsage
  /** Raw provider finish reason, for example `stop` or `length`. */
  finishReason?: string
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }, finish_reason?: string }>
  usage?: { prompt_tokens?: number, completion_tokens?: number }
}

interface ImageItem {
  b64_json?: string
  url?: string
  error?: { code?: string, message?: string }
}

interface ImageResponse {
  data?: ImageItem[]
}

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47]
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF]

function apiKeyOf(env: NodeJS.ProcessEnv, keyEnv: string, provider?: string): string {
  const key = env[keyEnv]?.trim()
  if (!key) {
    throw new AiError({
      kind: 'config',
      provider,
      message: `Missing ${keyEnv}; set it in the environment or .env store`
    })
  }
  return key
}

function trimSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

/** Turn anything thrown by the http layer into an AiError with a stable kind. */
function wrapError(error: unknown, provider: { id: string, model: string }, context: string): AiError {
  if (error instanceof AiError) {
    return error
  }
  if (error instanceof HttpError) {
    const { kind, retryable } = classifyStatus(error.status)
    return new AiError({
      kind,
      provider: provider.id,
      model: provider.model,
      status: error.status,
      retryable,
      // The body is deliberately dropped: it can echo the prompt or request.
      message: `${context} rejected by the provider`,
      cause: error
    })
  }
  if (error instanceof Error) {
    const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError'
    return new AiError({
      kind: 'network',
      provider: provider.id,
      model: provider.model,
      // A timeout after the provider accepted the request must not be retried
      // blindly, so it is reported as non-retryable by default.
      retryable: !timedOut,
      message: timedOut
        ? `${context} timed out`
        : `${context} request failed: ${error.message}`,
      cause: error
    })
  }
  return new AiError({
    kind: 'network',
    provider: provider.id,
    model: provider.model,
    message: `${context} failed`,
    cause: error
  })
}

/** Providers that accept `response_format` for a JSON object. */
function supportsJsonMode(provider: TextProvider): boolean {
  return provider.protocol === 'openai' || provider.protocol === 'dashscope'
}

/**
 * Providers that honour a named JSON schema in `response_format`.
 *
 * OpenAI-compatible endpoints and DashScope both accept `json_schema`; anything
 * else still gets `json_object`, which is weaker but never wrong: the caller
 * validates the same schema either way.
 */
function supportsJsonSchema(provider: TextProvider): boolean {
  return provider.protocol === 'openai' || provider.protocol === 'dashscope'
}

export async function text(options: TextOptions): Promise<AiResult<string>> {
  const env = options.env ?? process.env
  const provider = resolveTextProvider(env)
  // A schema is a stronger way of saying "JSON", so it implies it.
  const wantJson = options.json === true || options.schema !== undefined

  if (wantJson && !supportsJsonMode(provider)) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: `Provider ${provider.id} does not support JSON output; remove json or schema, or change provider`
    })
  }

  const key = apiKeyOf(env, provider.apiKeyEnv, provider.id)
  const messages = [
    ...(options.system
      ? [
          { role: 'system', content: options.system }
        ]
      : []),
    { role: 'user', content: options.prompt }
  ]

  const body: Record<string, unknown> = {
    model: env.AI_TEXT_MODEL || provider.model,
    messages,
    stream: false
  }
  if (options.maxTokens !== undefined) {
    body.max_tokens = options.maxTokens
  }
  if (options.temperature !== undefined) {
    body.temperature = options.temperature
  }
  if (options.reasoningEffort !== undefined) {
    // Sent as the OpenAI-compatible field: DashScope and the other
    // compatible-mode providers read it, and a provider that does not know it
    // ignores it rather than failing the call.
    body.reasoning_effort = options.reasoningEffort
  }
  if (wantJson) {
    body.response_format = options.schema && supportsJsonSchema(provider)
      // A named schema is enforced by the provider, so the model is not free to
      // invent field names; the parser downstream still treats it as untrusted.
      ? {
          type: 'json_schema',
          json_schema: { name: 'reply', strict: true, schema: options.schema }
        }
      : { type: 'json_object' }
  }

  let data: ChatResponse
  try {
    data = await requestJson<ChatResponse>(`${trimSlash(provider.baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, { timeoutMs: options.timeoutMs, retries: options.retries })
  }
  catch (error) {
    throw wrapError(error, provider, 'text')
  }

  const choice = data.choices?.[0]
  const value = choice?.message?.content?.trim()
  if (!value) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      message: 'Empty text response from provider'
    })
  }

  // A truncated response is still a string; callers must be able to tell.
  const finishReason = choice?.finish_reason
  if (finishReason && finishReason !== 'stop') {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      retryable: finishReason === 'length',
      message: `Text generation ended with finish_reason=${finishReason}; the content is incomplete`
    })
  }

  return {
    value,
    provider: provider.id,
    model: String(body.model),
    usage: data.usage
      ? { input: Number(data.usage.prompt_tokens) || 0, output: Number(data.usage.completion_tokens) || 0 }
      : undefined,
    finishReason
  }
}

export async function image(options: ImageOptions): Promise<AiResult<Uint8Array>> {
  const env = options.env ?? process.env
  const provider = resolveImageProvider(env)
  const key = apiKeyOf(env, provider.apiKeyEnv, provider.id)
  const rawSize = options.size ?? env.AI_IMAGE_SIZE ?? provider.defaultSize ?? '1280x720'
  const size = normalizeSize(rawSize, provider)

  const body = provider.protocol === 'seedream'
    ? {
        model: env.AI_IMAGE_MODEL || provider.model,
        prompt: options.prompt,
        size,
        response_format: 'b64_json'
      }
    : {
        model: env.AI_IMAGE_MODEL || provider.model,
        prompt: options.prompt,
        size,
        n: 1
      }

  let data: ImageResponse
  try {
    data = await requestJson<ImageResponse>(`${trimSlash(provider.baseUrl)}/images/generations`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, { timeoutMs: options.timeoutMs, retries: options.retries })
  }
  catch (error) {
    throw wrapError(error, provider, 'image')
  }

  const items = data.data
  if (!Array.isArray(items) || items.length !== 1) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      message: `Expected exactly 1 image, received ${Array.isArray(items)
        ? items.length
        : 'none'}`
    })
  }
  const item = items[0]!
  if (item.error) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      // Only the code is surfaced; provider messages may echo the prompt.
      message: `Image item failed${item.error.code
        ? ` with code ${item.error.code}`
        : ''}`
    })
  }

  const value = await readImagePayload(item, provider, options.timeoutMs, options.retries)
  const format = detectImageFormat(value)
  if (!format) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      message: 'Image payload is neither PNG nor JPEG'
    })
  }

  return {
    value,
    provider: provider.id,
    model: String(body.model)
  }
}

/**
 * Vendors disagree on the size separator, and some accept only a fixed set.
 * Keep `WxH` in the public API and translate here.
 */
function normalizeSize(size: string, provider: ImageProvider): string {
  const [width, height] = size.toLowerCase().split('x')
  if (!width || !height || !Number.isFinite(Number(width)) || !Number.isFinite(Number(height))) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: `Invalid size: ${size}. Expected WxH, for example 1280x720`
    })
  }
  return `${width}${provider.sizeSeparator ?? 'x'}${height}`
}

/**
 * A signed image URL is fetched without the API Authorization header: the
 * signature is the credential and the host is not the model API.
 */
async function readImagePayload(item: ImageItem, provider: ImageProvider, timeoutMs?: number, retries?: number): Promise<Uint8Array> {
  if (item.b64_json) {
    return new Uint8Array(Buffer.from(item.b64_json, 'base64'))
  }
  if (item.url) {
    if (!/^https:\/\//i.test(item.url)) {
      throw new AiError({
        kind: 'output',
        provider: provider.id,
        model: provider.model,
        message: 'Image URL must be HTTPS'
      })
    }
    try {
      const response = await request(item.url, {}, { timeoutMs, retries })
      return new Uint8Array(await response.arrayBuffer())
    }
    catch (error) {
      throw wrapError(error, provider, 'image download')
    }
  }
  throw new AiError({
    kind: 'output',
    provider: provider.id,
    model: provider.model,
    message: 'Empty image response from provider'
  })
}

export type ImageFormat = 'png' | 'jpeg'

/**
 * Graded reasoning effort for thinking models.
 *
 * `none` asks for no reasoning at all; providers whose model always thinks
 * reject it, so callers that must work across providers stick to the graded
 * levels and let the provider default decide.
 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max'

export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 4 && PNG_MAGIC.every((byte, index) => bytes[index] === byte)) {
    return 'png'
  }
  if (bytes.length >= 3 && JPEG_MAGIC.every((byte, index) => bytes[index] === byte)) {
    return 'jpeg'
  }
  return null
}
