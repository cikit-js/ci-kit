import type { ReasoningEffort } from '@ci-kit/ai'
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
  /**
   * How hard thinking models should think before each turn.
   *
   * Omitted keeps the provider default. A discussion turn is one short line, so
   * a project can lower this to stop reasoning from eating the seat's
   * `maxTokens` and leaving an empty reply.
   */
  reasoningEffort?: ReasoningEffort
  /** Action taken when the discussion ends in a veto. */
  onVeto: OnVeto
  /** How many attempts the meeting may take in total. */
  maxAttempts: number
  /**
   * The structured result this meeting must hand back, keyed by field name.
   *
   * Each value is that field's constraint, shown to the seats as the schema
   * description. The library only knows a project declared fields and what it
   * said about each — not that `title` means a headline or `decision` a verdict.
   * Absent means the meeting only talks and votes.
   */
  outputFields?: Record<string, string>
  /**
   * The meeting's own rules, as written in the `table.md` body.
   *
   * Injected into every seat's system prompt. This is where a project says who
   * sums up, how long anyone may speak, or what the meeting is for — the library
   * reads none of it.
   */
  body?: string
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

const REASONING_EFFORT: readonly ReasoningEffort[] = ['none', 'low', 'medium', 'high', 'max']

const TABLE_KEYS = new Set([
  'title',
  'durationMs',
  'maxPoolTokens',
  'threshold',
  'reasoningEffort',
  'onVeto',
  'maxAttempts',
  'output'
])

const OUTPUT_KEYS = new Set(['fields'])

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

function asReasoningEffort(value: unknown): ReasoningEffort | undefined {
  if (value === undefined || value === null) {
    // No default: the provider decides how hard its own model thinks.
    return undefined
  }
  if (typeof value !== 'string' || !REASONING_EFFORT.includes(value as ReasoningEffort)) {
    throw new TableError(`table: reasoningEffort must be ${REASONING_EFFORT.join(', ')}`)
  }
  return value as ReasoningEffort
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
 * Read `output.fields` — the structured result this meeting must hand back.
 *
 * A mapping, not a list: keys are naturally unordered, and YAML already rejects
 * a duplicate key, so there is nothing here to de-duplicate. The value is the
 * field's constraint, handed straight to the seat as its schema description.
 */
function asOutputFields(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TableError('table: output must be a mapping')
  }
  const output = value as Record<string, unknown>
  const unknown = Object.keys(output).filter(key => !OUTPUT_KEYS.has(key))
  if (unknown.length) {
    throw new TableError(`table: unknown field(s) in output: ${unknown.join(', ')}`)
  }
  const fields = output.fields
  if (fields === undefined || fields === null) {
    return undefined
  }
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TableError('table: output.fields must be a mapping of field name to its constraint')
  }
  const entries = Object.entries(fields as Record<string, unknown>)
  if (!entries.length) {
    return undefined
  }
  const parsed: Record<string, string> = {}
  for (const [key, hint] of entries) {
    const name = key.trim()
    if (!name) {
      throw new TableError('table: output.fields has an empty field name')
    }
    if (!/^[\w-]+$/.test(name)) {
      throw new TableError(`table: output.fields name "${name}" must use letters, digits, underscore or hyphen`)
    }
    if (typeof hint !== 'string' || !hint.trim()) {
      throw new TableError(`table: output.fields.${name} must be a non-empty constraint string`)
    }
    parsed[name] = hint.trim()
  }
  return parsed
}

/**
 * Read `table.md` frontmatter into a Table.
 *
 * Unknown fields are errors, not ignored: a leftover `phase` or `mode` would
 * otherwise look configured while changing nothing.
 *
 * The body is the meeting's own rules: who sums up, what the meeting is for, how
 * anyone should behave. It is carried verbatim into every seat's system prompt
 * as `body`. The library does not read it and has no opinion about its content.
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
    reasoningEffort: asReasoningEffort(data.reasoningEffort),
    onVeto: asOnVeto(data.onVeto),
    maxAttempts: asPositiveInteger(data.maxAttempts, 'maxAttempts', TABLE_DEFAULTS.maxAttempts),
    outputFields: asOutputFields(data.output),
    ...(document.body.trim()
      ? {
          body: document.body.trim()
        }
      : {})
  }
}
