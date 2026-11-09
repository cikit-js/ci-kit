import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { HttpError, requestJson } from '@ci-kit/http'

const API_VERSION = '2022-11-28'

export interface GitHubClientOptions {
  owner: string
  repo: string
  token: string
  apiBaseUrl?: string
}

export interface GitHubReleaseAsset {
  id: number
  name: string
  browser_download_url?: string
  content_type?: string
  size?: number
}

export interface GitHubRelease {
  id: number
  tag_name: string
  name: string
  body: string | null
  html_url: string
  upload_url: string
  draft: boolean
  prerelease: boolean
  assets: GitHubReleaseAsset[]
}

export interface GitHubReleaseInput {
  tagName: string
  name: string
  body: string
  targetCommitish?: string
  draft?: boolean
  prerelease?: boolean
  generateReleaseNotes?: boolean
  previousTagName?: string
}

export interface GitHubReleaseUpdate {
  name?: string
  body?: string
  targetCommitish?: string
  draft?: boolean
  prerelease?: boolean
}

export interface GitHubReleaseAssetInput {
  filePath: string
  name?: string
  label?: string
  contentType?: string
}

export class GitHubClient {
  private readonly apiBase: string
  private readonly headers: Record<string, string>

  constructor(private readonly options: GitHubClientOptions) {
    this.apiBase = `${(options.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '')}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`
    this.headers = {
      'accept': 'application/vnd.github+json',
      'authorization': `Bearer ${options.token}`,
      'x-github-api-version': API_VERSION
    }
  }

  async getReleaseByTag(tagName: string): Promise<GitHubRelease | null> {
    try {
      return await requestJson<GitHubRelease>(this.url(`releases/tags/${encodeURIComponent(tagName)}`), {
        headers: this.headers
      })
    }
    catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return null
      }
      throw error
    }
  }

  async createRelease(input: GitHubReleaseInput): Promise<GitHubRelease> {
    return requestJson<GitHubRelease>(this.url('releases'), {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: input.tagName,
        name: input.name,
        body: input.body,
        target_commitish: input.targetCommitish,
        draft: input.draft ?? false,
        prerelease: input.prerelease ?? false,
        generate_release_notes: input.generateReleaseNotes,
        previous_tag_name: input.previousTagName
      })
    })
  }

  async updateRelease(id: number, input: GitHubReleaseUpdate): Promise<GitHubRelease> {
    return requestJson<GitHubRelease>(this.url(`releases/${id}`), {
      method: 'PATCH',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(input.name !== undefined
          ? { name: input.name }
          : {}),
        ...(input.body !== undefined
          ? { body: input.body }
          : {}),
        ...(input.targetCommitish !== undefined
          ? { target_commitish: input.targetCommitish }
          : {}),
        ...(input.draft !== undefined
          ? { draft: input.draft }
          : {}),
        ...(input.prerelease !== undefined
          ? { prerelease: input.prerelease }
          : {})
      })
    })
  }

  async uploadReleaseAsset(release: GitHubRelease, input: GitHubReleaseAssetInput): Promise<GitHubReleaseAsset> {
    const name = input.name ?? input.filePath.split(/[\\/]/).pop()
    if (!name) {
      throw new Error(`Cannot infer release asset name from ${input.filePath}`)
    }
    const url = new URL(release.upload_url.replace(/\{[^}]+\}$/, ''))
    url.searchParams.set('name', name)
    if (input.label !== undefined) {
      url.searchParams.set('label', input.label)
    }
    const body = await readFile(input.filePath)
    return requestJson<GitHubReleaseAsset>(url.toString(), {
      method: 'POST',
      headers: {
        ...this.headers,
        'content-type': input.contentType ?? 'application/octet-stream'
      },
      body
    })
  }

  private url(path: string): string {
    return `${this.apiBase}/${path.replace(/^\//, '')}`
  }
}

export function githubClientFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubClient {
  const repository = env.GITHUB_REPOSITORY
  const token = env.GITHUB_TOKEN
  if (!repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
  }
  const slash = repository.indexOf('/')
  if (slash <= 0 || slash === repository.length - 1) {
    throw new Error('GITHUB_REPOSITORY must be in owner/repository form')
  }
  return new GitHubClient({
    owner: repository.slice(0, slash),
    repo: repository.slice(slash + 1),
    token,
    ...(env.GITHUB_API_URL
      ? { apiBaseUrl: env.GITHUB_API_URL }
      : {})
  })
}
