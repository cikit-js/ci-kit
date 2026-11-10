/**
 * Structured AI failures.
 *
 * Callers branch on `kind`, never on message text. The message stays short and
 * never carries credentials, request bodies or provider payloads, because CI
 * logs are usually readable by anyone with repository access.
 */
export type AiErrorKind
  /** Missing or rejected credentials. */
  = | 'auth'
  /** Rate limited or out of quota. */
    | 'quota'
  /** Bad request: unknown model, unsupported parameter, incompatible payload. */
    | 'request'
  /** Unreachable host, DNS failure, timeout. */
    | 'network'
  /** Provider returned 5xx. */
    | 'server'
  /** Request succeeded but the payload could not be used. */
    | 'output'
  /** Local configuration problem, before any network call. */
    | 'config'

export interface AiErrorInit {
  kind: AiErrorKind
  message: string
  provider?: string
  model?: string
  status?: number
  /** Whether the same request may succeed later without changing anything. */
  retryable?: boolean
  cause?: unknown
  rawReply?: string
}

export class AiError extends Error {
  readonly kind: AiErrorKind
  readonly provider?: string
  readonly model?: string
  readonly status?: number
  readonly retryable: boolean
  readonly rawReply?: string

  constructor(init: AiErrorInit) {
    super(init.message, { cause: init.cause })
    this.name = 'AiError'
    this.kind = init.kind
    this.provider = init.provider
    this.model = init.model
    this.status = init.status
    this.retryable = init.retryable ?? false
    this.rawReply = init.rawReply
  }

  /** One line for logs. Never includes the request body or the key. */
  describe(): string {
    const parts: string[] = [this.kind]
    if (this.provider) {
      parts.push(this.provider)
    }
    if (this.model) {
      parts.push(this.model)
    }
    if (this.status !== undefined) {
      parts.push(`HTTP ${this.status}`)
    }
    return `${parts.join(' / ')}: ${this.message}`
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError
}

/** Map an HTTP status to a kind and whether a plain retry can help. */
export function classifyStatus(status: number): { kind: AiErrorKind, retryable: boolean } {
  if (status === 401 || status === 403) {
    return { kind: 'auth', retryable: false }
  }
  if (status === 429) {
    return { kind: 'quota', retryable: true }
  }
  if (status === 408) {
    return { kind: 'network', retryable: true }
  }
  if (status >= 500) {
    return { kind: 'server', retryable: true }
  }
  return { kind: 'request', retryable: false }
}
