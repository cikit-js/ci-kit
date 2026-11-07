import type { LoadedRoundtable } from './config'
import type { RoundtableStatus, TextCaller } from './engine'
import type { Statement } from './prompt'
import type { AttemptState, RecordVerdict, RoundtableRecord, RunState } from './record'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultOutDir, loadRoundtable, RoundtableConfigError } from './config'
import { discuss, finalVotes, outputFrom } from './engine'
import { buildRecord, isoLocal, makeRunId, RECORD_SCHEMA, renderRecordMarkdown, writeJson, writeText } from './record'
import { judgeMeeting, readVerdict, vetoReason } from './verdict'

export { checkRoundtable, defaultOutDir, loadRoundtable, RoundtableConfigError } from './config'
export type { LoadedRoundtable } from './config'
export { ARTIFACT_THRESHOLD, discuss, estimateTokens, finalVotes, trimPool } from './engine'
export type { DiscussionResult, EngineOptions, RoundtableStatus, TextCaller, Usage } from './engine'
export { buildUserPrompt, FINISHED_INSTRUCTION, visibleStatements } from './prompt'
export type { ArtifactRef, Statement, StatementStatus } from './prompt'
export { RECORD_SCHEMA as ROUNDTABLE_SCHEMA } from './record'
export type { AttemptState, FinalStatus, RecordVerdict, RoundtableRecord, RunState } from './record'
export { renderSeatSystemPrompt, SEAT_DEFAULTS } from './seat'
export type { Fallback, Seat, SeatIdentity, SeatOutput, SeatPersona, SeatPowers } from './seat'
export { TABLE_DEFAULTS } from './table'
export type { OnVeto, Table } from './table'
export { judgeMeeting, readVerdict } from './verdict'
export type { Judgement, SeatVerdict, Vote } from './verdict'

export interface RoundtableOptions {
  /** Directory holding `table.md` and `seats/`. */
  configDir: string
  /** What this discussion must answer. Optional: the rule file may open it instead. */
  topic?: string
  /** Why the meeting was called. Optional. */
  brief?: string
  /** Material put on the table; a string is one item, an array is numbered in order. */
  context?: string | string[]
  /** Where run directories are written. Defaults to `<cwd>/roundtable-out`. */
  outDir?: string
  env?: NodeJS.ProcessEnv
  /** Emit one line per landed statement; the CLI sends these to stderr. */
  onProgress?: (line: string) => void
  /** Defaults to `@ci-kit/ai`'s text(); tests pass a stub. */
  callText?: TextCaller
  /**
   * Clock for the discussion deadline and for every timestamp written.
   *
   * Defaults to the real clock. Tests pass a stepping clock so a table can be
   * about behaviour instead of about waiting `durationMs` per discussion.
   */
  now?: () => number
}

export interface RoundtableResult {
  status: Exclude<RoundtableStatus, 'running'>
  recordPath: string
  /** Directory holding record.json, record.md, state.json. */
  runDir: string
  record: RoundtableRecord
  /** AI calls consumed by this run, including calls from earlier attempts. */
  used: number
}

/**
 * The question a meeting answers, when the caller supplies one.
 *
 * Optional on purpose: a table whose rule file says what to settle can open its
 * own question, and forcing the CLI to carry it would put the agenda in code
 * instead of in the configuration that the seats actually read.
 */
function readTopic(topic: string | undefined): string | undefined {
  return typeof topic === 'string' && topic.trim() !== ''
    ? topic.trim()
    : undefined
}

function toContextList(context: string | string[] | undefined): string[] {
  if (context === undefined || context === null) {
    return []
  }
  if (typeof context === 'string') {
    return context.trim()
      ? [
          context.trim()
        ]
      : []
  }
  if (!Array.isArray(context)) {
    throw new RoundtableConfigError('context must be a string or an array of strings')
  }
  return context.map((item, index) => {
    if (typeof item !== 'string') {
      throw new RoundtableConfigError(`context[${index}] must be a string`)
    }
    return item.trim()
  }).filter(Boolean)
}

/** Turn the finished pool into the meeting's verdict. */
function judgeAttempt(loaded: LoadedRoundtable, statements: Statement[]): RecordVerdict {
  const seats = loaded.seats.filter(seat => seat.enabled)
  // A meeting that declares output fields is judged by whether the room settled
  // them: its seats talk rather than ballot, so an empty ballot would read as a
  // rejection of a meeting that actually delivered.
  if (loaded.table.outputFields) {
    const output = outputFrom(statements, loaded.table.outputFields)
    if (output && Object.keys(output).length === Object.keys(loaded.table.outputFields).length) {
      return { passed: true, vetoed: [], score: 1 }
    }
  }
  const votes = finalVotes(seats, statements)
  const judgement = judgeMeeting(seats, votes, loaded.table)
  return {
    passed: judgement.passed,
    vetoed: judgement.vetoed,
    score: judgement.score
  }
}

/** The reason a statement states, from its JSON when it has one. */
function statedReason(statement: Statement): string {
  const parsed = readVerdict(statement.structured)
  const reason = vetoReason(parsed, parsed.verdict !== undefined
    ? ''
    : statement.content)
  if (reason) {
    return reason
  }
  // Nothing readable in a structured field: the raw text is still what the seat
  // said, and quoting it beats telling the next round "否决" with no detail.
  return parsed.verdict !== undefined
    ? statement.content.trim().slice(0, 200)
    : ''
}

/** Veto reasons from the last attempt, worded for the next one to read. */
function rejectionNotes(loaded: LoadedRoundtable, attempt: AttemptState | undefined): string[] {
  if (!attempt?.verdict) {
    return []
  }
  const notes: string[] = []
  const seen = new Set<string>()
  for (const seatId of [...attempt.verdict.vetoed]) {
    if (seen.has(seatId)) {
      continue
    }
    seen.add(seatId)
    const seat = loaded.byId.get(seatId)
    const label = seat
      ? `${seat.identity.name}（${seat.role}）`
      : seatId
    const statement = [...attempt.statements].reverse().find(item => item.seat === seatId && item.status === 'completed')
    notes.push(`${label}：${statement
      ? statedReason(statement) || '否决'
      : '否决'}`)
  }
  for (const statement of attempt.statements) {
    if (statement.status !== 'invalid-veto') {
      continue
    }
    const seat = loaded.byId.get(statement.seat)
    const label = seat
      ? `${seat.identity.name}（${seat.role}）`
      : statement.seat
    notes.push(`${label}：${statedReason(statement) || '未写理由'}（否决未写理由，未计入）`)
  }
  return notes
}

interface RunnerContext {
  loaded: LoadedRoundtable
  state: RunState
  runDir: string
  options: RoundtableOptions
  persist: () => Promise<void>
  writeArtifact: (relativePath: string, content: string) => Promise<number>
  /** Started-at in epoch ms for the deadline; a resume keeps the original. */
  startedAt: number
  /** Monotonic-enough clock for deadlines and timestamps. */
  now: () => number
  /** Timestamp for the record, written in the caller's zone. */
  stamp: () => string
}

async function writeOutputs(context: RunnerContext): Promise<RoundtableResult> {
  const { loaded, state, runDir } = context
  const record = buildRecord(state, loaded.table.title)
  const recordPath = join(runDir, 'record.json')
  await writeJson(join(runDir, 'state.json'), state)
  await writeJson(recordPath, record)
  await writeText(join(runDir, 'record.md'), renderRecordMarkdown(record, loaded.byId))
  return {
    status: record.status,
    recordPath,
    runDir,
    record,
    used: countCalls(state)
  }
}

function countCalls(state: RunState): number {
  return state.attempts.reduce((sum, attempt) => sum + attempt.statements.length, 0)
}

/**
 * Run attempts until the meeting passes, aborts, or runs out of attempts.
 *
 * `state` is mutated in place and persisted after every landed statement, which
 * is what makes a crash resumable: the pool on disk is the pool on the table.
 */
async function runLoop(context: RunnerContext, resumeFrom?: { pool: Statement[], startedAt: number }): Promise<RoundtableResult> {
  const { loaded, state, options } = context
  const table = loaded.table

  for (;;) {
    const attemptNumber = state.attempt
    const attemptStarted = resumeFrom?.startedAt ?? context.now()
    const startedAtIso = context.stamp()

    state.status = 'running'
    state.startedAt = state.startedAt || startedAtIso
    // A resumed attempt keeps its original clock, so the remaining time is what
    // is left, not a fresh `durationMs`.
    const attempt: AttemptState = {
      attempt: attemptNumber,
      startedAt: startedAtIso,
      statements: resumeFrom?.pool ?? []
    }
    state.attempts = state.attempts.filter(item => item.attempt !== attemptNumber)
    state.attempts.push(attempt)
    state.pool = attempt.statements

    // A fresh round carries the previous round's reasons; a resumed round reuses
    // what it was opened with, so the seats that speak after the crash still know
    // why the table met again.
    const notes = rejectionNotes(loaded, state.attempts.find(item => item.attempt === attemptNumber - 1))
    if (resumeFrom) {
      state.notes = state.notes ?? []
    }
    else {
      state.notes = notes
    }
    await context.persist()

    options.onProgress?.(`roundtable: 第 ${attemptNumber} 轮讨论开始`)

    let abortedBy: string | undefined
    try {
      const result = await discuss({
        loaded,
        topic: state.topic,
        brief: state.brief,
        context: state.context,
        env: options.env,
        priorPool: resumeFrom?.pool?.length
          ? [...resumeFrom.pool]
          : undefined,
        revisionNotes: state.notes?.length ? state.notes : undefined,
        startedAt: attemptStarted,
        attempt: attemptNumber,
        callText: options.callText,
        now: context.now,
        writeArtifact: context.writeArtifact,
        persist: context.persist,
        events: {
          onStatement: (statement) => {
            options.onProgress?.(`  ${statement.name} · ${statement.status}`)
          }
        }
      })
      // `discuss` already returns only what this run produced; the resumed pool
      // it was given is not part of `result.statements`. Slicing again here
      // would drop the first new line of every resumed discussion.
      attempt.statements.push(...result.statements)
      state.pool = attempt.statements
      // Kept on the state, not only in the statements: the record is written from
      // here, and the output is what a caller running this meeting wants.
      if (result.output) {
        state.output = result.output
      }
      state.usage.input += result.usage.input
      state.usage.output += result.usage.output
      abortedBy = result.abortedBy?.seat
      if (result.abortedBy) {
        state.error = `席位 ${result.abortedBy.seat} 失败并要求中止：${result.abortedBy.error}`
      }
    }
    catch (error) {
      if (error instanceof RoundtableConfigError) {
        throw error
      }
      state.status = 'failed'
      state.error = error instanceof Error
        ? error.message
        : String(error)
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    attempt.finishedAt = context.stamp()
    attempt.verdict = judgeAttempt(loaded, attempt.statements)
    attempt.aborted = abortedBy !== undefined
    await context.persist()

    resumeFrom = undefined

    if (attempt.aborted) {
      state.status = 'aborted'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    if (attempt.verdict.passed) {
      state.status = 'passed'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    // No statement and no vote from anyone: discussing further cannot change
    // that, so the meeting is over rather than retried `maxAttempts` times.
    const spoke = attempt.statements.some(statement => statement.status === 'completed')
    if (!spoke) {
      state.status = 'rejected'
      state.error = '没有任何席位完成发言'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    if (attemptNumber >= table.maxAttempts) {
      state.status = 'rejected'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    if (table.onVeto === 'abort') {
      state.status = 'aborted'
      state.error = '规则要求被否决即中止（onVeto: abort）'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    // `re-propose` and `revise` both open another discussion; the difference is
    // which veto reasons it may carry in, recorded in the attempt history.
    state.attempt = attemptNumber + 1
    options.onProgress?.(`roundtable: 第 ${attemptNumber} 轮未通过，进入第 ${attemptNumber + 1} 轮`)
  }
}

async function readState(runDir: string): Promise<RunState | null> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf8')
    const parsed = JSON.parse(raw) as RunState
    if (parsed && typeof parsed === 'object' && parsed.schema === RECORD_SCHEMA) {
      return parsed
    }
    return null
  }
  catch {
    return null
  }
}

/**
 * Run one meeting.
 *
 * Business failure is a status, never an exception: a rejected meeting is a
 * normal result and CI decides what to do with it. Only configuration and usage
 * errors throw, because those mean the meeting could not start at all.
 */
export async function runRoundtable(options: RoundtableOptions): Promise<RoundtableResult> {
  const topic = readTopic(options.topic)
  const now = options.now ?? (() => Date.now())
  const loaded = await loadRoundtable({ configDir: options.configDir })
  const context = toContextList(options.context)
  const outDir = resolve(options.outDir ?? defaultOutDir())
  const runId = makeRunId()
  const runDir = join(outDir, runId)
  await mkdir(runDir, { recursive: true })

  const state: RunState = {
    schema: RECORD_SCHEMA,
    runId,
    status: 'running',
    attempt: 1,
    startedAt: isoLocal(new Date(now())),
    topic,
    brief: options.brief?.trim() || undefined,
    context,
    pool: [],
    attempts: [],
    usage: { input: 0, output: 0 },
    fingerprint: loaded.fingerprint
  }

  const persist = async (): Promise<void> => {
    await writeJson(join(runDir, 'state.json'), state)
  }
  const writeArtifact = async (relativePath: string, content: string): Promise<number> => {
    await writeText(join(runDir, relativePath), content)
    return new TextEncoder().encode(content).byteLength
  }

  return runLoop({
    loaded,
    state,
    runDir,
    options: {
      ...options,
      topic
    },
    persist,
    writeArtifact,
    startedAt: now(),
    now,
    stamp: () => isoLocal(new Date(now()))
  })
}

export interface ResumeOptions extends Omit<RoundtableOptions, 'outDir' | 'topic'> {
  /** Run directory produced by a previous, interrupted execution. */
  runDir: string
  /** Needed only when `state.json` predates the topic field. */
  topic?: string
}

/**
 * Continue an interrupted discussion.
 *
 * The rules are fingerprinted: if a seat or the table changed, the progress on
 * disk describes a different meeting and cannot be resumed — that mirrors
 * "editing a prompt never rewrites an already-published draft".
 *
 * A run that already reached a terminal status is re-rendered from its state
 * rather than executed again: repeating a finished meeting would spend money to
 * reach the same answer.
 */
export async function resumeRoundtable(options: ResumeOptions): Promise<RoundtableResult> {
  const runDir = resolve(options.runDir)
  const now = options.now ?? (() => Date.now())
  const loaded = await loadRoundtable({ configDir: options.configDir })
  const state = await readState(runDir)
  if (!state) {
    throw new RoundtableConfigError(`No resumable state.json in ${runDir}`)
  }
  if (state.fingerprint !== loaded.fingerprint) {
    throw new RoundtableConfigError('Rules changed since this run started; open a new meeting instead of resuming')
  }
  if (!state.topic) {
    state.topic = readTopic(options.topic)
  }

  const persist = async (): Promise<void> => {
    await writeJson(join(runDir, 'state.json'), state)
  }
  const writeArtifact = async (relativePath: string, content: string): Promise<number> => {
    await writeText(join(runDir, relativePath), content)
    return new TextEncoder().encode(content).byteLength
  }

  const context: RunnerContext = {
    loaded,
    state,
    runDir,
    options: {
      ...options,
      configDir: options.configDir,
      topic: state.topic
    },
    persist,
    writeArtifact,
    // A resume keeps the original start for the deadline, but a finished run is
    // re-rendered with the caller's clock, so nothing waits on wall time again.
    startedAt: Date.parse(state.startedAt) || now(),
    now,
    stamp: () => isoLocal(new Date(now()))
  }

  // A finished meeting is re-rendered, never re-run.
  if (state.status !== 'running') {
    if (!state.finishedAt) {
      state.finishedAt = context.stamp()
    }
    return writeOutputs(context)
  }

  // The interrupted attempt is re-opened, not restarted: its statements are
  // already on the table, and its remaining time is what is left of
  // `durationMs` from the original start.
  const elapsed = context.now() - context.startedAt
  const remaining = loaded.table.durationMs - elapsed
  if (remaining <= 0) {
    options.onProgress?.('roundtable: 剩余时间为 0，直接进入裁决')
    const attempt = state.attempts.find(item => item.attempt === state.attempt)
    if (attempt) {
      attempt.statements = state.pool
      attempt.finishedAt = context.stamp()
      attempt.verdict = judgeAttempt(loaded, attempt.statements)
      state.status = attempt.verdict.passed
        ? 'passed'
        : 'rejected'
      state.finishedAt = context.stamp()
    }
    else {
      state.status = 'failed'
      state.error = '没有可续跑的轮次'
      state.finishedAt = context.stamp()
    }
    return writeOutputs(context)
  }

  options.onProgress?.(`roundtable: 续跑第 ${state.attempt} 轮，剩余 ${Math.ceil(remaining / 1000)} 秒`)
  // Re-open the attempt with its own clock rather than a fresh one, so the
  // deadline is "startedAt + durationMs" exactly once.
  return runLoop(context, {
    pool: state.pool ?? [],
    startedAt: context.startedAt
  })
}

/** Convenience for callers that only want a validity answer. */
export async function validateRoundtable(options: { configDir: string }): Promise<{ ok: true } | { ok: false, message: string }> {
  try {
    await loadRoundtable(options)
    return { ok: true }
  }
  catch (error) {
    return {
      ok: false,
      message: error instanceof Error
        ? error.message
        : String(error)
    }
  }
}
