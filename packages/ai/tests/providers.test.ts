import { describe, expect, it } from 'vitest'
import { imageProviders, resolveImageProvider, resolveTextProvider, textProviders } from '../src/providers'
import { createOpenAiCompatibleText } from '../src/providers/text/openai'

describe('text providers', () => {
  it('defaults to dashscope', () => {
    expect(resolveTextProvider({}).id).toBe('dashscope')
  })

  it('honours AI_TEXT_PROVIDER', () => {
    expect(resolveTextProvider({ AI_TEXT_PROVIDER: 'openai' }).id).toBe('openai')
  })

  it('rejects unknown ids with the available list', () => {
    expect(() => resolveTextProvider({ AI_TEXT_PROVIDER: 'nope' })).toThrow(/Available: .*dashscope/)
  })

  it('keeps the key out of the registry value', () => {
    for (const provider of Object.values(textProviders)) {
      expect(provider.apiKeyEnv).toMatch(/^AI_/)
      expect(JSON.stringify(provider)).not.toMatch(/sk-/)
    }
  })

  it('builds a custom openai compatible provider', () => {
    const provider = createOpenAiCompatibleText({
      id: 'self-hosted',
      label: 'Self hosted',
      baseUrl: 'https://example.test/v1',
      model: 'local-model'
    })
    expect(provider).toMatchObject({ protocol: 'openai', apiKeyEnv: 'AI_API_KEY' })
  })
})

describe('image providers', () => {
  it('defaults to seedream', () => {
    expect(resolveImageProvider({}).id).toBe('seedream')
  })

  it('honours AI_IMAGE_PROVIDER', () => {
    expect(resolveImageProvider({ AI_IMAGE_PROVIDER: 'dashscope-image' }).protocol).toBe('dashscope')
  })

  it('records the size separator per provider', () => {
    expect(imageProviders.seedream?.sizeSeparator).toBeUndefined()
    expect(imageProviders['dashscope-image']?.sizeSeparator).toBe('*')
  })

  it('rejects unknown ids', () => {
    expect(() => resolveImageProvider({ AI_IMAGE_PROVIDER: 'nope' })).toThrow(/Unknown AI_IMAGE_PROVIDER/)
  })
})
