import type { LoadedRoundtable } from './config'
import type { BudgetState, RoundtableStatus, TextCaller } from './engine'
import type { RoundtableRecord, RunState } from './record'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultOutDir, loadRoundtable, RoundtableConfigError } from './config'
import { collectRejectionNotes, runAttempt } from './engine'
import { readFrontmatter } from './frontmatter'
import {
  buildRecord,
  makeRunId,
  RECORD_SCHEMA,
  renderRecordMarkdown,
  writeJson,
  writeText
} from './record'

export { checkRoundtable, defaultOutDir, loadRoundtable, RoundtableConfigError } from './config'
export type { LoadedRoundtable } from './config'
export type { BudgetState, PhaseRecord, RoundRecord, RoundtableStatus, TextCaller } from './engine'
export type { ArtifactRef, Statement, StatementStatus } from './prompt'
export { RECORD_SCHEMA as ROUNDTABLE_SCHEMA } from './record'
export type { RoundtableRecord, RunState } from './record'
export type { Seat, SeatIdentity, SeatOutput, SeatPersona, SeatPowers } from './seat'
export type { Phase, PhaseMode, Table } from './table'
export type { Judgement, Vote } from './verdict'

export interface RoundtableOptions {
  /** Directory holding `table.md` and `seats/` */
  configDir: string
  /** Material handed to the seats; the table never collects anything itself */
  context?: string | string[]
  /** Optional human override; seats normally propose their own agenda */
  topic?: string
  /** Where run directories are written */
  outDir?: string
  env?: NodeJS.ProcessEnv
  /** Emit one line per statement while the meeting runs. */
  onProgress?: (line: string) => void
  /** Defaults to `@ci-kit/ai`'s text(); tests pass a stub. */
  callText?: TextCaller
}

export interface RoundtableResult {
  status: RoundtableStatus
  recordPath: string
  /** Directory holding record.json, record.md, state.json. */
  runDir: string
  record: RoundtableRecord
  /** Total AI calls consumed. */
  used: number
  budgetTotal?: number
}

function toContextList(context: string | string[] | undefined): string[] {
  if (context === undefined || context === null) {
    return []
  }
  if (typeof context === 'string') {
    return context.trim()
      ? [context]
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

function initialBudget(loaded: LoadedRoundtable): BudgetState {
  const perSeatLimit: Record<string, number | undefined> = {}
  for (const seat of loaded.seats) {
    perSeatLimit[seat.id] = seat.seat.budget ?? loaded.table.budget.perSeat
  }
  return {
    total: loaded.table.budget.total,
    used: 0,
    perSeat: {},
    perSeatLimit
  }
}

/**
 * Body of `table.md` can carry phase-specific instructions. They are optional:
 * a table with no body uses the built-in phase hints.
 */
function phaseInstructions(loaded: LoadedRoundtable, tableBody: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!tableBody.trim()) {
    return result
  }
  const sections = tableBody.split(/^##\s+/m).slice(1)
  for (const section of sections) {
    const [head, ...rest] = section.split('\n')
    const id = head?.trim()
    if (id && loaded.phases.some(phase => phase.id === id)) {
      const text = rest.join('\n').trim()
      if (text) {
        result[id] = text
      }
    }
  }
  return result
}

async function readTableBody(configDir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(join(resolve(configDir), 'table.md'), 'utf8')
  return readFrontmatter(source, 'table.md').body
}

/**
 * Run one meeting.
 *
 * Business failure is reported through `status`, never thrown: a rejected
 * meeting is a normal result. Only configuration and usage errors throw,
 * because those mean nothing could start.
 */
export async function runRoundtable(options: RoundtableOptions): Promise<RoundtableResult> {
  const loaded = await loadRoundtable({ configDir: options.configDir, schema: RECORD_SCHEMA })
  const context = toContextList(options.context)
  const outDir = resolve(options.outDir ?? defaultOutDir())
  const runId = makeRunId()
  const runDir = join(outDir, runId)
  await mkdir(runDir, { recursive: true })

  // `running` is a transient state; the loop below always settles on a terminal
  // one before the record is written.
  const state: RunState = {
    schema: RECORD_SCHEMA,
    runId,
    status: 'running',
    attempt: 1,
    phaseIndex: 0,
    budget: initialBudget(loaded),
    fingerprint: loaded.fingerprint,
    resumable: true,
    rounds: [],
    startedAt: new Date().toISOString(),
    topic: options.topic,
    context
  }

  const statePath = join(runDir, 'state.json')
  const recordPath = join(runDir, 'record.json')
  const minutesPath = join(runDir, 'record.md')
  const persist = () => writeJson(statePath, state)

  let revisionNotes: string[] = []

  const instructions = phaseInstructions(loaded, await readTableBody(options.configDir))

  for (let attempt = 1; attempt <= loaded.table.maxAttempts; attempt++) {
    state.attempt = attempt
    options.onProgress?.(`roundtable: 第 ${attempt} 轮开始`)

    const result = await runAttempt(attempt, {
      loaded,
      context,
      topic: options.topic,
      env: options.env,
      budget: state.budget,
      phaseInstructions: instructions,
      revisionNotes,
      persist,
      callText: options.callText,
      events: {
        onStatement: (statement) => {
          const seat = loaded.byId.get(statement.seat)
          const name = seat?.identity.name ?? statement.seat
          options.onProgress?.(`  ${name} · ${statement.phase} · ${statement.status}`)
        },
        // Progress is positional only; the authoritative round data comes from
        // runAttempt's return value so a partially filled state can never leak
        // into the record.
        onPhaseStart: (phase) => {
          state.phaseId = phase.id
          state.phaseIndex = loaded.phases.findIndex(item => item.id === phase.id)
        },
        onPhaseEnd: () => {
          void persist()
        }
      }
    })

    state.rounds = state.rounds.filter(round => round.attempt !== attempt).concat(result.round)

    if (result.stop) {
      state.status = 'aborted'
      state.error = result.stop === 'budget-exhausted'
        ? `预算在阶段 "${state.phaseId ?? ''}" 耗尽`
        : '有席位要求中止'
      break
    }

    const passed = result.round.phases
      .filter(phase => phase.judgement)
      .every(phase => phase.judgement!.passed)
    const anyJudged = result.round.phases.some(phase => phase.judgement)

    // A meeting with no judgement anywhere is a production run: it succeeded
    // if every phase completed, otherwise it produced nothing usable.
    const completedAll = result.round.phases.every(phase => phase.status === 'completed')
    if (anyJudged ? passed : completedAll) {
      state.status = 'passed'
      break
    }

    revisionNotes = collectRejectionNotes(result.round, loaded)
    if (attempt === loaded.table.maxAttempts) {
      state.status = 'rejected'
      break
    }

    if (loaded.table.onVeto === 'abort') {
      state.status = 'aborted'
      state.error = '规则要求被否决即中止'
      break
    }
    // `revise` and `re-propose` both loop; the difference is which phase the
    // next attempt starts from, which the phase graph already encodes.
    options.onProgress?.(`roundtable: 第 ${attempt} 轮未通过，进入第 ${attempt + 1} 轮`)
  }

  if (state.status === 'running') {
    state.status = 'rejected'
  }

  state.finishedAt = new Date().toISOString()
  // Every run reaching this point is finished: resume paths reconstruct a new
  // run rather than continuing this one, so nothing here is resumable.
  state.resumable = false

  const record = buildRecord(state, loaded)
  await writeJson(statePath, state)
  await writeJson(recordPath, record)
  await writeText(minutesPath, renderRecordMarkdown(record, loaded))

  return {
    status: record.status,
    recordPath,
    runDir,
    record,
    used: state.budget.used,
    budgetTotal: state.budget.total
  }
}

export interface ResumeOptions extends RoundtableOptions {
  /** Run directory produced by a previous, interrupted execution. */
  runDir: string
}

/**
 * Continue an interrupted run.
 *
 * Rules are fingerprinted: if a seat or the table changed, the previous
 * progress described a different meeting and cannot be resumed. That mirrors
 * "editing a prompt never rewrites an already-published draft".
 */
export async function resumeRoundtable(_options: ResumeOptions): Promise<RoundtableResult> {
  throw new Error('resumeRoundtable is not implemented yet; start a new meeting instead')
}
