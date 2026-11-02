import { Buffer } from 'node:buffer'
import process from 'node:process'
import { request, requestJson } from '@imba97/ci-kit-http'
import { resolvePreset } from './providers'

export * from './providers'

export interface TextOptions {
  prompt: string
  system?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface ImageOptions {
  prompt: string
  size?: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export interface AiResult<T> {
  value: T
  model: string
  protocol: string
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>
}

interface ImageResponse {
  data?: Array<{ b64_json?: string, url?: string }>
}

function apiKeyOf(env: NodeJS.ProcessEnv, keyEnv: string): string {
  const key = env[keyEnv]
  if (!key) {
    throw new Error(`Missing ${keyEnv}; set it in the environment or .env store`)
  }
  return key
}

export async function text(options: TextOptions): Promise<AiResult<string>> {
  const env = options.env ?? process.env
  const preset = resolvePreset(env)
  const provider = preset.text
  if (!provider) {
    throw new Error('The selected AI_PROVIDER has no text endpoint')
  }
  const key = apiKeyOf(env, provider.apiKeyEnv)
  const messages = [
    ...(options.system ? [{ role: 'system', content: options.system }] : []),
    { role: 'user', content: options.prompt }
  ]
  const data = await requestJson<ChatResponse>(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, messages, stream: false })
  }, { timeoutMs: options.timeoutMs })
  const value = data.choices?.[0]?.message?.content?.trim()
  if (!value) {
    throw new Error('Empty text response from provider')
  }
  return { value, model: provider.model, protocol: provider.protocol }
}

export async function image(options: ImageOptions): Promise<AiResult<Uint8Array>> {
  const env = options.env ?? process.env
  const preset = resolvePreset(env)
  const provider = preset.image
  if (!provider) {
    throw new Error('The selected AI_PROVIDER has no image endpoint')
  }
  const key = apiKeyOf(env, provider.apiKeyEnv)
  const size = options.size ?? '1280x720'

  if (provider.protocol === 'seedream') {
    const data = await requestJson<ImageResponse>(`${provider.baseUrl.replace(/\/$/, '')}/images/generations`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: provider.model, prompt: options.prompt, size, response_format: 'b64_json' })
    }, { timeoutMs: options.timeoutMs })
    const item = data.data?.[0]
    if (item?.b64_json) {
      return { value: new Uint8Array(Buffer.from(item.b64_json, 'base64')), model: provider.model, protocol: provider.protocol }
    }
    if (item?.url) {
      const response = await request(item.url, {}, { timeoutMs: options.timeoutMs })
      return { value: new Uint8Array(await response.arrayBuffer()), model: provider.model, protocol: provider.protocol }
    }
    throw new Error('Empty image response from provider')
  }

  const data = await requestJson<ImageResponse>(`${provider.baseUrl.replace(/\/$/, '')}/images/generations`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: provider.model, prompt: options.prompt, size: size.replace('x', '*'), n: 1 })
  }, { timeoutMs: options.timeoutMs })
  const item = data.data?.[0]
  if (item?.b64_json) {
    return { value: new Uint8Array(Buffer.from(item.b64_json, 'base64')), model: provider.model, protocol: provider.protocol }
  }
  if (item?.url) {
    const response = await request(item.url, {}, { timeoutMs: options.timeoutMs })
    return { value: new Uint8Array(await response.arrayBuffer()), model: provider.model, protocol: provider.protocol }
  }
  throw new Error('Empty image response from provider')
}
