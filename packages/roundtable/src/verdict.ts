import type { Seat } from './seat'
import type { Table } from './table'

/**
 * What a seat is allowed to return.
 *
 * There is no `approved` field on purpose: a seat supplies material, the program
 * decides. Keeping that boundary means the same record re-reads to the same
 * conclusion years later.
 */
export interface SeatVerdict {
  /** The line the seat said, in words the other seats can read. */
  speech?: string
  verdict?: 'pass' | 'reject'
  /** Self-reported quality score, 0–1. Recorded, not used for the decision. */
  score?: number
  issues?: string[]
  suggestions?: string[]
  /** Required for a veto. A veto without one is ignored. */
  reason?: string
  /** The seat reports its own target is met; the engine quiets it. */
  finished?: boolean
  /**
   * Whatever the table's `output.fields` asked for, keyed by that field name.
   *
   * Free-form on purpose: the library knows a project declared fields, not what
   * they mean. A seat that fills none of them leaves this undefined.
   */
  output?: Record<string, string>
}

/** One seat's final word in a discussion, after the last-statement rule. */
export interface Vote {
  seatId: string
  weight: number
  vote: 'pass' | 'reject'
  /** True when this seat holds `canVeto` and the seat wrote a reason. */
  veto: boolean
}

export interface Judgement {
  passed: boolean
  /** Seats whose valid veto blocked the meeting. */
  vetoed: string[]
  /** Every seat that voted reject without a valid veto. */
  rejected: string[]
  /** Seats whose veto had no reason and was therefore ignored. */
  invalidVetoes: string[]
  /** Weighted pass ratio over seats that actually voted, 0–1. */
  score: number
  /** Weighted pass weight and total vote weight, for the record's sake. */
  weights: { pass: number, total: number }
  /** Seats that never produced a valid vote, so they are not in the denominator. */
  absent: string[]
}

/**
 * Turn per-seat material into the meeting's verdict.
 *
 * Rules, in contract order:
 * 1. Any valid veto from a `canVeto` seat blocks the meeting.
 * 2. Otherwise the weighted pass share must reach `threshold`.
 * 3. Everything else blocks.
 *
 * A seat that failed or was skipped is not counted at all: absence is not
 * opposition, and a floor of "0% because half the table died" would be a lie
 * about what the meeting decided.
 */
export function judgeMeeting(seats: Seat[], votes: Vote[], table: Table): Judgement {
  const byId = new Map(seats.map(seat => [seat.id, seat]))
  const vetoed: string[] = []
  const rejected: string[] = []
  let passWeight = 0
  let voteWeight = 0

  for (const vote of votes) {
    const seat = byId.get(vote.seatId)
    if (!seat || !seat.enabled) {
      continue
    }
    voteWeight += vote.weight
    if (vote.vote === 'pass') {
      passWeight += vote.weight
      continue
    }
    rejected.push(seat.id)
    if (vote.veto) {
      vetoed.push(seat.id)
    }
  }

  const voted = new Set(votes.map(vote => vote.seatId))
  const absent = seats.filter(seat => seat.enabled && !voted.has(seat.id)).map(seat => seat.id)

  const score = voteWeight === 0
    ? 0
    : passWeight / voteWeight
  // `threshold: 0` must not turn a unanimous rejection into a pass: 0/1 = 0 and
  // 0 >= 0, so the arithmetic alone would say yes to a table that said no. At
  // least one vote of approval is always required; the threshold sets how much,
  // from "one is enough" upward.
  const passed = vetoed.length === 0 && passWeight > 0 && score >= table.threshold

  return {
    passed,
    vetoed,
    rejected,
    invalidVetoes: [],
    score,
    weights: { pass: passWeight, total: voteWeight },
    absent
  }
}

/**
 * Read a seat verdict from parsed JSON, tolerating absent fields.
 *
 * Anything that is not an object is no verdict at all; inferring a decision from
 * prose would let phrasing decide an outcome.
 */
export function readVerdict(raw: unknown): SeatVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const source = raw as Record<string, unknown>
  const verdict = source.verdict === 'pass' || source.verdict === 'reject'
    ? source.verdict
    : undefined
  const score = typeof source.score === 'number' && Number.isFinite(source.score) && source.score >= 0 && source.score <= 1
    ? source.score
    : undefined
  const strings = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) {
      return undefined
    }
    const items = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
    return items.length ? items : undefined
  }
  const reason = typeof source.reason === 'string' && source.reason.trim()
    ? source.reason.trim()
    : undefined
  const issues = strings(source.issues)
  const suggestions = strings(source.suggestions)
  // Only an explicit `true` counts. A missing field, a string "true" or any
  // other shape leaves the seat speaking, which is the safe default: a seat
  // wrongly kept in the room costs one turn, a seat wrongly silenced costs its
  // whole judgment.
  const finished = source.finished === true
    ? true
    : undefined
  const line = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim()
      ? value.trim()
      : undefined
  const speech = line(source.speech)

  // The output fields are whatever the table declared. Every key is kept only
  // when it holds a non-empty string: a model that echoes an empty field has not
  // settled it, and treating "" as settled would let a half-filled meeting look
  // complete.
  let output: Record<string, string> | undefined
  if (source.output && typeof source.output === 'object' && !Array.isArray(source.output)) {
    const filled: Record<string, string> = {}
    for (const [key, value] of Object.entries(source.output as Record<string, unknown>)) {
      const text = line(value)
      if (text !== undefined) {
        filled[key] = text
      }
    }
    if (Object.keys(filled).length) {
      output = filled
    }
  }

  return {
    speech,
    verdict,
    score,
    issues,
    suggestions,
    reason,
    finished,
    output
  }
}

/**
 * The reason a veto carries, preferring an explicit reason and falling back to
 * the issues list — a veto backed by three concrete issues does state its case.
 */
export function vetoReason(verdict: SeatVerdict, content: string): string {
  if (verdict.reason) {
    return verdict.reason
  }
  if (verdict.issues?.length) {
    return verdict.issues.slice(0, 5).join('；')
  }
  // A plain-text seat may still write `否决：理由`; the text after the marker is
  // the reason. A bare `否决` states no reason, so the veto cannot count. The
  // marker can start any line, not only the first one.
  // Two anchored patterns rather than one optional group: `\s*.*` in a single
  // expression backtracks polynomially on a long line of spaces.
  const marked = /^(?:否决|不通过|reject)[ \t]*[：:]/i
  const empty = /^(?:否决|不通过|reject)[ \t]*[：:][ \t]*$/i
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (marked.test(trimmed)) {
      return empty.test(trimmed)
        ? ''
        : trimmed.replace(marked, '').trim()
    }
  }
  return ''
}
