import type { ImageProvider } from './providers'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { request, requestJson } from '@imba97/ci-kit-http'
import { resolveImageProvider, resolveTextProvider } from './providers'

export * from './providers'

export interface TextOptions {
  prompt: string
  system?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ImageOptions {
  prompt: string
  size?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface AiResult<T> {
  value: T
  provider: string
  model: string
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

interface ImageResponse {
  data?: Array<{ b64_json?: string, url?: string }>
}

function apiKeyOf(env: NodeJS.ProcessEnv, keyEnv: string): string {
  const key = env[keyEnv]
  if (!key) {
    throw new Error(`Missing ${keyEnv}; set it in the environment or .env store`)
  }
  return key
}

function trimSlash(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

export async function text(options: TextOptions): Promise<AiResult<string>> {
  const env = options.env ?? process.env
  const provider = resolveTextProvider(env)
  const key = apiKeyOf(env, provider.apiKeyEnv)
  const messages = [
    ...(options.system ? [{ role: 'system', content: options.system }] : []),
    { role: 'user', content: options.prompt }
  ]
  const data = await requestJson<ChatResponse>(`${trimSlash(provider.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages, stream: false })
  }, { timeoutMs: options.timeoutMs })

  const value = data.choices?.[0]?.message?.content?.trim()
  if (!value) {
    throw new Error(`Empty text response from ${provider.id}`)
  }
  return { value, provider: provider.id, model: provider.model }
}

export async function image(options: ImageOptions): Promise<AiResult<Uint8Array>> {
  const env = options.env ?? process.env
  const provider = resolveImageProvider(env)
  const key = apiKeyOf(env, provider.apiKeyEnv)
  const size = normalizeSize(options.size ?? provider.defaultSize ?? '1280x720', provider)

  const body = provider.protocol === 'seedream'
    ? { model: provider.model, prompt: options.prompt, size, response_format: 'b64_json' }
    : { model: provider.model, prompt: options.prompt, size, n: 1 }

  const data = await requestJson<ImageResponse>(`${trimSlash(provider.baseUrl)}/images/generations`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }, { timeoutMs: options.timeoutMs })

  const value = await readImagePayload(data, options.timeoutMs)
  return { value, provider: provider.id, model: provider.model }
}

/**
 * Vendors disagree on the size separator, and some accept only a fixed set.
 * Keep `WxH` in the public API and translate here.
 */
function normalizeSize(size: string, provider: ImageProvider): string {
  const [width, height] = size.toLowerCase().split('x')
  if (!width || !height) {
    throw new Error(`Invalid size: ${size}. Expected WxH, for example 1280x720`)
  }
  return `${width}${provider.sizeSeparator ?? 'x'}${height}`
}

async function readImagePayload(data: ImageResponse, timeoutMs?: number): Promise<Uint8Array> {
  const item = data.data?.[0]
  if (item?.b64_json) {
    return new Uint8Array(Buffer.from(item.b64_json, 'base64'))
  }
  if (item?.url) {
    const response = await request(item.url, {}, { timeoutMs })
    return new Uint8Array(await response.arrayBuffer())
  }
  throw new Error('Empty image response from provider')
}
