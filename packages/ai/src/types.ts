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

/** A provider-neutral function the model may call while composing a reply. */
export interface ToolSpec {
  name: string
  description?: string
  parameters: JsonSchema
}

/** One function call requested by the model. */
export interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

/** A tool invocation completed during one text request. */
export interface ToolExecution {
  id: string
  name: string
  arguments: unknown
  result?: unknown
  error?: string
  durationMs: number
}

export type ToolExecutor = (call: ToolCall) => Promise<unknown> | unknown

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
  /** Functions the model may call before returning its final text. */
  tools?: readonly ToolSpec[]
  /** Executes a function requested by the model. Required when tools are supplied. */
  executeTool?: ToolExecutor
  /** Maximum number of function calls allowed during this request. */
  maxToolCalls?: number
  /** Maximum characters of one tool result placed back into the model context. */
  maxToolResultChars?: number
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
  /** Tool calls completed before the final answer, when tools were enabled. */
  toolCalls?: ToolExecution[]
}
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'max'
