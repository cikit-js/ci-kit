import type { TextProvider } from '../types'
import { dashscopeText } from './dashscope'
import { openaiText } from './openai'

export const textProviders: Record<string, TextProvider> = {
  [dashscopeText.id]: dashscopeText,
  [openaiText.id]: openaiText
}

export const defaultTextProvider = dashscopeText.id
