import type { TextProvider } from '../types'
import { dashscopeText } from './dashscope'
import { minimaxText } from './minimax'
import { openaiText } from './openai'

export const textProviders: Record<string, TextProvider> = {
  [dashscopeText.id]: dashscopeText,
  [minimaxText.id]: minimaxText,
  [openaiText.id]: openaiText
}

export const defaultTextProvider = dashscopeText.id
