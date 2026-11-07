import type { LoadedRoundtable } from '../config'
import type { ArtifactRef, Statement } from '../prompt'
import type { Seat } from '../seat'
import type { CallContext } from './call'
import { buildUserPrompt, visibleStatements } from '../prompt'
import { readVerdict, vetoReason } from '../verdict'
import { callSeat, describeError, isAbortError } from './call'
import { trimPool } from './pool'

export interface Usage {
  input: number
  output: number
}

/** Same status set as the record; `running` never reaches disk as a final value. */
export type RoundtableStatus = 'running' | 'passed' | 'rejected' | 'aborted' | 'failed'

export interface EngineEvents {
  /** One line per finished call, for CLI progress on stderr. */
  onStatement?: (statement: Statement) => void
}

export interface EngineOptions extends CallContext {
  loaded: LoadedRoundtable
  /** The question, when the caller set one; the rule file may open it instead. */
  topic?: string
  brief?: string
  /** Initial material, already normalized to a list and in the caller's order. */
  context: string[]
  /** Statements produced before an interruption, replayed as the opening pool. */
  priorPool?: Statement[]
  /** Veto reasons from the previous attempt; fed to every seat of a follow-up round. */
  revisionNotes?: string[]
  /**
   * The first discussion opens with these reasons already on the table.
   *
   * A resumed run is still the same attempt: the veto reasons it was opened with
   * belong to it, or a seat speaking after the crash would never hear them.
   */
  openingNotes?: string[]
  /** When the discussion started, for a resumed run. Defaults to now. */
  startedAt?: number
  /** Persist progress; called after every landed statement. */
  persist?: () => void | Promise<void>
  /** Attempt number, so artifacts from a retry never overwrite the previous one. */
  attempt?: number
  /** Write oversized statement bodies under `artifacts/`, returning the byte count. */
  writeArtifact?: (relativePath: string, content: string) => Promise<number>
  events?: EngineEvents
  /** Injection point for tests: sleep between a `retry` seat's attempts. */
  sleep?: (ms: number) => Promise<void>
  /** Injection point for tests: how long to wait before re-checking the pool. */
  pollMs?: number
}

export interface DiscussionResult {
  /** Everything that landed in the pool this run, in landing order. */
  statements: Statement[]
  /** Set when a seat with `fallback: abort` failed and ended the meeting. */
  abortedBy?: { seat: string, error: string }
  usage: Usage
  /**
   * The structured result the table declared, filled by whichever seats filled
   * it. Absent when the table declared no `output.fields`, or nobody settled
   * them.
   *
   * Read from this run's statements only: a resumed meeting that settled
   * nothing must not inherit the result of the meeting it continues.
   */
  output?: Record<string, string>
}

/**
 * Above this length a statement's body is written to `artifacts/` instead of
 * being inlined in `record.json`.
 *
 * The record stays a compact index of what happened; a long draft belongs in its
 * own file that a later step can read, diff or publish without parsing a
 * megabyte of JSON.
 */
export const ARTIFACT_THRESHOLD = 8_000

/** Wait between a `retry` seat's first and second attempt, in ms. */
export const RETRY_BACKOFF_MS = 500

/** How often a waiting seat re-checks whether the pool moved, in ms. */
export const POOL_POLL_MS = 100

/**
 * How long a waiting seat tolerates silence before it stops, in ms.
 *
 * The real bound on a discussion is `durationMs`; this is the backstop for the
 * injected-clock case, where `now()` may not advance and the deadline would
 * never fire. It is measured against real wall time, so a real meeting reaches
 * `durationMs` long before this matters.
 */
export const MAX_IDLE_MS = 2_000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run one discussion: every seat talks in its own loop until the deadline.
 *
 * A seat that has spoken does not immediately speak again. It waits until the
 * pool grows past its own last statement — someone else has to say something
 * first. Without that rule the loop simply re-enters and one seat out-talks the
 * room (measured: 61 statements in three minutes against 1 for the slowest).
 *
 * A seat whose reply says `done` goes quiet instead of waiting: it has nothing
 * left to argue, and it comes back only if someone names it.
 */
export async function discuss(options: EngineOptions): Promise<DiscussionResult> {
  const { loaded } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const pollMs = options.pollMs ?? POOL_POLL_MS
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

  /** Pool length each seat must see exceeded before it may speak again. */
  const gate = new Map<string, number>()
  /** Seats that said `done` and are waiting to be named. */
  const quiet = new Set<string>()
  /**
   * Seats currently inside their wait loop.
   *
   * When every live seat is waiting, nobody can produce the statement the others
   * are waiting for: the room is stalled, not thinking. That is the end of the
   * discussion, and it is the normal case for two seats that have both said
   * their piece — not an edge case.
   */
  const waiting = new Set<string>()
  /** Seats that have left the room for good: failed, or finished their loop. */
  const gone = new Set<string>()

  /**
   * Seats that already took their one extra turn after the room went quiet.
   *
   * Without this a stall would replay forever: every seat is told to speak,
   * everyone speaks, the room settles again, and the same thing repeats.
   */
  const lastChanceUsed = new Set<string>()

  /**
   * Seats that said, in so many words, that their part is not done.
   *
   * The extra turn after a stall is only worth spending on a seat in here. A
   * reviewing seat answers `pass`/`reject` and never speaks to `finished`; it has
   * nothing pending, so asking it again is a paid call that changes no decision.
   */
  const unfinished = new Set<string>()

  /** True when no live seat is able to speak without someone else moving first. */
  const stalled = (): boolean => {
    const live = seats.filter(seat => !gone.has(seat.id) && !quiet.has(seat.id))
    return live.length > 0 && live.every(seat => waiting.has(seat.id))
  }

  /** Statements this run has landed, excluding whatever came in with the pool. */
  const freshStatements = (): Statement[] => pool.slice(options.priorPool?.length ?? 0)

  const land = (statement: Statement): void => {
    pool.push(statement)
    options.events?.onStatement?.(statement)
  }

  /** True when `text` mentions this seat by display name or by id. */
  const mentions = (text: string, seat: Seat): boolean =>
    text.includes(seat.identity.name) || text.includes(seat.id)

  /**
   * A quiet seat returns to the discussion when someone names it.
   *
   * Naming is matched textually: a seat cannot ask to be woken, and the meeting
   * has no other channel. Missing a mention is safe — the seat stays quiet and
   * the discussion simply ends without it.
   */
  const wakeMentioned = (statement: Statement): void => {
    if (statement.status !== 'completed') {
      return
    }
    for (const id of quiet) {
      const seat = seats.find(item => item.id === id)
      if (seat && mentions(statement.content, seat)) {
        quiet.delete(id)
        gate.delete(id)
      }
    }
  }

  const runSeat = async (seat: Seat): Promise<void> => {
    /** Wall-clock moment this seat started waiting for the pool; cleared on news. */
    let idleSince: number | undefined
    /** This turn is the seat's one extra turn after the room went quiet. */
    let lastChance = false
    while (!stopped) {
      if (now() >= deadline) {
        // Deadline reached: no new request is started. Requests already in
        // flight elsewhere still finish and are billed, so they land.
        gone.add(seat.id)
        return
      }

      // Wait for the room to move. The floor a seat is waiting on is the pool
      // length at its own last statement; anything above that is news to it.
      //
      // The wait polls the pool, so it needs an exit that does not depend on
      // `now()` moving: tests advance the clock by hand, and a loop that only
      // leaves when the deadline fires would spin forever there. The silence
      // backstop is measured on wall time for exactly that reason.
      const floor = gate.get(seat.id)
      if (floor !== undefined && pool.length <= floor) {
        waiting.add(seat.id)
        const waitingSince = idleSince ?? Date.now()
        idleSince = waitingSince
        await sleep(pollMs)
        if (pool.length <= floor) {
          // A stall is not the same as agreement. The normal way out is that a
          // seat which has something left to say says it — but every seat is
          // sitting on the same "wait for someone else" rule, so the room can
          // deadlock with nobody finished. Give a seat one last turn, once, and
          // tell it the room went quiet; then stall for real if nothing comes.
          //
          // Two exits count as "the room stopped": everyone is waiting at once,
          // which is the clean deadlock, and one seat has been idle long enough,
          // which is how it actually ends when seats take turns naming each
          // other. Both mean the same thing to a pending seat.
          const IDLE_EXIT = Date.now() - waitingSince >= MAX_IDLE_MS
          if (stalled() || IDLE_EXIT) {
            // The extra turn is only worth a paid call for a meeting that owes
            // something: the table declared output fields and they are still
            // unfilled. A review-only meeting owes nothing and ends as before.
            const owesFields = Object.keys(loaded.table.outputFields ?? {}).length > 0
            const pending = seat.seat.output === 'json' && (unfinished.has(seat.id) || owesFields)
            if (pending && !lastChanceUsed.has(seat.id) && !quiet.has(seat.id)) {
              lastChanceUsed.add(seat.id)
              waiting.delete(seat.id)
              idleSince = undefined
              lastChance = true
              // The gate would put this seat straight back into the wait it just
              // left — the pool has not moved and will not move. Clear it so the
              // loop falls through to the call this turn was granted for.
              gate.delete(seat.id)
            }
            else {
              waiting.delete(seat.id)
              return
            }
          }
          else if (now() >= deadline) {
            waiting.delete(seat.id)
            return
          }
          else {
            continue
          }
        }
        else {
          // The room moved; fall through and speak, and stop counting as waiting.
          waiting.delete(seat.id)
          idleSince = undefined
        }
      }
      else {
        idleSince = undefined
      }

      const snapshot = trimPool(pool, loaded.table.maxPoolTokens)
      const prompt = buildUserPrompt({
        topic: options.topic,
        brief: options.brief,
        context: options.context,
        visible: visibleStatements(snapshot.kept),
        dropped: snapshot.dropped,
        revisionNotes: (options.attempt ?? 1) === 1
          ? options.openingNotes ?? options.revisionNotes
          : options.revisionNotes,
        askFinished: seat.seat.output === 'json',
        outputFields: loaded.table.outputFields,
        // The room went quiet and this seat has still not finished: tell it so,
        // or it will spend its extra turn waiting again.
        roomQuiet: lastChance
      })
      lastChance = false

      let outcome = await callSeat(seat, prompt, {
        env: options.env,
        callText: options.callText,
        now: options.now,
        reasoningEffort: effort,
        tableBody: loaded.table.body,
        outputFields: loaded.table.outputFields
      })
      if (!outcome.ok && seat.seat.fallback === 'retry' && outcome.retryable && now() < deadline) {
        await sleep(RETRY_BACKOFF_MS)
        if (now() < deadline && !stopped) {
          outcome = await callSeat(seat, prompt, {
            env: options.env,
            callText: options.callText,
            now: options.now,
            reasoningEffort: effort,
            tableBody: loaded.table.body,
            outputFields: loaded.table.outputFields
          })
        }
      }

      if (outcome.usage) {
        usage.input += outcome.usage.input
        usage.output += outcome.usage.output
      }

      const attempt = options.attempt ?? 1
      const statement = statementFromOutcome(seat, outcome)

      // A long body belongs in its own file: the record stays a compact index,
      // and the artifact is named per attempt so a retry never overwrites the
      // previous one — old output is evidence for review.
      if (outcome.ok && options.writeArtifact && statement.content.length > ARTIFACT_THRESHOLD) {
        const relative = `artifacts/attempt-${attempt}-${seat.id}-${pool.length + 1}.md`
        const bytes = await options.writeArtifact(relative, statement.content)
        const ref: ArtifactRef = { path: relative, bytes }
        statement.artifacts = [ref]
      }

      land(statement)
      wakeMentioned(statement)
      await options.persist?.()

      if (!outcome.ok) {
        // 失败即该席位停止发言：`skip` 记一次缺席并让其他人继续；`retry` 已
        // 用尽重试；`abort` 终止整场会。
        if (seat.seat.fallback === 'abort') {
          abortedBy = { seat: seat.id, error: outcome.error ?? 'seat failed' }
          stopped = true
        }
        gone.add(seat.id)
        return
      }

      if (statement.finished) {
        // This seat's own target is met. Wait to be named rather than burn turns
        // restating a settled conclusion.
        quiet.add(seat.id)
        unfinished.delete(seat.id)
        return
      }

      // A seat that explicitly said its part is not done is the one worth a paid
      // turn when the room later stalls. Read the raw reply: `readVerdict` only
      // surfaces `finished: true`, so it cannot tell "not yet" from "no opinion".
      const raw = statement.structured as { finished?: unknown } | undefined
      if (raw?.finished === false) {
        unfinished.add(seat.id)
      }

      // Hold the gate where the pool stood after this statement: the next turn
      // needs newer news than this one.
      gate.set(seat.id, pool.length)
    }
  }

  // Every seat enters its own loop at once. `Promise.all` settles only when all
  // loops have ended: by deadline, by failure, by abort, or by going quiet.
  await Promise.all(seats.map(async seat => runSeat(seat).catch((error) => {
    if (isAbortError(error)) {
      throw error
    }
    // A bug in one seat's loop must not silently lose the meeting; record it as
    // that seat's failure and let the rest of the table finish.
    land(emptyStatement(seat, 'failed', { error: describeError(error).text }))
    if (seat.seat.fallback === 'abort') {
      abortedBy = { seat: seat.id, error: describeError(error).text }
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

/**
 * The table's declared output, read back from this run's statements.
 *
 * Scanned newest-first and accumulated per key: a seat that fills one field late
 * is not overriding another field it never mentioned, and a later statement wins
 * for the same key — which is what "revised" means.
 *
 * A field nobody filled is simply absent. The caller decides whether a partial
 * result is usable; the engine does not invent values.
 */
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

function statementFromOutcome(seat: Seat, outcome: Parameters<typeof callSeat> extends never ? never : Awaited<ReturnType<typeof callSeat>>): Statement {
  if (!outcome.ok) {
    return emptyStatement(seat, 'failed', {
      content: outcome.content,
      error: outcome.error,
      durationMs: outcome.durationMs,
      model: outcome.model,
      usage: outcome.usage
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
    usage: outcome.usage
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
