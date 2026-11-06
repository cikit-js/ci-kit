import type { Document } from './frontmatter'
import type { YamlMapping, YamlValue } from './yaml'

export type Sees = 'all' | 'none' | 'lead-only' | string[]
export type Fallback = 'skip' | 'retry' | 'abort'
export type SeatOutput = 'text' | 'json' | 'markdown'

export interface SeatIdentity {
  name: string
  avatar?: string
  title?: string
  background?: string
}

export interface SeatPersona {
  /** Decision tendency. Kept apart from expression so verdicts stay reproducible. */
  stance?: string
  personality: string[]
  style?: string
  speech?: string
  values?: string
  quirks?: string
  avoid?: string
}

export interface SeatPowers {
  /** Phase ids this seat attends; empty means every phase. */
  phase: string[]
  sees: Sees
  canPropose: boolean
  canVeto: boolean
  lead: boolean
  weight: number
  priority: number
  budget?: number
  fallback: Fallback
  output: SeatOutput
  model?: string
  temperature?: number
  maxTokens?: number
}

export interface Seat {
  id: string
  role: string
  enabled: boolean
  identity: SeatIdentity
  persona: SeatPersona
  seat: SeatPowers
  /** Markdown body, used verbatim as the seat's instructions. */
  body: string
  /** File the seat came from, for error messages only. */
  source: string
}

export class SeatError extends Error {
  constructor(readonly label: string, message: string) {
    super(`${label}: ${message}`)
    this.name = 'SeatError'
  }
}

const TOP_LEVEL_KEYS = new Set([
  'id',
  'role',
  'enabled',
  'identity',
  'persona',
  'seat'
])
const IDENTITY_KEYS = new Set([
  'name',
  'avatar',
  'title',
  'background'
])
const PERSONA_KEYS = new Set([
  'stance',
  'personality',
  'style',
  'speech',
  'values',
  'quirks',
  'avoid'
])
const SEAT_KEYS = new Set([
  'phase',
  'sees',
  'canPropose',
  'canVeto',
  'lead',
  'weight',
  'priority',
  'budget',
  'fallback',
  'output',
  'model',
  'temperature',
  'maxTokens'
])

/** Fields accepted at the top level for projects that have not migrated yet. */
const FLAT_ALIASES = new Map<string, 'identity' | 'persona' | 'seat'>([
  ...[
    'name',
    'avatar',
    'title',
    'background'
  ].map(key => [key, 'identity'] as const),
  ...[
    'stance',
    'personality',
    'style',
    'speech',
    'values',
    'quirks',
    'avoid'
  ].map(key => [key, 'persona'] as const),
  ...[
    'phase',
    'sees',
    'canPropose',
    'canVeto',
    'lead',
    'weight',
    'priority',
    'budget',
    'fallback',
    'output',
    'model',
    'temperature',
    'maxTokens'
  ].map(key => [key, 'seat'] as const)
])

function asString(value: YamlValue | undefined, label: string, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new SeatError(label, `${field} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === ''
    ? undefined
    : trimmed
}

function requireString(value: YamlValue | undefined, label: string, field: string): string {
  const result = asString(value, label, field)
  if (!result) {
    throw new SeatError(label, `${field} is required`)
  }
  return result
}

function asBoolean(value: YamlValue | undefined, label: string, field: string, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback
  }
  if (typeof value !== 'boolean') {
    throw new SeatError(label, `${field} must be true or false`)
  }
  return value
}

function asNumber(value: YamlValue | undefined, label: string, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SeatError(label, `${field} must be a number`)
  }
  return value
}

function asStringList(value: YamlValue | undefined, label: string, field: string): string[] {
  if (value === undefined || value === null) {
    return []
  }
  const items = Array.isArray(value)
    ? value
    : [value]
  return items.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new SeatError(label, `${field} must contain non-empty strings`)
    }
    return item.trim()
  })
}

function asMapping(value: YamlValue | undefined, label: string, field: string): YamlMapping {
  if (value === undefined || value === null) {
    return {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SeatError(label, `${field} must be a mapping`)
  }
  return value as YamlMapping
}

function rejectUnknownKeys(mapping: YamlMapping, allowed: Set<string>, label: string, where: string): void {
  const unknown = Object.keys(mapping).filter(key => !allowed.has(key))
  if (unknown.length) {
    throw new SeatError(label, `unknown field${unknown.length > 1
      ? 's'
      : ''} in ${where}: ${unknown.join(', ')}`)
  }
}

/** Merge flat aliases into their groups, rejecting duplicates in both places. */
function groupData(data: YamlMapping, label: string) {
  const groups = {
    identity: {
      ...asMapping(data.identity, label, 'identity')
    } as YamlMapping,
    persona: {
      ...asMapping(data.persona, label, 'persona')
    } as YamlMapping,
    seat: {
      ...asMapping(data.seat, label, 'seat')
    } as YamlMapping
  }
  for (const [key, value] of Object.entries(data)) {
    if (TOP_LEVEL_KEYS.has(key)) {
      continue
    }
    const target = FLAT_ALIASES.get(key)
    if (!target) {
      throw new SeatError(label, `unknown field "${key}"; expected one of ${[...TOP_LEVEL_KEYS].join(', ')}`)
    }
    if (Object.hasOwn(groups[target], key)) {
      throw new SeatError(label, `"${key}" is declared both at the top level and inside ${target}`)
    }
    groups[target][key] = value
  }
  return groups
}

function parseSees(value: YamlValue | undefined, label: string): Sees {
  if (value === undefined || value === null) {
    return 'all'
  }
  if (Array.isArray(value)) {
    const ids = asStringList(value, label, 'seat.sees')
    if (!ids.length) {
      throw new SeatError(label, 'seat.sees list must not be empty; use "all" or "none"')
    }
    return ids
  }
  if (value === 'all' || value === 'none' || value === 'lead-only') {
    return value
  }
  throw new SeatError(label, `seat.sees must be all, none, lead-only or a list of seat ids; got "${String(value)}"`)
}

/** Render the seat persona block that precedes the Markdown body. */
export function renderSeatSystemPrompt(seat: Seat): string {
  const lines: string[] = []
  const { identity, persona } = seat

  const headline = [identity.title, `是一名${seat.role}`].filter(Boolean).join('，')
  lines.push(`你是${identity.name}，${headline}。`)

  if (identity.background) {
    lines.push('', '## 背景', identity.background)
  }
  if (persona.personality.length) {
    lines.push('', '## 你的性格', persona.personality.join('、'))
  }
  if (persona.stance) {
    lines.push('', '## 你的立场', persona.stance)
  }
  const speech: string[] = []
  if (persona.style) {
    speech.push(persona.style)
  }
  if (persona.speech) {
    speech.push(persona.speech)
  }
  if (persona.quirks) {
    speech.push(persona.quirks)
  }
  if (speech.length) {
    lines.push('', '## 你的说话方式', ...speech.map(line => `- ${line}`))
  }
  if (persona.values) {
    lines.push('', '## 你的原则', persona.values)
  }
  if (persona.avoid) {
    lines.push('', '## 你的边界', persona.avoid)
  }
  if (seat.body) {
    lines.push('', seat.body)
  }
  return lines.join('\n')
}

export function parseSeat(document: Document, source: string): Seat {
  const label = `seat ${source}`
  const { identity, persona, seat } = groupData(document.data, label)

  rejectUnknownKeys(identity, IDENTITY_KEYS, label, 'identity')
  rejectUnknownKeys(persona, PERSONA_KEYS, label, 'persona')
  rejectUnknownKeys(seat, SEAT_KEYS, label, 'seat')

  const id = requireString(document.data.id as YamlValue, label, 'id')
  if (!/^[\w-]+$/.test(id)) {
    throw new SeatError(label, `id "${id}" must use letters, digits, underscore or hyphen`)
  }
  const role = requireString(document.data.role as YamlValue, label, 'role')

  const weight = asNumber(seat.weight, label, 'seat.weight') ?? 1
  if (weight <= 0) {
    throw new SeatError(label, 'seat.weight must be greater than 0')
  }
  const budget = asNumber(seat.budget, label, 'seat.budget')
  if (budget !== undefined && budget < 0) {
    throw new SeatError(label, 'seat.budget must not be negative')
  }

  const fallback = (asString(seat.fallback, label, 'seat.fallback') ?? 'skip') as Fallback
  if (!['skip', 'retry', 'abort'].includes(fallback)) {
    throw new SeatError(label, 'seat.fallback must be skip, retry or abort')
  }
  const output = (asString(seat.output, label, 'seat.output') ?? 'text') as SeatOutput
  if (!['text', 'json', 'markdown'].includes(output)) {
    throw new SeatError(label, 'seat.output must be text, json or markdown')
  }

  const name = asString(identity.name, label, 'identity.name') ?? role

  return {
    id,
    role,
    enabled: asBoolean(document.data.enabled as YamlValue, label, 'enabled', true),
    identity: {
      name,
      avatar: asString(identity.avatar, label, 'identity.avatar'),
      title: asString(identity.title, label, 'identity.title'),
      background: asString(identity.background, label, 'identity.background')
    },
    persona: {
      stance: asString(persona.stance, label, 'persona.stance'),
      personality: asStringList(persona.personality, label, 'persona.personality'),
      style: asString(persona.style, label, 'persona.style'),
      speech: asString(persona.speech, label, 'persona.speech'),
      values: asString(persona.values, label, 'persona.values'),
      quirks: asString(persona.quirks, label, 'persona.quirks'),
      avoid: asString(persona.avoid, label, 'persona.avoid')
    },
    seat: {
      phase: asStringList(seat.phase, label, 'seat.phase'),
      sees: parseSees(seat.sees, label),
      canPropose: asBoolean(seat.canPropose, label, 'seat.canPropose', false),
      canVeto: asBoolean(seat.canVeto, label, 'seat.canVeto', false),
      lead: asBoolean(seat.lead, label, 'seat.lead', false),
      weight,
      priority: asNumber(seat.priority, label, 'seat.priority') ?? 99,
      budget,
      fallback,
      output,
      model: asString(seat.model, label, 'seat.model'),
      temperature: asNumber(seat.temperature, label, 'seat.temperature'),
      maxTokens: asNumber(seat.maxTokens, label, 'seat.maxTokens')
    },
    body: document.body,
    source
  }
}
