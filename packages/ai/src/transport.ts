import type { TextProvider } from './providers'
import { HttpError } from '@ci-kit/http'
import { AiError, classifyStatus } from './errors'

export interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string
      tool_calls?: Array<{
        id?: string
        type?: string
        function?: { name?: string, arguments?: string }
      }>
    }
    finish_reason?: string
  }>
  usage?: { prompt_tokens?: number, completion_tokens?: number }
}

export interface ImageItem {
  b64_json?: string
  url?: string
  error?: { code?: string, message?: string }
}

export interface ImageResponse {
  data?: ImageItem[]
}

export function apiKeyOf(env: NodeJS.ProcessEnv, keyEnv: string, provider?: string): string {
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

export function trimSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '')
}

export function wrapError(error: unknown, provider: { id: string, model: string }, context: string): AiError {
  if (error instanceof AiError)
    return error
  if (error instanceof HttpError) {
    const { kind, retryable } = classifyStatus(error.status)
    return new AiError({
      kind,
      provider: provider.id,
      model: provider.model,
      status: error.status,
      retryable,
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

export function supportsJsonMode(provider: TextProvider): boolean {
  return provider.protocol === 'openai' || provider.protocol === 'dashscope'
}

export function supportsJsonSchema(provider: TextProvider): boolean {
  return provider.protocol === 'openai' || provider.protocol === 'dashscope'
}

export function supportsToolCalling(provider: TextProvider): boolean {
  return provider.supportsTools === true
}
