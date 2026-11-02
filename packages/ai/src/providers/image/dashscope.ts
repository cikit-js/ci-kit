import type { ImageProvider } from '../types'

/**
 * DashScope image generation.
 * The API expects `1280*720` style sizes, hence the custom separator.
 */
export const dashscopeImage: ImageProvider = {
  id: 'dashscope-image',
  label: 'Alibaba DashScope (image)',
  protocol: 'dashscope',
  baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  model: 'qwen-image-3.0',
  apiKeyEnv: 'AI_IMAGE_API_KEY',
  defaultSize: '1280x720',
  sizeSeparator: '*'
}
