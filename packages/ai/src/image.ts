import type { ImageProvider } from './providers'
import type { ImageItem, ImageResponse } from './transport'
import type { AiResult, ImageOptions } from './types'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { request, requestJson } from '@ci-kit/http'
import { AiError } from './errors'
import { resolveImageProvider } from './providers'
import { apiKeyOf, trimSlash, wrapError } from './transport'

export async function image(options: ImageOptions): Promise<AiResult<Uint8Array>> {
  const env = options.env ?? process.env
  const provider = resolveImageProvider(env)
  const key = apiKeyOf(env, provider.apiKeyEnv, provider.id)
  const rawSize = options.size ?? env.AI_IMAGE_SIZE ?? provider.defaultSize ?? '1280x720'
  const size = normalizeSize(rawSize, provider)

  const body = provider.protocol === 'seedream'
    ? {
        model: env.AI_IMAGE_MODEL || provider.model,
        prompt: options.prompt,
        size,
        response_format: 'b64_json'
      }
    : {
        model: env.AI_IMAGE_MODEL || provider.model,
        prompt: options.prompt,
        size,
        n: 1
      }

  let data: ImageResponse
  try {
    data = await requestJson<ImageResponse>(`${trimSlash(provider.baseUrl)}/images/generations`, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, { timeoutMs: options.timeoutMs, retries: options.retries })
  }
  catch (error) {
    throw wrapError(error, provider, 'image')
  }

  const items = data.data
  if (!Array.isArray(items) || items.length !== 1) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      message: `Expected exactly 1 image, received ${Array.isArray(items)
        ? items.length
        : 'none'}`
    })
  }
  const item = items[0]!
  if (item.error) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      // Only the code is surfaced; provider messages may echo the prompt.
      message: `Image item failed${item.error.code
        ? ` with code ${item.error.code}`
        : ''}`
    })
  }

  const value = await readImagePayload(item, provider, options.timeoutMs, options.retries)
  const format = detectImageFormat(value)
  if (!format) {
    throw new AiError({
      kind: 'output',
      provider: provider.id,
      model: provider.model,
      message: 'Image payload is neither PNG nor JPEG'
    })
  }

  return {
    value,
    provider: provider.id,
    model: String(body.model)
  }
}

/**
 * Vendors disagree on the size separator, and some accept only a fixed set.
 * Keep `WxH` in the public API and translate here.
 */
function normalizeSize(size: string, provider: ImageProvider): string {
  const [width, height] = size.toLowerCase().split('x')
  if (!width || !height || !Number.isFinite(Number(width)) || !Number.isFinite(Number(height))) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: `Invalid size: ${size}. Expected WxH, for example 1280x720`
    })
  }
  return `${width}${provider.sizeSeparator ?? 'x'}${height}`
}

/**
 * A signed image URL is fetched without the API Authorization header: the
 * signature is the credential and the host is not the model API.
 */
async function readImagePayload(item: ImageItem, provider: ImageProvider, timeoutMs?: number, retries?: number): Promise<Uint8Array> {
  if (item.b64_json) {
    return new Uint8Array(Buffer.from(item.b64_json, 'base64'))
  }
  if (item.url) {
    if (!/^https:\/\//i.test(item.url)) {
      throw new AiError({
        kind: 'output',
        provider: provider.id,
        model: provider.model,
        message: 'Image URL must be HTTPS'
      })
    }
    try {
      const response = await request(item.url, {}, { timeoutMs, retries })
      return new Uint8Array(await response.arrayBuffer())
    }
    catch (error) {
      throw wrapError(error, provider, 'image download')
    }
  }
  throw new AiError({
    kind: 'output',
    provider: provider.id,
    model: provider.model,
    message: 'Empty image response from provider'
  })
}
export type ImageFormat = 'png' | 'jpeg'

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47]
const JPEG_MAGIC = [0xFF, 0xD8, 0xFF]

export function detectImageFormat(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 4 && PNG_MAGIC.every((byte, index) => bytes[index] === byte)) {
    return 'png'
  }
  if (bytes.length >= 3 && JPEG_MAGIC.every((byte, index) => bytes[index] === byte)) {
    return 'jpeg'
  }
  return null
}
