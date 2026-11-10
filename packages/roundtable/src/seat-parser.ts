import type { Document } from './frontmatter'
import type { Fallback, Seat } from './seat-contract'
import type { YamlMapping, YamlValue } from './yaml'
import { SEAT_DEFAULTS, SeatError } from './seat-contract'

const TOP_LEVEL_KEYS = new Set([
  'id',
  'role',
  'enabled',
  'target',
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
  'canVeto',
  'weight',
  'maxTokens',
  'tools',
  'maxToolCalls',
  'fallback'
])

/**
 * Fields accepted at the top level for projects that have not migrated yet.
 *
 * The contract allows one layer of flat seating: a prompt file such as
 * `name: 周慎` can become a seat without being regrouped first. A field written
 * both ways is an error, because guessing which copy wins hides a real mistake.
 */
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
    'canVeto',
    'weight',
    'maxTokens',
    'fallback'
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
  // No implicit conversion: `weight: "two"` is a typo, not a number.
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

function parseFallback(value: YamlValue | undefined, label: string): Fallback {
  if (value === undefined || value === null) {
    return SEAT_DEFAULTS.fallback
  }
  if (value === 'skip' || value === 'retry' || value === 'abort') {
    return value
  }
  throw new SeatError(label, `seat.fallback must be skip, retry or abort; got ${JSON.stringify(value)}`)
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
  // Required: a seat with no stated function cannot be explained in a log line.
  const role = requireString(document.data.role as YamlValue, label, 'role')

  const weight = asNumber(seat.weight, label, 'seat.weight') ?? SEAT_DEFAULTS.weight
  if (weight <= 0) {
    throw new SeatError(label, 'seat.weight must be greater than 0')
  }
  const maxTokens = asNumber(seat.maxTokens, label, 'seat.maxTokens') ?? SEAT_DEFAULTS.maxTokens
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new SeatError(label, 'seat.maxTokens must be a positive integer')
  }
  const maxToolCalls = asNumber(seat.maxToolCalls, label, 'seat.maxToolCalls') ?? SEAT_DEFAULTS.maxToolCalls
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new SeatError(label, 'seat.maxToolCalls must be a non-negative integer')
  }

  return {
    id,
    role,
    enabled: asBoolean(document.data.enabled as YamlValue, label, 'enabled', SEAT_DEFAULTS.enabled),
    target: asString(document.data.target as YamlValue, label, 'target'),
    identity: {
      // The name only exists for readability in the record; the role is the
      // stated function and is guaranteed to be there.
      name: asString(identity.name, label, 'identity.name') ?? role,
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
      canVeto: asBoolean(seat.canVeto, label, 'seat.canVeto', SEAT_DEFAULTS.canVeto),
      weight,
      maxTokens,
      tools: asStringList(seat.tools, label, 'seat.tools'),
      maxToolCalls,
      fallback: parseFallback(seat.fallback, label)
    },
    body: document.body,
    source
  }
}
