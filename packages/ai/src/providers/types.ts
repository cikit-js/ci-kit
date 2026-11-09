export type TextProtocol = 'openai' | 'dashscope'
export type ImageProtocol = 'seedream' | 'dashscope' | 'openai'

export interface TextProvider {
  /** Registry key, used by AI_TEXT_PROVIDER */
  id: string
  /** Human readable vendor name */
  label: string
  protocol: TextProtocol
  baseUrl: string
  model: string
  /** Environment variable holding the key; keys are never passed as flags */
  apiKeyEnv: string
  /** Whether this endpoint accepts OpenAI-compatible function tools. */
  supportsTools?: boolean
}

export interface ImageProvider {
  id: string
  label: string
  protocol: ImageProtocol
  baseUrl: string
  model: string
  apiKeyEnv: string
  /** Provider specific default size, for example 1280x720 */
  defaultSize?: string
  /** Size separator used by the API, defaults to x */
  sizeSeparator?: string
}
