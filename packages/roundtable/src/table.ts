import type { Document } from './frontmatter'
import type { Seat } from './seat'
import type { YamlMapping, YamlValue } from './yaml'

export type PhaseMode = 'serial' | 'parallel'
export type OnVeto = 're-propose' | 'revise' | 'abort'

export interface Phase {
  id: string
  /** Seats named here; empty means "derive from every seat's seat.phase". */
  seats: string[]
  vetoable: boolean
  requires: string[]
  mode: PhaseMode
}

export interface Budget {
  total?: number
  perSeat?: number
}

export interface Table {
  title: string
  schedule?: string
  budget: Budget
  onVeto: OnVeto
  maxAttempts: number
  threshold: number
  /**
   * How long one seat's model call may take. Undefined keeps the http
   * package's default.
   *
   * A seat reads a whole article and replies with paragraphs, which routinely
   * needs more than the transport default meant for short requests. The table
   * owns this because "how long may a seat think" is a property of the review,
   * not of the provider.
   */
  timeoutMs?: number
  phases: Phase[]
  /** Phase ids given the special roles, resolved during validation. */
  special: { propose: string, converge: string }
}

export class TableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableError'
  }
}

const TABLE_KEYS = new Set([
  'title',
  'schedule',
  'budget',
  'onVeto',
  'maxAttempts',
  'threshold',
  'timeoutMs',
  'phases',
  'special'
])
const PHASE_KEYS = new Set([
  'id',
  'seats',
  'vetoable',
  'requires',
  'mode'
])

function asString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new TableError(`table: ${field} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed === ''
    ? undefined
    : trimmed
}

function asNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TableError(`table: ${field} must be a number`)
  }
  return value
}

function asStringList(value: YamlValue | undefined, field: string): string[] {
  if (value === undefined || value === null) {
    return []
  }
  const items = Array.isArray(value)
    ? value
    : [value]
  return items.map((item) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new TableError(`table: ${field} must contain non-empty strings`)
    }
    return item.trim()
  })
}

function asMapping(value: unknown, field: string): YamlMapping {
  if (value === undefined || value === null) {
    return {}
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TableError(`table: ${field} must be a mapping`)
  }
  return value as YamlMapping
}

function parsePhases(value: YamlValue | undefined): Phase[] {
  if (value === undefined || value === null) {
    throw new TableError('table: phases is required')
  }
  if (!Array.isArray(value)) {
    throw new TableError('table: phases must be a list')
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new TableError(`table: phases[${index}] must be a mapping`)
    }
    const raw = item as YamlMapping
    const unknown = Object.keys(raw).filter(key => !PHASE_KEYS.has(key))
    if (unknown.length) {
      throw new TableError(`table: phases[${index}] has unknown field(s): ${unknown.join(', ')}`)
    }
    const id = asString(raw.id, `phases[${index}].id`)
    if (!id) {
      throw new TableError(`table: phases[${index}].id is required`)
    }
    const mode = (asString(raw.mode, `phases[${index}].mode`) ?? 'serial') as PhaseMode
    if (mode !== 'serial' && mode !== 'parallel') {
      throw new TableError(`table: phases[${index}].mode must be serial or parallel`)
    }
    if (raw.vetoable !== undefined && raw.vetoable !== null && typeof raw.vetoable !== 'boolean') {
      throw new TableError(`table: phases[${index}].vetoable must be true or false`)
    }
    return {
      id,
      seats: asStringList(raw.seats, `phases[${index}].seats`),
      vetoable: raw.vetoable === true,
      requires: asStringList(raw.requires, `phases[${index}].requires`),
      mode
    }
  })
}

/** Resolve `special` by explicit value, then by name, then by position. */
function resolveSpecial(
  phases: Phase[],
  special: YamlMapping
): { propose: string, converge: string } {
  const ids = phases.map(phase => phase.id)
  const declaredPropose = asString(special.propose, 'special.propose')
  const declaredConverge = asString(special.converge, 'special.converge')

  const propose = declaredPropose
    ?? (ids.includes('propose')
      ? 'propose'
      : phases[0]!.id)
  const converge = declaredConverge
    ?? (ids.includes('converge')
      ? 'converge'
      : phases[phases.length - 1]!.id)

  for (const [field, id] of [
    ['propose', propose],
    ['converge', converge]
  ] as const) {
    if (!ids.includes(id)) {
      throw new TableError(`table: special.${field} points at unknown phase "${id}"`)
    }
  }
  return { propose, converge }
}

export function parseTable(document: Document, fallbackTitle: string): Table {
  const data = document.data
  const unknown = Object.keys(data).filter(key => !TABLE_KEYS.has(key))
  if (unknown.length) {
    throw new TableError(`table: unknown field(s): ${unknown.join(', ')}`)
  }

  const budgetRaw = asMapping(data.budget, 'budget')
  const budgetUnknown = Object.keys(budgetRaw).filter(key => key !== 'total' && key !== 'perSeat')
  if (budgetUnknown.length) {
    throw new TableError(`table: budget has unknown field(s): ${budgetUnknown.join(', ')}`)
  }
  const total = asNumber(budgetRaw.total, 'budget.total')
  const perSeat = asNumber(budgetRaw.perSeat, 'budget.perSeat')
  if (total !== undefined && total < 0) {
    throw new TableError('table: budget.total must not be negative')
  }
  if (perSeat !== undefined && perSeat < 0) {
    throw new TableError('table: budget.perSeat must not be negative')
  }

  const onVeto = (asString(data.onVeto, 'onVeto') ?? 're-propose') as OnVeto
  if (!['re-propose', 'revise', 'abort'].includes(onVeto)) {
    throw new TableError('table: onVeto must be re-propose, revise or abort')
  }

  const maxAttempts = asNumber(data.maxAttempts, 'maxAttempts') ?? 3
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TableError('table: maxAttempts must be a positive integer')
  }

  const threshold = asNumber(data.threshold, 'threshold') ?? 0.5
  if (threshold <= 0 || threshold > 1) {
    throw new TableError('table: threshold must be greater than 0 and at most 1')
  }

  // Undefined keeps the transport default; a stated value must be usable as a
  // real timeout, so reject anything too small to finish a sentence or so
  // large that a hung request outlives the caller's own patience.
  const timeoutMs = asNumber(data.timeoutMs, 'timeoutMs')
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000)) {
    throw new TableError('table: timeoutMs must be an integer between 1000 and 3600000')
  }

  const phases = parsePhases(data.phases)
  if (!phases.length) {
    throw new TableError('table: at least one phase is required')
  }
  const seen = new Set<string>()
  for (const phase of phases) {
    if (seen.has(phase.id)) {
      throw new TableError(`table: duplicate phase id "${phase.id}"`)
    }
    seen.add(phase.id)
  }

  return {
    title: asString(data.title, 'title') ?? fallbackTitle,
    schedule: asString(data.schedule, 'schedule'),
    budget: { total, perSeat },
    onVeto,
    maxAttempts,
    threshold,
    timeoutMs,
    phases,
    special: resolveSpecial(phases, asMapping(data.special, 'special'))
  }
}

/**
 * Cross-check table and seats, then fill in each phase's seat list.
 *
 * Two declarations of membership exist (table seats and seat.phase). They are
 * intersected, and a seat named in the table but not attending that phase is an
 * error: silently dropping it would make a typo look like a working meeting.
 */
export function resolvePhases(table: Table, seats: Seat[], allPhaseIds: string[]): Phase[] {
  const byId = new Map(seats.map(seat => [seat.id, seat]))

  for (const phase of table.phases) {
    for (const seatId of phase.seats) {
      if (!byId.has(seatId)) {
        throw new TableError(`table: phase "${phase.id}" names unknown seat "${seatId}"`)
      }
    }
    for (const required of phase.requires) {
      if (!allPhaseIds.includes(required)) {
        throw new TableError(`table: phase "${phase.id}" requires unknown phase "${required}"`)
      }
      if (required === phase.id) {
        throw new TableError(`table: phase "${phase.id}" cannot require itself`)
      }
    }
  }

  // Explicit requires may create cycles; detect before execution.
  const order = new Map(table.phases.map((phase, index) => [phase.id, index]))
  for (const phase of table.phases) {
    const deps = phase.requires.length
      ? phase.requires
      : order.get(phase.id)! > 0
        ? [table.phases[order.get(phase.id)! - 1]!.id]
        : []
    for (const dep of deps) {
      if (order.get(dep)! > order.get(phase.id)!) {
        throw new TableError(`table: phase "${phase.id}" requires "${dep}" which comes later; phases run in order`)
      }
    }
  }

  return table.phases.map((phase) => {
    const participating = seats
      .filter(seat => seat.enabled)
      .filter(seat => (phase.seats.length
        ? phase.seats.includes(seat.id)
        : true))
      .filter((seat) => {
        const declared = seat.seat.phase
        if (!declared.length) {
          return true
        }
        if (!declared.includes(phase.id)) {
          if (phase.seats.includes(seat.id)) {
            throw new TableError(
              `seat "${seat.id}" is listed in phase "${phase.id}" but its seat.phase does not include it`
            )
          }
          return false
        }
        return true
      })
      .sort((a, b) => a.seat.priority - b.seat.priority || a.id.localeCompare(b.id))
      .map(seat => seat.id)

    return { ...phase, seats: participating }
  })
}
