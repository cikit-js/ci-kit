import type { Statement } from '../prompt'
import type { Seat } from '../seat'
import type { Vote } from '../verdict'
import { readVerdict, vetoReason } from '../verdict'

/** The structured verdict a seat cast, if any. */
export function voteOf(seat: Seat, statement: Statement): Vote | undefined {
  if (statement.verdict === undefined) {
    return undefined
  }
  const parsed = readVerdict(statement.structured)
  if (parsed.verdict === 'reject') {
    const reason = vetoReason(parsed, statement.content)
    return {
      seatId: seat.id,
      weight: seat.seat.weight,
      vote: 'reject',
      // Only a `canVeto` seat can veto, and only with a reason on record.
      veto: seat.seat.canVeto && reason.length > 0
    }
  }
  return {
    seatId: seat.id,
    weight: seat.seat.weight,
    vote: 'pass',
    veto: false
  }
}

/** Statements that produced a vote, dropping earlier ones from the same seat. */
export function finalVotes(seats: Seat[], statements: Statement[]): Vote[] {
  const byId = new Map(seats.map(seat => [seat.id, seat]))
  const latest = new Map<string, Vote>()
  for (const statement of statements) {
    const seat = byId.get(statement.seat)
    if (!seat) {
      continue
    }
    const vote = voteOf(seat, statement)
    if (!vote) {
      continue
    }
    // A seat may speak many times; its last statement is its word. Anything
    // earlier is the discussion, not the verdict.
    latest.set(seat.id, vote)
  }
  return [
    ...latest.values()
  ]
}
