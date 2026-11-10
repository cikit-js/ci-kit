import type { Statement } from '../prompt'
import type { Seat } from '../seat'
import type { callSeat } from './call'
import { readVerdict, vetoReason } from '../verdict'

export function outputFrom(
  statements: Statement[],
  fields?: Record<string, string>
): Record<string, string> | undefined {
  if (!fields || !Object.keys(fields).length) {
    return undefined
  }
  const wanted = new Set(Object.keys(fields))
  const settled: Record<string, string> = {}

  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index]!
    if (statement.status !== 'completed') {
      continue
    }
    const parsed = readVerdict(statement.structured)
    for (const [key, value] of Object.entries(parsed.output ?? {})) {
      if (wanted.has(key) && settled[key] === undefined) {
        settled[key] = value
      }
    }
    if (Object.keys(settled).length === wanted.size) {
      break
    }
  }

  return Object.keys(settled).length
    ? settled
    : undefined
}

export function emptyStatement(
  seat: Seat,
  status: Statement['status'],
  extra?: Partial<Statement>
): Statement {
  return {
    seat: seat.id,
    name: seat.identity.name,
    role: seat.role,
    at: new Date().toISOString(),
    status,
    content: '',
    ...extra
  }
}

export function statementFromOutcome(seat: Seat, outcome: Parameters<typeof callSeat> extends never ? never : Awaited<ReturnType<typeof callSeat>>): Statement {
  if (!outcome.ok) {
    return emptyStatement(seat, 'failed', {
      content: outcome.content,
      error: outcome.error,
      durationMs: outcome.durationMs,
      model: outcome.model,
      usage: outcome.usage,
      toolCalls: outcome.toolCalls
    })
  }

  const parsed = seat.seat.output === 'json'
    ? readVerdict(outcome.structured)
    : {}
  // What lands in the pool is what the seat said, not the envelope it came in.
  // A `output: json` reply is a document; other seats need the sentence inside,
  // or the discussion reads like a log file.
  const spoken = parsed.speech
    ?? (typeof parsed.reason === 'string'
      ? parsed.reason
      : undefined)
    ?? outcome.content
  const statement: Statement = {
    seat: seat.id,
    name: seat.identity.name,
    role: seat.role,
    at: new Date().toISOString(),
    status: 'completed',
    content: spoken,
    speech: spoken,
    durationMs: outcome.durationMs,
    model: outcome.model,
    usage: outcome.usage,
    toolCalls: outcome.toolCalls
  }
  if (seat.seat.output === 'json') {
    if (parsed.verdict !== undefined) {
      statement.verdict = parsed.verdict
    }
    statement.structured = outcome.structured
    statement.finished = parsed.finished === true
    // A veto with no reason is recorded as such and does not count. It stays
    // `completed` for reading purposes, but the status says what happened.
    if (parsed.verdict === 'reject' && seat.seat.canVeto && vetoReason(parsed, outcome.content).length === 0) {
      statement.status = 'invalid-veto'
    }
  }
  return statement
}
