export type ReleaseChannel = 'beta' | 'production'

export interface ParsedTag {
  raw: string
  channel: ReleaseChannel
  version: string
  beta?: number
}

const TAG_RE = /^v(\d+\.\d+\.\d+)(?:-beta\.(\d+))?$/

export function parseTag(tag: string): ParsedTag | null {
  const match = tag.match(TAG_RE)
  if (!match) {
    return null
  }
  const [, version, beta] = match
  return beta
    ? { raw: tag, channel: 'beta', version: version!, beta: Number(beta) }
    : { raw: tag, channel: 'production', version: version! }
}

export function formatBetaTag(version: string, beta: number): string {
  return `v${version}-beta.${beta}`
}

export function formatProductionTag(version: string): string {
  return `v${version}`
}

export function nextBetaTag(existingTags: string[], version: string): string {
  const used = existingTags
    .map(parseTag)
    .filter((tag): tag is ParsedTag => tag !== null && tag.channel === 'beta' && tag.version === version)
    .map(tag => tag.beta ?? 0)
  const next = used.length === 0 ? 1 : Math.max(...used) + 1
  return formatBetaTag(version, next)
}

export type BumpKind = 'patch' | 'minor' | 'major'

export function bumpVersion(version: string, kind: BumpKind): string {
  const parts = version.split('.').map(Number)
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid version: ${version}`)
  }
  const [major = 0, minor = 0, patch = 0] = parts
  switch (kind) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    default:
      return `${major}.${minor}.${patch + 1}`
  }
}

/**
 * Build numbers follow `yyyymmddNN`, matching the existing app convention.
 */
export function buildNumber(date = new Date(), sequence = 1): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}${month}${day}${`${sequence}`.padStart(2, '0')}`
}

export function nextBuildNumber(current: string, date = new Date()): string {
  const today = buildNumber(date, 1).slice(0, 8)
  if (current.startsWith(today)) {
    const sequence = Number(current.slice(8)) + 1
    return `${today}${`${sequence}`.padStart(2, '0')}`
  }
  return `${today}01`
}

export function parsePubspecVersion(versionLine: string): { version: string, build: string } {
  const raw = versionLine.replace(/^version:\s*/, '').trim()
  const [version, build = ''] = raw.split('+')
  return { version: version!, build }
}
