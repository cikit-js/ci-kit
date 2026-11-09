import { execFileSync } from 'node:child_process'

import process from 'node:process'

export interface Commit {
  hash: string
  subject: string
  body: string
}

export interface ReleaseFileChange {
  status: string
  path: string
  previousPath?: string
}

export interface ReleaseCommit extends Commit {
  author: string
  email: string
  date: string
  parents: string[]
  merge: boolean
  files: ReleaseFileChange[]
}

export interface ReleaseHistoryOptions {
  cwd?: string
  from?: string
  to?: string
  includeMerges?: boolean
}

export interface PreviousTagOptions {
  cwd?: string
  to?: string
  pattern?: string
}

export interface ReleaseHistory {
  from?: string
  to: string
  commits: ReleaseCommit[]
  files: ReleaseFileChange[]
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

export const DEFAULT_DROP = [
  'ci',
  'docs',
  'chore',
  'test',
  'build',
  'style'
]

export function collectCommits(options: ChangelogOptions = {}): Commit[] {
  const { cwd = process.cwd(), from, to } = options
  const range = from
    ? `${from}..${to ?? 'HEAD'}`
    : (to ?? 'HEAD')
  const output = execFileSync(
    'git',
    [
      'log',
      range,
      '--no-merges',
      '--pretty=format:%H%x1f%s%x1f%b%x1e'
    ],
    { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  )
  return output
    .split('\x1E')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = '', subject = '', body = ''] = chunk.split('\x1F')
      return {
        hash,
        subject: subject.trim(),
        body: body.trim()
      }
    })
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
}

function tagMatches(tag: string, pattern: string): boolean {
  const source = `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`
  return new RegExp(source).test(tag)
}

/** Find the newest reachable tag matching a release pattern before `to`. */
export function resolvePreviousTag(options: PreviousTagOptions = {}): string | null {
  const { cwd = process.cwd(), to = 'HEAD', pattern = 'v*' } = options
  const tags = git(cwd, [
    'tag',
    '--merged',
    to,
    '--sort=-creatordate'
  ])
    .split(/\r?\n/)
    .map(tag => tag.trim())
    .filter(Boolean)
  return tags.find(tag => tag !== to && tagMatches(tag, pattern)) ?? null
}

function parseReleaseLog(output: string): Array<Omit<ReleaseCommit, 'files'>> {
  return output
    .replaceAll('\x1E\0', '\x1E')
    .split('\x1E')
    .map(chunk => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [hash = '', author = '', email = '', date = '', parentText = '', subject = '', body = ''] = chunk.split('\x1F')
      const parents = parentText.trim()
        ? parentText.trim().split(/\s+/)
        : []
      return {
        hash: hash.trim(),
        subject: subject.trim(),
        body: body.trim(),
        author: author.trim(),
        email: email.trim(),
        date: date.trim(),
        parents,
        merge: parents.length > 1
      }
    })
}

function commitFiles(cwd: string, hash: string): ReleaseFileChange[] {
  const output = git(cwd, [
    'diff-tree',
    '--root',
    '--no-commit-id',
    '-m',
    '-r',
    '--name-status',
    '--find-renames',
    '-z',
    hash
  ])
  const tokens = output.split('\0').filter(Boolean)
  const files: ReleaseFileChange[] = []
  const seen = new Set<string>()
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? ''
    const rename = /^[RC]\d*$/.test(status)
    const previousPath = rename
      ? tokens[index++]
      : undefined
    const path = tokens[index++]
    if (!path) {
      continue
    }
    const key = `${status}\0${previousPath ?? ''}\0${path}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    files.push({
      status: status.slice(0, 1),
      path,
      ...(previousPath
        ? { previousPath }
        : {})
    })
  }
  return files
}

/** Collect every commit and its changed paths for a release range. */
export function collectReleaseCommits(options: ReleaseHistoryOptions = {}): ReleaseCommit[] {
  const { cwd = process.cwd(), from, to = 'HEAD', includeMerges = true } = options
  const range = from
    ? `${from}..${to}`
    : to
  const args = [
    'log',
    '-z',
    ...(includeMerges
      ? []
      : ['--no-merges']),
    range,
    '--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%s%x1f%b%x1e'
  ]
  return parseReleaseLog(git(cwd, args)).map(commit => ({
    ...commit,
    files: commitFiles(cwd, commit.hash)
  }))
}

/** Collect release material without dropping merge commits or file paths. */
export function collectReleaseHistory(options: ReleaseHistoryOptions = {}): ReleaseHistory {
  const to = options.to ?? 'HEAD'
  const commits = collectReleaseCommits(options)
  const files: ReleaseFileChange[] = []
  const seen = new Set<string>()
  for (const commit of commits) {
    for (const file of commit.files) {
      const key = `${file.status}\0${file.previousPath ?? ''}\0${file.path}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      files.push(file)
    }
  }
  return {
    ...(options.from
      ? { from: options.from }
      : {}),
    to,
    commits,
    files
  }
}

/** Render the complete commit and file material for a roundtable context. */
export function renderReleaseContext(history: ReleaseHistory): string {
  const lines = [
    '## 版本范围',
    '',
    `${history.from ?? '仓库初始提交'} → ${history.to}`,
    '',
    `共 ${history.commits.length} 个 commit，${history.files.length} 个不同文件变更。`,
    '',
    '## Commit 列表',
    ''
  ]
  for (const commit of history.commits) {
    lines.push(`### ${commit.hash.slice(0, 12)} · ${commit.subject}`)
    lines.push('')
    lines.push(`作者：${commit.author} · 时间：${commit.date}`)
    if (commit.body) {
      lines.push('', commit.body)
    }
    lines.push('', '文件：')
    if (!commit.files.length) {
      lines.push('- 无法从该 commit 读取文件列表')
    }
    else {
      for (const file of commit.files) {
        lines.push(`- ${file.status} ${file.previousPath
          ? `${file.previousPath} → `
          : ''}${file.path}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
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
    items.push(parsed.breaking
      ? `${parsed.description}（不兼容）`
      : parsed.description)
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
  return channel === 'beta'
    ? 'v*-beta.*'
    : 'v[0-9]*'
}
