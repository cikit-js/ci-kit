import type { Statement } from '../prompt'
import type { Seat } from '../seat'
import type { DiscussionResult, EngineOptions, Usage } from './discussion-types'
import { describeError, isAbortError } from './call'
import { runSeatLoop } from './discussion-seat'
import { emptyStatement, outputFrom } from './discussion-statements'

export { emptyStatement, outputFrom } from './discussion-statements'
export * from './discussion-types'

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function discuss(options: EngineOptions): Promise<DiscussionResult> {
  const { loaded } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const seats = loaded.seats.filter(seat => seat.enabled)
  const startedAt = options.startedAt ?? now()
  const deadline = startedAt + loaded.table.durationMs
  const effort = loaded.table.reasoningEffort
  const pool: Statement[] = [
    ...(options.priorPool ?? [])
  ]
  const usage: Usage = { input: 0, output: 0 }
  let abortedBy: DiscussionResult['abortedBy']
  let stopped = false
  const gate = new Map<string, number>()
  const quiet = new Set<string>()
  const waiting = new Set<string>()
  const gone = new Set<string>()
  const lastChanceUsed = new Set<string>()
  const unfinished = new Set<string>()
  const stalled = (): boolean => {
    const live = seats.filter(seat => !gone.has(seat.id) && !quiet.has(seat.id))
    return live.length > 0 && live.every(seat => waiting.has(seat.id))
  }
  const freshStatements = (): Statement[] => pool.slice(options.priorPool?.length ?? 0)
  const land = (statement: Statement): void => {
    pool.push(statement)
    options.events?.onStatement?.(statement)
  }
  const mentions = (text: string, seat: Seat): boolean => text.includes(seat.identity.name) || text.includes(seat.id)
  const wakeMentioned = (statement: Statement): void => {
    if (statement.status !== 'completed')
      return
    for (const id of quiet) {
      const seat = seats.find(item => item.id === id)
      if (seat && mentions(statement.content, seat)) {
        quiet.delete(id)
        gate.delete(id)
      }
    }
  }
  const state = {
    loaded,
    options,
    pool,
    usage,
    now,
    sleep,
    deadline,
    effort,
    gate,
    quiet,
    waiting,
    gone,
    lastChanceUsed,
    unfinished,
    stalled,
    land,
    wakeMentioned,
    isStopped: () => stopped,
    stop: (seat: string, error: string) => {
      abortedBy = { seat, error }
      stopped = true
    }
  }
  await Promise.all(seats.map(async seat => runSeatLoop(seat, state).catch((error) => {
    if (isAbortError(error))
      throw error
    const message = describeError(error).text
    land(emptyStatement(seat, 'failed', { error: message }))
    if (seat.seat.fallback === 'abort') {
      abortedBy = { seat: seat.id, error: message }
      stopped = true
    }
  })))
  return {
    statements: freshStatements(),
    abortedBy,
    usage,
    output: outputFrom(freshStatements(), loaded.table.outputFields)
  }
}
