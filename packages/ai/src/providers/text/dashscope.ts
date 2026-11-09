import type { TextProvider } from '../types'

/**
 * DashScope OpenAI compatible mode.
 * Text models are addressed by their vendor qualified name, for example
 * `ZHIPU/GLM-5.3-Flash` or `qwen-plus`.
 */
export const dashscopeText: TextProvider = {
  id: 'dashscope',
  label: 'Alibaba DashScope (compatible mode)',
  protocol: 'openai',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'ZHIPU/GLM-5.3-Flash',
  apiKeyEnv: 'AI_API_KEY',
  supportsTools: true
}
