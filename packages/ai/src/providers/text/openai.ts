import type { TextProvider } from '../types'

/**
 * Any OpenAI compatible chat completions endpoint.
 * Override baseUrl and model through the exported factory when the vendor differs.
 */
export const openaiText: TextProvider = {
  id: 'openai',
  label: 'OpenAI (chat completions)',
  protocol: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4.1-mini',
  apiKeyEnv: 'AI_API_KEY'
}

export function createOpenAiCompatibleText(input: {
  id: string
  label: string
  baseUrl: string
  model: string
  apiKeyEnv?: string
}): TextProvider {
  return {
    protocol: 'openai',
    apiKeyEnv: 'AI_API_KEY',
    ...input
  }
}
