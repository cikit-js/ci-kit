import type { Seat } from './seat'
import type { Phase, Table } from './table'

/** What a seat is allowed to return; the seat never says "approved". */
export interface SeatVerdict {
  /** `pass` / `reject`; only veto-capable seats get to veto, others just vote. */
  verdict?: 'pass' | 'reject'
  score?: number
  issues?: string[]
  suggestions?: string[]
  /** Reason attached to a veto. A veto without one is ignored. */
  reason?: string
}

export interface Vote {
  seatId: string
  weight: number
  /** `undefined` when the seat failed or was skipped, so it cannot count. */
  vote?: 'pass' | 'reject'
  /** Set when a veto-capable seat wrote `reject` with a reason. */
  veto?: boolean
  /** Whether the seat actually wrote text for its reason. */
  hasReason?: boolean
}

export interface Judgement {
  passed: boolean
  /** Seats whose valid veto blocked the phase. */
  vetoed: string[]
  /** Seats that voted reject without a valid veto. */
  rejected: string[]
  /** Weighted pass ratio over seats that actually voted. */
  score: number
  /** Seats whose veto had no reason and was therefore ignored. */
  invalidVetoes: string[]
}

/**
 * Turn per-seat material into one phase verdict.
 *
 * Model output is material, never the decision: a seat supplies a vote and an
 * optional veto, and this function alone decides. That keeps a record
 * re-readable years later with the same result.
 *
 * Rules, in order:
 * 1. A veto from a `canVeto` seat in a `vetoable` phase blocks it, but only
 *    when the seat wrote a reason.
 * 2. Otherwise the weighted pass ratio must reach `threshold`.
 * 3. Seats that failed or were skipped are excluded from the denominator:
 *    absence is not opposition.
 */
export function judgePhase(
  phase: Phase,
  seats: Seat[],
  votes: Vote[],
  table: Table
): Judgement {
  const byId = new Map(seats.map(seat => [seat.id, seat]))
  const vetoed: string[] = []
  const rejected: string[] = []
  const invalidVetoes: string[] = []
  let passWeight = 0
  let voteWeight = 0

  // A veto only counts where the table opened the phase for it; leaving the
  // flag inert elsewhere is safer than silently granting power nobody scoped.
  const vetoEnabled = phase.vetoable

  for (const vote of votes) {
    const seat = byId.get(vote.seatId)
    if (!seat || vote.vote === undefined) {
      continue
    }
    voteWeight += vote.weight
    if (vote.vote === 'pass') {
      passWeight += vote.weight
      continue
    }

    rejected.push(seat.id)
    if (!vote.veto) {
      continue
    }
    if (!vetoEnabled || !seat.seat.canVeto) {
      continue
    }
    // The design forbids silent rejection: a model that can say "no" for free
    // will occasionally do exactly that.
    if (!vote.hasReason) {
      invalidVetoes.push(seat.id)
      continue
    }
    vetoed.push(seat.id)
  }

  const score = voteWeight === 0
    ? 0
    : passWeight / voteWeight
  const passed = vetoed.length === 0 && voteWeight > 0 && score >= table.threshold
  return {
    passed,
    vetoed,
    rejected,
    score,
    invalidVetoes
  }
}

/** Read a seat verdict from parsed JSON, tolerating absent fields. */
export function readVerdict(raw: unknown): SeatVerdict {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const source = raw as Record<string, unknown>
  const verdict = source.verdict === 'pass' || source.verdict === 'reject'
    ? source.verdict
    : undefined
  const score = typeof source.score === 'number' && Number.isFinite(source.score)
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
  return {
    verdict,
    score,
    issues: strings(source.issues),
    suggestions: strings(source.suggestions),
    reason
  }
}
