import type { ImageProvider, TextProvider } from './types'
import process from 'node:process'
import { defaultImageProvider, imageProviders } from './image'
import { defaultTextProvider, textProviders } from './text'

export * from './image'
export * from './text'
export type * from './types'

export function resolveTextProvider(env: NodeJS.ProcessEnv = process.env): TextProvider {
  const id = env.AI_TEXT_PROVIDER || defaultTextProvider
  const provider = textProviders[id]
  if (!provider) {
    throw new Error(`Unknown AI_TEXT_PROVIDER: ${id}. Available: ${Object.keys(textProviders).join(', ')}`)
  }
  return provider
}

export function resolveImageProvider(env: NodeJS.ProcessEnv = process.env): ImageProvider {
  const id = env.AI_IMAGE_PROVIDER || defaultImageProvider
  const provider = imageProviders[id]
  if (!provider) {
    throw new Error(`Unknown AI_IMAGE_PROVIDER: ${id}. Available: ${Object.keys(imageProviders).join(', ')}`)
  }
  return provider
}
