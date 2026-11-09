import type { TextProvider } from '../types'

/**
 * MiniMax ChatCompletion v2 exposes an OpenAI-compatible chat endpoint.
 * The default model keeps the provider usable without another model variable.
 */
export const minimaxText: TextProvider = {
  id: 'minimax',
  label: 'MiniMax (compatible mode)',
  protocol: 'openai',
  baseUrl: 'https://api.minimax.chat/v1',
  model: 'MiniMax-M3.1-Flash',
  apiKeyEnv: 'AI_API_KEY',
  supportsTools: true
}
