import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubClient, githubClientFromEnv } from '../src/index'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body instanceof Uint8Array
        ? init.body
        : init?.body
          ? JSON.parse(String(init.body))
          : undefined
    }
    calls.push(call)
    return handler(call)
  })
  return calls
}

const release = {
  id: 4,
  tag_name: 'v1.0.0',
  name: 'v1.0.0',
  body: 'notes',
  html_url: 'https://github.com/acme/demo/releases/tag/v1.0.0',
  upload_url: 'https://uploads.github.com/repos/acme/demo/releases/4/assets{?name,label}',
  draft: false,
  prerelease: false,
  assets: []
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('gitHubClient', () => {
  it('gets a release by tag and treats 404 as missing', async () => {
    const calls = mockFetch(() => Response.json(release))
    const client = new GitHubClient({ owner: 'acme', repo: 'demo', token: 'secret' })
    await expect(client.getReleaseByTag('v1.0.0')).resolves.toMatchObject({ id: 4 })
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'https://api.github.com/repos/acme/demo/releases/tags/v1.0.0'
    })
    expect(calls[0]!.headers.authorization).toBe('Bearer secret')

    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }))
    await expect(client.getReleaseByTag('v0.0.0')).resolves.toBeNull()
  })

  it('creates and updates releases with GitHub field names', async () => {
    const calls = mockFetch(() => Response.json(release))
    const client = new GitHubClient({ owner: 'acme', repo: 'demo', token: 'secret' })
    await client.createRelease({
      tagName: 'v1.0.0',
      name: 'v1.0.0',
      body: 'notes',
      generateReleaseNotes: true,
      previousTagName: 'v0.9.0'
    })
    await client.updateRelease(4, { body: 'updated', prerelease: true })
    expect(calls[0]!.body).toMatchObject({
      tag_name: 'v1.0.0',
      generate_release_notes: true,
      previous_tag_name: 'v0.9.0'
    })
    expect(calls[1]!.method).toBe('PATCH')
    expect(calls[1]!.body).toEqual({ body: 'updated', prerelease: true })
  })

  it('uploads a release asset to the upload URL', async () => {
    const calls = mockFetch(call => call.method === 'POST' && call.url.includes('/assets?')
      ? Response.json({ id: 8, name: 'record.json' })
      : Response.json(release))
    const client = new GitHubClient({ owner: 'acme', repo: 'demo', token: 'secret' })
    await client.uploadReleaseAsset(release, {
      filePath: 'packages/github/tests/index.test.ts',
      name: 'record.json',
      contentType: 'application/json'
    })
    expect(calls[0]!.url).toBe('https://uploads.github.com/repos/acme/demo/releases/4/assets?name=record.json')
    expect(calls[0]!.headers['content-type']).toBe('application/json')
    expect(calls[0]!.body).toBeInstanceOf(Uint8Array)
  })
})

describe('clientFromEnv', () => {
  it('reads repository and token from GitHub Actions variables', () => {
    const client = githubClientFromEnv({
      GITHUB_REPOSITORY: 'acme/demo',
      GITHUB_TOKEN: 'secret',
      GITHUB_API_URL: 'https://github.example/api/v3'
    })
    expect(client).toBeInstanceOf(GitHubClient)
  })

  it('rejects a malformed repository variable', () => {
    expect(() => githubClientFromEnv({ GITHUB_REPOSITORY: 'demo', GITHUB_TOKEN: 'secret' })).toThrow(/owner\/repository/)
  })
})
