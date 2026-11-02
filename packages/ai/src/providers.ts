import process from 'node:process'

export interface TextProvider {
  protocol: 'openai' | 'dashscope'
  baseUrl: string
  model: string
  apiKeyEnv: string
}

export interface ImageProvider {
  protocol: 'openai' | 'dashscope' | 'seedream'
  baseUrl: string
  model: string
  apiKeyEnv: string
}

export interface ProviderPreset {
  text?: TextProvider
  image?: ImageProvider
}

export const presets: Record<string, ProviderPreset> = {
  'aliyun': {
    text: {
      protocol: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'ZHIPU/GLM-5.3-Flash',
      apiKeyEnv: 'AI_API_KEY'
    },
    image: {
      protocol: 'dashscope',
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      model: 'qwen-image-3.0',
      apiKeyEnv: 'AI_IMAGE_API_KEY'
    }
  },
  'aliyun-seedream': {
    text: {
      protocol: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'ZHIPU/GLM-5.3-Flash',
      apiKeyEnv: 'AI_API_KEY'
    },
    image: {
      protocol: 'seedream',
      baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      model: 'doubao-seedream-5-0-flash-260915',
      apiKeyEnv: 'AI_IMAGE_API_KEY'
    }
  }
}

export const defaultPreset = 'aliyun-seedream'

export function resolvePreset(env: NodeJS.ProcessEnv = process.env): ProviderPreset {
  const name = env.AI_PROVIDER || defaultPreset
  const preset = presets[name]
  if (!preset) {
    throw new Error(`Unknown AI_PROVIDER: ${name}. Available: ${Object.keys(presets).join(', ')}`)
  }
  return preset
}
