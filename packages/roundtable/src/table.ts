import type { Document } from './frontmatter'

/** What the meeting does after a veto. */
export type OnVeto = 're-propose' | 'revise' | 'abort'

/**
 * How this meeting is held: how long, how much input, how it is judged.
 *
 * It never says what to discuss — the topic arrives at run time, because the
 * table is written before anyone knows what today's meeting is about.
 */
export interface Table {
  /** Meeting name; falls back to the config directory name. */
  title: string
  /** How long the whole discussion runs. */
  durationMs: number
  /** Upper bound for the shared pool, in tokens; the oldest statements go first. */
  maxPoolTokens: number
  /** Weighted pass ratio in 0–1 that counts as approved. */
  threshold: number
  /** Action taken when the discussion ends in a veto. */
  onVeto: OnVeto
  /** How many attempts the meeting may take in total. */
  maxAttempts: number
}

export class TableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableError'
  }
}

/** Contract defaults; the docs table is the single source of these numbers. */
export const TABLE_DEFAULTS = {
  durationMs: 180_000,
  maxPoolTokens: 3000,
  threshold: 0.5,
  onVeto: 're-propose',
  maxAttempts: 3
} as const

const ON_VETO: readonly OnVeto[] = ['re-propose', 'revise', 'abort']

const TABLE_KEYS = new Set([
  'title',
  'durationMs',
  'maxPoolTokens',
  'threshold',
  'onVeto',
  'maxAttempts'
])

function has(data: Record<string, unknown>, key: string): boolean {
  return data[key] !== undefined && data[key] !== null
}

function asTitle(value: unknown, fallback: string): string {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'string') {
    throw new TableError('table: title must be a string')
  }
  const trimmed = value.trim()
  return trimmed === ''
    ? fallback
    : trimmed
}

/** Positive integers only; no strings, no decimals, no zero. */
function asPositiveInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TableError(`table: ${field} must be a positive integer`)
  }
  return value
}

function asThreshold(value: unknown): number {
  if (value === undefined || value === null) {
    return TABLE_DEFAULTS.threshold
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TableError('table: threshold must be a number')
  }
  if (value < 0 || value > 1) {
    throw new TableError('table: threshold must be between 0 and 1')
  }
  return value
}

function asOnVeto(value: unknown): OnVeto {
  if (value === undefined || value === null) {
    return TABLE_DEFAULTS.onVeto
  }
  if (typeof value !== 'string' || !ON_VETO.includes(value as OnVeto)) {
    throw new TableError('table: onVeto must be re-propose, revise or abort')
  }
  return value as OnVeto
}

/**
 * Read `table.md` frontmatter into a Table.
 *
 * Unknown fields are errors, not ignored: a leftover `phase` or `mode` would
 * otherwise look configured while changing nothing. The body is documentation
 * for humans and takes no part in the run.
 */
export function parseTable(document: Document, fallbackTitle: string): Table {
  const data = document.data
  const unknown = Object.keys(data).filter(key => !TABLE_KEYS.has(key))
  if (unknown.length) {
    throw new TableError(`table: unknown field(s): ${unknown.join(', ')}`)
  }

  return {
    title: has(data, 'title')
      ? asTitle(data.title, fallbackTitle)
      : fallbackTitle,
    durationMs: asPositiveInteger(data.durationMs, 'durationMs', TABLE_DEFAULTS.durationMs),
    maxPoolTokens: asPositiveInteger(data.maxPoolTokens, 'maxPoolTokens', TABLE_DEFAULTS.maxPoolTokens),
    threshold: asThreshold(data.threshold),
    onVeto: asOnVeto(data.onVeto),
    maxAttempts: asPositiveInteger(data.maxAttempts, 'maxAttempts', TABLE_DEFAULTS.maxAttempts)
  }
}
