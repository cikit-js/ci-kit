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
  topic: string
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
   * The host's closing plan, when the meeting was deciding what to write.
   *
   * Absent means nobody closed the meeting with a usable plan — a host that
   * never spoke, or spoke without filling the plan fields. The caller decides
   * what to do about it; the engine does not invent a plan.
   */
  plan?: DiscussionPlan
}

/**
 * What a planning meeting has to settle before anyone writes.
 *
 * Settled in two stages inside one meeting: the title first, then the rest. A
 * plan with `title` alone means stage one is done and the meeting continues; a
 * plan with everything means the meeting is over.
 */
export interface DiscussionPlan {
  title: string
  /** Absent until the second stage closes. */
  angle?: string
  audience?: string
  outline?: string
  /** The seat whose closing statement produced this plan. */
  by: string
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
 * The role that closes a planning meeting.
 *
 * Matching on the role rather than on a config flag keeps the seam where a
 * project already declares it: the seat that sums up is the seat whose `role`
 * says so.
 */
export const CLOSING_ROLE = '主持'

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
   * The host may be unparked from a wait at most once per stage, so a host that
   * answers with nothing cannot keep the meeting spinning.
   */
  const gateBoosted = new Set<string>()

  /** True when no live seat is able to speak without someone else moving first. */
  const stalled = (): boolean => {
    const live = seats.filter(seat => !gone.has(seat.id) && !quiet.has(seat.id))
    return live.length > 0 && live.every(seat => waiting.has(seat.id))
  }

  /**
   * The seat that closes a planning meeting, by role.
   *
   * Only a planning table has one; a review table ends on votes and needs no
   * closing statement.
   */
  const closingSeat = seats.find(seat => seat.role === CLOSING_ROLE)

  /** Statements this run has landed, excluding whatever came in with the pool. */
  const freshStatements = (): Statement[] => pool.slice(options.priorPool?.length ?? 0)

  /**
   * Which stage the meeting is in right now.
   *
   * There is no separate switch to keep in sync: the stage is whatever the pool
   * says has been settled. Title undecided means stage one; title decided but no
   * angle means stage two.
   */
  const currentStage = (): 'title' | 'body' | undefined => {
    if (!closingSeat) {
      return undefined
    }
    const settled = planFrom(freshStatements())
    if (!settled) {
      return 'title'
    }
    return settled.angle ? undefined : 'body'
  }

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
          // Everyone waiting means nobody can break the tie. Two ways out.
          //
          // Stage one can still be closed by the host while everyone else waits:
          // that is the whole point of a host, and it is the normal way a title
          // gets settled. Mark the host's gate stale so its own loop stops
          // waiting and takes the closing turn; the other seats then return and
          // the closing turns at the end cover whatever is left.
          if (stalled() && closingSeat && currentStage() !== undefined && !gateBoosted.has(closingSeat.id)) {
            gateBoosted.add(closingSeat.id)
            gate.delete(closingSeat.id)
            waiting.delete(seat.id)
            continue
          }
          if (stalled() || now() >= deadline || Date.now() - waitingSince >= MAX_IDLE_MS) {
            waiting.delete(seat.id)
            return
          }
          continue
        }
        // The room moved; fall through and speak, and stop counting as waiting.
        waiting.delete(seat.id)
        idleSince = undefined
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
        askDone: seat.seat.output === 'json',
        // Whichever stage the meeting is in decides what this turn is asked to
        // settle. Read fresh each turn: the host may have closed stage one while
        // this seat was waiting.
        stage: currentStage(),
        settledTitle: planFrom(freshStatements())?.title
      })

      let outcome = await callSeat(seat, prompt, {
        env: options.env,
        callText: options.callText,
        now: options.now,
        reasoningEffort: effort
      })
      if (!outcome.ok && seat.seat.fallback === 'retry' && outcome.retryable && now() < deadline) {
        await sleep(RETRY_BACKOFF_MS)
        if (now() < deadline && !stopped) {
          outcome = await callSeat(seat, prompt, {
            env: options.env,
            callText: options.callText,
            now: options.now,
            reasoningEffort: effort
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

      if (statement.done) {
        // Nothing left to argue. Wait to be named rather than burn turns
        // restating a settled conclusion.
        quiet.add(seat.id)
        return
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

  // A planning meeting that talked itself out without settling gets a closing turn
  // from the host, on its own. The concurrent loops cannot do this: by the time
  // everyone is done, the host's loop has already exited, and a seat cannot be
  // woken from outside the loop it left.
  //
  // Two stages, in order: the title first, then the body. Each stage gets at most
  // one closing turn, so a host that keeps failing cannot burn the budget.
  if (closingSeat && !stopped) {
    for (const stage of ['title', 'body'] as const) {
      if (stopped || now() >= deadline) {
        break
      }
      const settled = planFrom(freshStatements())
      if (stage === 'title' && settled) {
        // Stage one already closed during the discussion itself.
        continue
      }
      if (stage === 'body' && settled?.angle) {
        break
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
        askDone: closingSeat.seat.output === 'json',
        stage,
        settledTitle: settled?.title
      })

      let outcome = await callSeat(closingSeat, prompt, {
        env: options.env,
        callText: options.callText,
        now: options.now,
        reasoningEffort: effort
      })
      if (!outcome.ok && closingSeat.seat.fallback === 'retry' && outcome.retryable && now() < deadline) {
        await sleep(RETRY_BACKOFF_MS)
        if (now() < deadline && !stopped) {
          outcome = await callSeat(closingSeat, prompt, {
            env: options.env,
            callText: options.callText,
            now: options.now,
            reasoningEffort: effort
          })
        }
      }
      if (outcome.usage) {
        usage.input += outcome.usage.input
        usage.output += outcome.usage.output
      }
      land(statementFromOutcome(closingSeat, outcome))
      await options.persist?.()

      // A closing turn that produced nothing ends the meeting: asking the same
      // host a third time is unlikely to go better, and the caller falls back.
      if (stage === 'title' && planFrom(freshStatements()) === undefined) {
        break
      }
    }
  }

  return {
    statements: freshStatements(),
    abortedBy,
    usage,
    // The plan is read from this run's statements only: a resumed meeting that
    // closed nothing must not inherit the plan of the meeting it continues.
    plan: planFrom(freshStatements())
  }
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
  const spoken = parsed.say
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
    say: spoken,
    durationMs: outcome.durationMs,
    model: outcome.model,
    usage: outcome.usage
  }
  if (seat.seat.output === 'json') {
    if (parsed.verdict !== undefined) {
      statement.verdict = parsed.verdict
    }
    statement.structured = outcome.structured
    statement.done = parsed.done === true
    // A veto with no reason is recorded as such and does not count. It stays
    // `completed` for reading purposes, but the status says what happened.
    if (parsed.verdict === 'reject' && seat.seat.canVeto && vetoReason(parsed, outcome.content).length === 0) {
      statement.status = 'invalid-veto'
    }
  }
  return statement
}

/**
 * The plan a meeting closed with, read back from its statements.
 *
 * Scanned backwards with the fields accumulated: a planning meeting settles the
 * title in one closing turn and the body in a later one, so the newest statement
 * alone usually carries only half of it. Newest wins per field — a later turn
 * overrides an earlier one for the same key, which is what "revised" means.
 *
 * A statement that only talks about the topic contributes nothing: without a
 * title somewhere in the record there is no plan to write from.
 */
export function planFrom(statements: Statement[]): DiscussionPlan | undefined {
  let title: string | undefined
  let angle: string | undefined
  let audience: string | undefined
  let outline: string | undefined
  let by: string | undefined

  for (let index = statements.length - 1; index >= 0; index--) {
    const statement = statements[index]!
    if (statement.status !== 'completed') {
      continue
    }
    const parsed = readVerdict(statement.structured)
    const contributed = parsed.title !== undefined || parsed.angle !== undefined
    title ??= parsed.title
    angle ??= parsed.angle
    audience ??= parsed.audience
    outline ??= parsed.outline
    if (contributed) {
      by ??= statement.seat
    }
  }

  if (title === undefined) {
    return undefined
  }
  return {
    title,
    angle,
    audience,
    outline,
    by: by ?? ''
  }
}
