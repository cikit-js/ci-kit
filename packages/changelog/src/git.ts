import type { ChangelogOptions, Commit, PreviousTagOptions, ReleaseCommit, ReleaseFileChange, ReleaseHistory, ReleaseHistoryOptions } from './types'
import { execFileSync } from 'node:child_process'
import process from 'node:process'

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
