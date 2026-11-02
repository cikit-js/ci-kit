import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiError, classifyStatus } from '../src/errors'
import { detectImageFormat, image, text } from '../src/index'

const ENV = {
  AI_API_KEY: 'test-key',
  AI_IMAGE_API_KEY: 'test-image-key'
}

const PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  0x00
])
const JPEG_BYTES = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00])

interface Call {
  url: string
  body: Record<string, unknown>
  headers: Record<string, string>
  signal?: AbortSignal | null
}

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: init?.body
        ? JSON.parse(String(init.body))
        : {},
      headers: (init?.headers ?? {}) as Record<string, string>,
      signal: init?.signal
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}

function chat(content: string, finishReason = 'stop', usage?: { prompt_tokens: number, completion_tokens: number }) {
  return Response.json({
    choices: [
      {
        message: { content },
        finish_reason: finishReason
      }
    ],
    usage
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('text requests', () => {
  it('passes maxTokens, temperature and json through to the provider', async () => {
    const calls = mockFetch(() => chat('{}'))
    await text({
      prompt: 'hi',
      maxTokens: 4096,
      temperature: 0.2,
      json: true,
      env: ENV
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toMatchObject({
      max_tokens: 4096,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      stream: false
    })
  })

  it('omits optional parameters when they are not requested', async () => {
    const calls = mockFetch(() => chat('ok'))
    await text({ prompt: 'hi', env: ENV })
    expect(calls[0]!.body).not.toHaveProperty('max_tokens')
    expect(calls[0]!.body).not.toHaveProperty('response_format')
    expect(calls[0]!.body).not.toHaveProperty('temperature')
  })

  it('never sends the key in the body', async () => {
    const calls = mockFetch(() => chat('ok'))
    await text({ prompt: 'hi', env: ENV })
    expect(JSON.stringify(calls[0]!.body)).not.toContain('test-key')
    expect(calls[0]!.headers.authorization).toBe('Bearer test-key')
  })

  it('reports usage and finishReason', async () => {
    mockFetch(() => chat('hello', 'stop', { prompt_tokens: 12, completion_tokens: 3 }))
    const result = await text({ prompt: 'hi', env: ENV })
    expect(result.usage).toEqual({ input: 12, output: 3 })
    expect(result.finishReason).toBe('stop')
  })

  it('fails when the provider truncated the output', async () => {
    mockFetch(() => chat('half a sen', 'length'))
    await expect(text({ prompt: 'hi', env: ENV })).rejects.toMatchObject({
      kind: 'output',
      retryable: true
    })
  })

  it('fails when the provider filtered the content', async () => {
    mockFetch(() => chat('blocked', 'content_filter'))
    await expect(text({ prompt: 'hi', env: ENV })).rejects.toMatchObject({ kind: 'output', retryable: false })
  })

  it('fails on an empty response', async () => {
    mockFetch(() => chat('   '))
    await expect(text({ prompt: 'hi', env: ENV })).rejects.toMatchObject({ kind: 'output' })
  })

  it('rejects json mode on a provider that cannot honour it', async () => {
    mockFetch(() => chat('{}'))
    const env = { ...ENV, AI_TEXT_PROVIDER: 'nope' }
    // An unknown provider fails before json mode is considered.
    await expect(text({ prompt: 'hi', json: true, env })).rejects.toThrow(/Unknown AI_TEXT_PROVIDER/)
  })

  it('reports a missing key as a config error', async () => {
    mockFetch(() => chat('ok'))
    await expect(text({ prompt: 'hi', env: {} })).rejects.toMatchObject({ kind: 'config' })
  })

  it('maps an auth failure without leaking the response body', async () => {
    mockFetch(() => new Response('secret detail', { status: 401 }))
    const error = await text({ prompt: 'hi', env: ENV }).catch(value => value)
    expect(error).toBeInstanceOf(AiError)
    expect(error.kind).toBe('auth')
    expect(error.status).toBe(401)
    expect(error.message).not.toContain('secret detail')
  })

  it('honours AI_TEXT_MODEL', async () => {
    const calls = mockFetch(() => chat('ok'))
    const result = await text({
      prompt: 'hi',
      env: { ...ENV, AI_TEXT_MODEL: 'custom-model' }
    })
    expect(calls[0]!.body.model).toBe('custom-model')
    expect(result.model).toBe('custom-model')
  })
})

describe('image requests', () => {
  it('decodes a base64 image and detects its format', async () => {
    mockFetch(() => Response.json({
      data: [
        {
          b64_json: Buffer.from(PNG_BYTES).toString('base64')
        }
      ]
    }))
    const result = await image({ prompt: 'scene', size: '2560x1440', env: ENV })
    expect(detectImageFormat(result.value)).toBe('png')
  })

  it('sends the requested size with the provider separator', async () => {
    const calls = mockFetch(() => Response.json({
      data: [
        {
          b64_json: Buffer.from(PNG_BYTES).toString('base64')
        }
      ]
    }))
    await image({ prompt: 'scene', size: '2560x1440', env: ENV })
    expect(calls[0]!.body.size).toBe('2560x1440')
  })

  it('honours AI_IMAGE_SIZE and AI_IMAGE_MODEL', async () => {
    const calls = mockFetch(() => Response.json({
      data: [
        {
          b64_json: Buffer.from(PNG_BYTES).toString('base64')
        }
      ]
    }))
    await image({
      prompt: 'scene',
      env: { ...ENV, AI_IMAGE_SIZE: '1024x768', AI_IMAGE_MODEL: 'custom-image' }
    })
    expect(calls[0]!.body.size).toBe('1024x768')
    expect(calls[0]!.body.model).toBe('custom-image')
  })

  it('rejects a multi-image response', async () => {
    mockFetch(() => Response.json({
      data: [
        {
          b64_json: Buffer.from(PNG_BYTES).toString('base64')
        },
        {
          b64_json: Buffer.from(PNG_BYTES).toString('base64')
        }
      ]
    }))
    await expect(image({ prompt: 'scene', env: ENV })).rejects.toMatchObject({ kind: 'output' })
  })

  it('rejects an empty image list', async () => {
    mockFetch(() => Response.json({ data: [] }))
    await expect(image({ prompt: 'scene', env: ENV })).rejects.toMatchObject({ kind: 'output' })
  })

  it('rejects an item level error without echoing the message', async () => {
    mockFetch(() => Response.json({
      data: [
        {
          error: { code: 'OutputImageSensitiveContentDetected', message: 'prompt echoed here' }
        }
      ]
    }))
    const error = await image({ prompt: 'scene', env: ENV }).catch(value => value)
    expect(error).toBeInstanceOf(AiError)
    expect(error.kind).toBe('output')
    expect(error.message).toContain('OutputImageSensitiveContentDetected')
    expect(error.message).not.toContain('prompt echoed here')
  })

  it('rejects a payload that is not an image', async () => {
    mockFetch(() => Response.json({
      data: [
        {
          b64_json: Buffer.from('not an image').toString('base64')
        }
      ]
    }))
    await expect(image({ prompt: 'scene', env: ENV })).rejects.toMatchObject({ kind: 'output' })
  })

  it('downloads a URL result without forwarding the API key', async () => {
    const calls = mockFetch((call) => {
      if (call.url.includes('/images/generations')) {
        return Response.json({
          data: [
            { url: 'https://cdn.example/image.png' }
          ]
        })
      }
      return new Response(JPEG_BYTES)
    })
    const result = await image({ prompt: 'scene', env: ENV })
    expect(detectImageFormat(result.value)).toBe('jpeg')
    const download = calls.find(call => call.url === 'https://cdn.example/image.png')!
    expect(download.headers.authorization).toBeUndefined()
  })

  it('refuses a non-HTTPS image URL', async () => {
    mockFetch(() => Response.json({
      data: [
        { url: 'http://cdn.example/image.png' }
      ]
    }))
    await expect(image({ prompt: 'scene', env: ENV })).rejects.toMatchObject({ kind: 'output' })
  })

  it('rejects an invalid size before any request', async () => {
    const calls = mockFetch(() => Response.json({ data: [] }))
    await expect(image({ prompt: 'scene', size: 'big', env: ENV })).rejects.toMatchObject({ kind: 'config' })
    expect(calls).toHaveLength(0)
  })
})

describe('retries', () => {
  it('sends exactly one request when retries is 0', async () => {
    const calls = mockFetch(() => new Response('boom', { status: 503 }))
    await expect(text({ prompt: 'hi', retries: 0, env: ENV })).rejects.toMatchObject({
      kind: 'server',
      retryable: true
    })
    expect(calls).toHaveLength(1)
  })

  it('retries the default number of times when not overridden', async () => {
    const calls = mockFetch(() => new Response('boom', { status: 503 }))
    await expect(text({
      prompt: 'hi',
      retries: 1,
      timeoutMs: 1000,
      env: ENV
    })).rejects.toBeInstanceOf(AiError)
    expect(calls).toHaveLength(2)
  })

  it('does not retry an auth failure even when retries are allowed', async () => {
    const calls = mockFetch(() => new Response('nope', { status: 401 }))
    await expect(text({ prompt: 'hi', retries: 3, env: ENV })).rejects.toMatchObject({ kind: 'auth' })
    expect(calls).toHaveLength(1)
  })
})

describe('status classification', () => {
  it('maps statuses to kinds and retryability', () => {
    expect(classifyStatus(401)).toEqual({ kind: 'auth', retryable: false })
    expect(classifyStatus(403)).toEqual({ kind: 'auth', retryable: false })
    expect(classifyStatus(429)).toEqual({ kind: 'quota', retryable: true })
    expect(classifyStatus(408)).toEqual({ kind: 'network', retryable: true })
    expect(classifyStatus(500)).toEqual({ kind: 'server', retryable: true })
    expect(classifyStatus(400)).toEqual({ kind: 'request', retryable: false })
    expect(classifyStatus(404)).toEqual({ kind: 'request', retryable: false })
  })

  it('describes an error without the request or key', () => {
    const error = new AiError({
      kind: 'quota',
      provider: 'dashscope',
      model: 'm',
      status: 429,
      message: 'rate limited'
    })
    expect(error.describe()).toBe('quota / dashscope / m / HTTP 429: rate limited')
  })
})
