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
