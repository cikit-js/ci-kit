import { readFileSync } from 'node:fs'

import process from 'node:process'
import { request, requestJson } from '@ci-kit/http'

export interface GitlabClientOptions {
  baseUrl: string
  projectId: string | number
  token: string
  tokenType?: 'job' | 'private'
}

export interface ReleaseAsset {
  name: string
  url: string
  link_type?: 'other' | 'package' | 'image'
}

export interface ReleaseInput {
  tagName: string
  name: string
  description: string
  assets?: ReleaseAsset[]
  ref?: string
}

export interface PackageUpload {
  packageName: string
  version: string
  filePath: string
  fileName?: string
}

export interface ScheduleInput {
  description: string
  ref: string
  cron: string
  cronTimezone?: string
}

export class GitlabClient {
  private readonly apiBase: string
  private readonly headers: Record<string, string>

  constructor(private readonly options: GitlabClientOptions) {
    this.apiBase = `${options.baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(String(options.projectId))}`
    this.headers = options.tokenType === 'private'
      ? { 'PRIVATE-TOKEN': options.token }
      : { 'JOB-TOKEN': options.token }
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    return requestJson<T>(this.url(path, query), { headers: this.headers })
  }

  async paginate<T>(path: string, query: Record<string, string | number> = {}): Promise<T[]> {
    const rows: T[] = []
    let page = 1
    while (true) {
      const url = this.url(path, { ...query, per_page: 100, page })
      const response = await request(url, { headers: this.headers })
      rows.push(...(await response.json()) as T[])
      const next = response.headers.get('x-next-page')
      if (!next) {
        break
      }
      page = Number(next)
    }
    return rows
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(this.url(path), {
      method: 'POST',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return requestJson<T>(this.url(path), {
      method: 'PUT',
      headers: { ...this.headers, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  async delete(path: string): Promise<void> {
    await request(this.url(path), { method: 'DELETE', headers: this.headers })
  }

  async getRelease(tagName: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.get<Record<string, unknown>>(`releases/${encodeURIComponent(tagName)}`)
    }
    catch (error) {
      if (error instanceof Error && error.name === 'HttpError') {
        return null
      }
      throw error
    }
  }

  async createRelease(input: ReleaseInput): Promise<void> {
    await this.post('releases', {
      tag_name: input.tagName,
      ref: input.ref,
      name: input.name,
      description: input.description,
      assets: input.assets
        ? { links: input.assets }
        : undefined
    })
  }

  async uploadPackage({ packageName, version, filePath, fileName }: PackageUpload): Promise<void> {
    const name = fileName ?? filePath.split(/[\\/]/).pop()!
    const body = readFileSync(filePath)
    await request(this.url(`packages/generic/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}/${encodeURIComponent(name)}`), {
      method: 'PUT',
      headers: { ...this.headers, 'content-type': 'application/octet-stream' },
      body
    })
  }

  async listPackages(packageName?: string): Promise<Array<{ id: number, name: string, version: string }>> {
    const query: Record<string, string> = packageName
      ? { package_name: packageName }
      : {}
    return this.paginate<{ id: number, name: string, version: string }>('packages', query)
  }

  async deletePackage(id: number): Promise<void> {
    await this.delete(`packages/${id}`)
  }

  async upsertSchedule(input: ScheduleInput): Promise<{ id: number, action: 'created' | 'updated' | 'unchanged' }> {
    const existing = await this.paginate<{ id: number, description: string, ref: string, cron: string }>('pipeline_schedules')
    const match = existing.find(item => item.description === input.description)
    const body = {
      description: input.description,
      ref: input.ref,
      cron: input.cron,
      cron_timezone: input.cronTimezone ?? 'Asia/Shanghai'
    }
    if (!match) {
      const created = await this.post<{ id: number }>('pipeline_schedules', body)
      return { id: created.id, action: 'created' }
    }
    if (match.cron === input.cron && match.ref === input.ref) {
      return { id: match.id, action: 'unchanged' }
    }
    await this.put(`pipeline_schedules/${match.id}`, body)
    return { id: match.id, action: 'updated' }
  }

  private url(path: string, query: Record<string, string | number> = {}): string {
    const url = new URL(`${this.apiBase}/${path.replace(/^\//, '')}`)
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, String(value))
    }
    return url.toString()
  }
}

export function clientFromEnv(env: NodeJS.ProcessEnv = process.env): GitlabClient {
  const baseUrl = env.CI_SERVER_URL
  const projectId = env.CI_PROJECT_ID
  const token = env.CI_JOB_TOKEN
  if (!baseUrl || !projectId || !token) {
    throw new Error('CI_SERVER_URL, CI_PROJECT_ID and CI_JOB_TOKEN are required')
  }
  return new GitlabClient({ baseUrl, projectId, token })
}
