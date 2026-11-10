import type { ReasoningEffort } from '@ci-kit/ai'
import type { LoadedRoundtable } from '../config'
import type { ArtifactRef, Statement } from '../prompt'
import type { Seat } from '../seat'
import type { EngineOptions, Usage } from './discussion-types'
import { buildUserPrompt, visibleStatements } from '../prompt'
import { callSeat } from './call'
import { statementFromOutcome } from './discussion-statements'
import { ARTIFACT_THRESHOLD, MAX_IDLE_MS, POOL_POLL_MS, RETRY_BACKOFF_MS } from './discussion-types'
import { trimPool } from './pool'

export interface SeatLoopState {
  loaded: LoadedRoundtable
  options: EngineOptions
  pool: Statement[]
  usage: Usage
  now: () => number
  sleep: (ms: number) => Promise<void>
  deadline: number
  effort: ReasoningEffort | undefined
  gate: Map<string, number>
  quiet: Set<string>
  waiting: Set<string>
  gone: Set<string>
  lastChanceUsed: Set<string>
  unfinished: Set<string>
  stalled: () => boolean
  land: (statement: Statement) => void
  wakeMentioned: (statement: Statement) => void
  isStopped: () => boolean
  stop: (seat: string, error: string) => void
}

export async function runSeatLoop(seat: Seat, state: SeatLoopState): Promise<void> {
  let idleSince: number | undefined
  let lastChance = false
  while (!state.isStopped()) {
    if (state.now() >= state.deadline) {
      state.gone.add(seat.id)
      return
    }

    const floor = state.gate.get(seat.id)
    if (floor !== undefined && state.pool.length <= floor) {
      state.waiting.add(seat.id)
      const waitingSince = idleSince ?? Date.now()
      idleSince = waitingSince
      await state.sleep(state.options.pollMs ?? POOL_POLL_MS)
      if (state.pool.length <= floor) {
        const idleExit = Date.now() - waitingSince >= MAX_IDLE_MS
        if (state.stalled() || idleExit) {
          const owesFields = Object.keys(state.loaded.table.outputFields ?? {}).length > 0
          const pending = seat.seat.output === 'json' && (state.unfinished.has(seat.id) || owesFields)
          if (pending && !state.lastChanceUsed.has(seat.id) && !state.quiet.has(seat.id)) {
            state.lastChanceUsed.add(seat.id)
            state.waiting.delete(seat.id)
            idleSince = undefined
            lastChance = true
            state.gate.delete(seat.id)
          }
          else {
            state.waiting.delete(seat.id)
            return
          }
        }
        else if (state.now() >= state.deadline) {
          state.waiting.delete(seat.id)
          return
        }
        else {
          continue
        }
      }
      else {
        state.waiting.delete(seat.id)
        idleSince = undefined
      }
    }
    else {
      idleSince = undefined
    }

    const snapshot = trimPool(state.pool, state.loaded.table.maxPoolTokens)
    const prompt = buildUserPrompt({
      topic: state.options.topic,
      brief: state.options.brief,
      context: state.options.context,
      visible: visibleStatements(snapshot.kept),
      dropped: snapshot.dropped,
      revisionNotes: (state.options.attempt ?? 1) === 1
        ? state.options.openingNotes ?? state.options.revisionNotes
        : state.options.revisionNotes,
      askFinished: seat.seat.output === 'json',
      outputFields: state.loaded.table.outputFields,
      roomQuiet: lastChance
    })
    lastChance = false

    let outcome = await callSeat(seat, prompt, {
      env: state.options.env,
      callText: state.options.callText,
      now: state.options.now,
      reasoningEffort: state.effort,
      tableBody: state.loaded.table.body,
      outputFields: state.loaded.table.outputFields,
      tools: state.options.tools
    })
    if (!outcome.ok && seat.seat.fallback === 'retry' && outcome.retryable && state.now() < state.deadline) {
      await state.sleep(RETRY_BACKOFF_MS)
      if (state.now() < state.deadline && !state.isStopped()) {
        outcome = await callSeat(seat, prompt, {
          env: state.options.env,
          callText: state.options.callText,
          now: state.options.now,
          reasoningEffort: state.effort,
          tableBody: state.loaded.table.body,
          outputFields: state.loaded.table.outputFields,
          tools: state.options.tools
        })
      }
    }

    if (outcome.usage) {
      state.usage.input += outcome.usage.input
      state.usage.output += outcome.usage.output
    }
    const statement = statementFromOutcome(seat, outcome)
    if (outcome.ok && state.options.writeArtifact && statement.content.length > ARTIFACT_THRESHOLD) {
      const relative = `artifacts/attempt-${state.options.attempt ?? 1}-${seat.id}-${state.pool.length + 1}.md`
      const bytes = await state.options.writeArtifact(relative, statement.content)
      const ref: ArtifactRef = { path: relative, bytes }
      statement.artifacts = [ref]
    }

    state.land(statement)
    state.wakeMentioned(statement)
    await state.options.persist?.()
    if (!outcome.ok) {
      if (seat.seat.fallback === 'abort')
        state.stop(seat.id, outcome.error ?? 'seat failed')
      state.gone.add(seat.id)
      return
    }
    if (statement.finished) {
      state.quiet.add(seat.id)
      state.unfinished.delete(seat.id)
      return
    }
    const raw = statement.structured as { finished?: unknown } | undefined
    if (raw?.finished === false)
      state.unfinished.add(seat.id)
    state.gate.set(seat.id, state.pool.length)
  }
}
