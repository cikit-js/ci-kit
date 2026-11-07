import type { LoadedRoundtable } from './config'
import type { ArtifactRef, Statement } from './prompt'
import type { Seat } from './seat'
import type { Vote } from './verdict'
import { text as aiText, isAiError } from '@ci-kit/ai'
import { buildUserPrompt, verdictInstruction, visibleStatements } from './prompt'
import { renderSeatSystemPrompt } from './seat'
import { readVerdict, vetoReason } from './verdict'

/** Same status set as the record; `running` never reaches disk as a final value. */
export type RoundtableStatus = 'running' | 'passed' | 'rejected' | 'aborted' | 'failed'

/** The AI call the engine depends on; injectable so discussions can be tested offline. */
export type TextCaller = typeof aiText

/**
 * Above this length a statement's body is written to `artifacts/` instead of
 * being inlined in `record.json`.
 *
 * The record stays a compact index of what happened; a long draft belongs in its
 * own file that a later step can read, diff or publish without parsing a
 * megabyte of JSON.
 */
export const ARTIFACT_THRESHOLD = 8_000

/** Rough token estimate used for the pool cap, `maxPoolTokens`. */
export function estimateTokens(content: string): number {
  // CJK ideographs are about one token each; everything else clusters around four
  // characters per token. Counting both keeps the estimate honest for mixed text.
  const cjk = (content.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length
  const rest = content.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/**
 * Keep the newest entries that fit in `maxPoolTokens`.
 *
 * Trimming from the front is deliberate: an old statement is the one the meeting
 * has already reacted to, and the cost of forgetting is "long talks lose their
 * opening" — bounded and predictable — instead of "the meeting stops".
 */
export function trimPool(pool: Statement[], maxPoolTokens: number): { kept: Statement[], dropped: number } {
  let total = 0
  let firstKept = pool.length
  // Walk backwards so the most recent statements are always kept, even when a
  // single long one exceeds the cap on its own.
  for (let index = pool.length - 1; index >= 0; index--) {
    const cost = estimateTokens(pool[index]!.content)
    if (total + cost > maxPoolTokens && firstKept !== pool.length) {
      break
    }
    total += cost
    firstKept = index
  }
  return {
    kept: pool.slice(firstKept),
    dropped: firstKept
  }
}

export interface Usage {
  input: number
  output: number
}

export interface EngineEvents {
  /** One line per finished call, for CLI progress on stderr. */
  onStatement?: (statement: Statement) => void
}

export interface EngineOptions {
  loaded: LoadedRoundtable
  topic: string
  brief?: string
  /** Initial material, already normalized to a list and in the caller's order. */
  context: string[]
  env?: NodeJS.ProcessEnv
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
  /** Defaults to `@ci-kit/ai`'s text(); tests pass a stub. */
  callText?: TextCaller
  /** Attempt number, so artifacts from a retry never overwrite the previous one. */
  attempt?: number
  /** Write oversized statement bodies under `artifacts/`, returning the byte count. */
  writeArtifact?: (relativePath: string, content: string) => Promise<number>
  events?: EngineEvents
  /** Injection point for tests: identity time source, monotonic enough for a deadline. */
  now?: () => number
  /** Injection point for tests: sleep between a `retry` seat's attempts. */
  sleep?: (ms: number) => Promise<void>
}

export interface DiscussionResult {
  /** Everything that landed in the pool this run, in landing order. */
  statements: Statement[]
  /** Set when a seat with `fallback: abort` failed and ended the meeting. */
  abortedBy?: { seat: string, error: string }
  usage: Usage
}

interface CallOutcome {
  ok: boolean
  content: string
  structured?: unknown
  error?: string
  kind?: string
  fatal: boolean
  retryable: boolean
  model?: string
  usage?: Usage
  durationMs: number
}

/** Kinds that may succeed later without changing anything, per the contract. */
const RETRYABLE_KINDS = new Set(['quota', 'server', 'network'])

/** Wait between a `retry` seat's first and second attempt, in ms. */
export const RETRY_BACKOFF_MS = 500

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function describeError(error: unknown): { text: string, kind?: string, retryable: boolean } {
  if (isAiError(error)) {
    return {
      // `describe()` is the log-safe line; provider bodies can echo the prompt.
      text: error.describe(),
      kind: error.kind,
      retryable: error.retryable
    }
  }
  if (error instanceof Error) {
    return { text: error.message, retryable: false }
  }
  return {
    text: String(error),
    retryable: false
  }
}

/**
 * One AI call for a seat.
 *
 * `retries` is left to the transport only when the seat asked for `retry`:
 * a paid call that may have already completed must not be re-sent blindly, and
 * a seat that wants another go states it in its own config.
 */
async function callSeat(seat: Seat, prompt: string, options: EngineOptions): Promise<CallOutcome> {
  const started = options.now?.() ?? Date.now()
  const wantJson = seat.seat.output === 'json'
  const call = options.callText ?? aiText
  try {
    const result = await call({
      prompt: wantJson
        ? `${prompt}\n\n${verdictInstruction(seat)}`
        : prompt,
      system: renderSeatSystemPrompt(seat),
      json: wantJson,
      maxTokens: seat.seat.maxTokens,
      retries: seat.seat.fallback === 'retry'
        ? undefined
        : 0,
      env: options.env
    })
    let structured: unknown
    if (wantJson) {
      try {
        structured = JSON.parse(result.value)
      }
      catch {
        return {
          ok: false,
          content: result.value,
          model: result.model,
          usage: result.usage,
          durationMs: (options.now?.() ?? Date.now()) - started,
          error: 'output: seat returned invalid JSON',
          kind: 'output',
          fatal: false,
          // A paid call that produced unparseable text is not retried.
          retryable: false
        }
      }
    }
    return {
      ok: true,
      content: result.value,
      structured,
      model: result.model,
      usage: result.usage,
      durationMs: (options.now?.() ?? Date.now()) - started,
      fatal: false,
      retryable: false
    }
  }
  catch (error) {
    const described = describeError(error)
    return {
      ok: false,
      content: '',
      durationMs: (options.now?.() ?? Date.now()) - started,
      error: described.text,
      kind: described.kind,
      fatal: seat.seat.fallback === 'abort',
      retryable: described.kind !== undefined && RETRYABLE_KINDS.has(described.kind) && described.retryable
    }
  }
}

function emptyStatement(
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

/** The structured verdict a seat cast, if any. */
export function voteOf(seat: Seat, statement: Statement): Vote | undefined {
  if (seat.seat.output !== 'json' || statement.verdict === undefined) {
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

function statementFromOutcome(
  seat: Seat,
  outcome: CallOutcome
): Statement {
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
  const statement: Statement = {
    seat: seat.id,
    name: seat.identity.name,
    role: seat.role,
    at: new Date().toISOString(),
    status: 'completed',
    content: outcome.content,
    durationMs: outcome.durationMs,
    model: outcome.model,
    usage: outcome.usage
  }
  if (seat.seat.output === 'json') {
    if (parsed.verdict !== undefined) {
      statement.verdict = parsed.verdict
    }
    statement.structured = outcome.structured
    // A veto with no reason is recorded as such and does not count. It stays
    // `completed` for reading purposes, but the status says what happened.
    if (parsed.verdict === 'reject' && seat.seat.canVeto && vetoReason(parsed, outcome.content).length === 0) {
      statement.status = 'invalid-veto'
    }
  }
  return statement
}

/**
 * Run one discussion: every seat talks in its own loop until the deadline.
 *
 * There is no round, no phase and no barrier. Each seat takes a fresh snapshot of
 * the pool, adds one statement, and immediately starts over; whoever speaks first
 * is simply whoever returned first, which is what a real table sounds like.
 */
export async function discuss(options: EngineOptions): Promise<DiscussionResult> {
  const { loaded } = options
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const seats = loaded.seats.filter(seat => seat.enabled)
  const startedAt = options.startedAt ?? now()
  const deadline = startedAt + loaded.table.durationMs

  const pool: Statement[] = [
    ...(options.priorPool ?? [])
  ]
  const usage: Usage = { input: 0, output: 0 }
  let abortedBy: DiscussionResult['abortedBy']
  let stopped = false

  const land = (statement: Statement): void => {
    pool.push(statement)
    options.events?.onStatement?.(statement)
  }

  const runSeat = async (seat: Seat): Promise<void> => {
    while (!stopped) {
      if (now() >= deadline) {
        // Deadline reached: no new request is started. Requests already in
        // flight elsewhere still finish and are billed, so they land.
        return
      }

      const snapshot = trimPool(pool, loaded.table.maxPoolTokens)
      const visible = visibleStatements(seat, snapshot.kept)
      const prompt = buildUserPrompt({
        topic: options.topic,
        brief: options.brief,
        context: options.context,
        visible,
        dropped: snapshot.dropped,
        revisionNotes: (options.attempt ?? 1) === 1
          ? options.openingNotes ?? options.revisionNotes
          : options.revisionNotes
      })

      let outcome = await callSeat(seat, prompt, options)
      if (!outcome.ok && seat.seat.fallback === 'retry' && outcome.retryable && now() < deadline) {
        await sleep(RETRY_BACKOFF_MS)
        if (now() < deadline && !stopped) {
          outcome = await callSeat(seat, prompt, options)
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
      await options.persist?.()

      if (!outcome.ok) {
        // 失败即该席位停止发言：`skip` 记一次缺席并让其他人继续；`retry` 已
        // 用尽重试；`abort` 终止整场会。
        if (seat.seat.fallback === 'abort') {
          abortedBy = { seat: seat.id, error: outcome.error ?? 'seat failed' }
          stopped = true
        }
        return
      }
    }
  }

  // Every seat enters its own loop at once. `Promise.all` settles only when all
  // loops have ended, either by deadline, by failure, or by an abort.
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
    statements: pool.slice(options.priorPool?.length ?? 0),
    abortedBy,
    usage
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
