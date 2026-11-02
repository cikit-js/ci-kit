import { execFileSync } from 'node:child_process'

import process from 'node:process'

export interface Commit {
  hash: string
  subject: string
  body: string
}

export interface ChangelogSection {
  type: string
  title: string
  items: string[]
}

export interface ChangelogOptions {
  cwd?: string
  from?: string
  to?: string
  maxPerSection?: number
  keep?: Array<{ type: string, title: string }>
  drop?: string[]
}

const HEADER = '## 更新内容'
const EMPTY_NOTICE = '本次版本主要为内部维护与稳定性调整，没有面向用户的功能变更。'
const FIRST_RELEASE_NOTICE = '首个版本。'

export const DEFAULT_KEEP = [
  { type: 'feat', title: '新功能' },
  { type: 'fix', title: '修复' },
  { type: 'perf', title: '性能' },
  { type: 'refactor', title: '重构' }
]

export const DEFAULT_DROP = ['ci', 'docs', 'chore', 'test', 'build', 'style']

export function collectCommits(options: ChangelogOptions = {}): Commit[] {
  const { cwd = process.cwd(), from, to } = options
  const range = from ? `${from}..${to ?? 'HEAD'}` : (to ?? 'HEAD')
  const output = execFileSync(
    'git',
    ['log', range, '--no-merges', '--pretty=format:%H%x1f%s%x1f%b%x1e'],
    { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  return output
    .split('\x1E')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = '', subject = '', body = ''] = chunk.split('\x1F')
      return { hash, subject: subject.trim(), body: body.trim() }
    })
}

interface ParsedSubject {
  type: string
  description: string
  breaking: boolean
  references: string
}

const PREFIX_RE = /^(feat|fix|perf|refactor|ci|docs|chore|test|build|style)(?:\([^)]+\))?(!)?:\s+/

export function parseSubject(subject: string): ParsedSubject | null {
  const match = subject.match(PREFIX_RE)
  if (!match) {
    return null
  }
  const [, type, breaking] = match
  const description = subject.slice(match[0].length).trim()
  const references = description.match(/#\d+/g)?.join(' ') ?? ''
  return {
    type: type!,
    description: description.trim(),
    breaking: breaking === '!',
    references
  }
}

export function renderChangelog(commits: Commit[], options: ChangelogOptions = {}): string {
  const {
    keep = DEFAULT_KEEP,
    drop = DEFAULT_DROP,
    maxPerSection = 10
  } = options

  if (commits.length === 0) {
    return `${HEADER}\n\n${FIRST_RELEASE_NOTICE}`
  }

  const sections = new Map<string, string[]>()
  for (const commit of commits) {
    const parsed = parseSubject(commit.subject)
    if (!parsed || drop.includes(parsed.type)) {
      continue
    }
    if (!keep.some(entry => entry.type === parsed.type)) {
      continue
    }
    const items = sections.get(parsed.type) ?? []
    items.push(parsed.breaking ? `${parsed.description}（不兼容）` : parsed.description)
    sections.set(parsed.type, items)
  }

  const lines: string[] = [HEADER, '']
  let rendered = false
  for (const { type, title } of keep) {
    const items = sections.get(type)
    if (!items || items.length === 0) {
      continue
    }
    rendered = true
    lines.push(`### ${title}`, '')
    for (const item of items.slice(0, maxPerSection)) {
      lines.push(`- ${item}`)
    }
    if (items.length > maxPerSection) {
      lines.push(`- 以及另外 ${items.length - maxPerSection} 条`)
    }
    lines.push('')
  }

  if (!rendered) {
    lines.push(EMPTY_NOTICE, '')
  }
  return lines.join('\n').trimEnd()
}

export function isBetaTag(tag: string): boolean {
  return /\d+\.\d+\.\d+-beta\.\d+$/.test(tag)
}

export function previousTagMatcher(channel: 'beta' | 'production'): string {
  return channel === 'beta' ? 'v*-beta.*' : 'v[0-9]*'
}
