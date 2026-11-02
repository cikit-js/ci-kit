import type { ImageProvider } from '../types'
import { dashscopeImage } from './dashscope'
import { seedreamImage } from './seedream'

export const imageProviders: Record<string, ImageProvider> = {
  [seedreamImage.id]: seedreamImage,
  [dashscopeImage.id]: dashscopeImage
}

export const defaultImageProvider = seedreamImage.id
