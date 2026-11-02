import type { ImageProvider } from '../types'

/**
 * Volcengine Ark Seedream.
 * Returns base64 when `response_format` is b64_json, otherwise a temporary URL.
 */
export const seedreamImage: ImageProvider = {
  id: 'seedream',
  label: 'Volcengine Ark Seedream',
  protocol: 'seedream',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedream-5-0-flash-260915',
  apiKeyEnv: 'AI_IMAGE_API_KEY',
  defaultSize: '1280x720'
}
