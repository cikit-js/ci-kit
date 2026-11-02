export interface RequestOptions {
  timeoutMs?: number
  retries?: number
  retryDelayMs?: number
}

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string
  ) {
    super(`HTTP ${status} ${url}`)
    this.name = 'HttpError'
  }
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 800

export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status === 408 || error.status === 429 || error.status >= 500
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return true
    }
    return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i.test(error.message)
  }
  return false
}

export async function request(
  url: string,
  init: RequestInit = {},
  options: RequestOptions = {}
): Promise<Response> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS
  } = options

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new HttpError(url, response.status, body.slice(0, 500))
      }
      return response
    }
    catch (error) {
      lastError = error
      if (attempt === retries || !isRetryable(error)) {
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, retryDelayMs * 2 ** attempt))
    }
  }
  throw lastError
}

export async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  options: RequestOptions = {}
): Promise<T> {
  const response = await request(url, init, options)
  return (await response.json()) as T
}

export async function requestBuffer(
  url: string,
  init: RequestInit = {},
  options: RequestOptions = {}
): Promise<Uint8Array> {
  const response = await request(url, init, options)
  return new Uint8Array(await response.arrayBuffer())
}
