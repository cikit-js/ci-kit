import type { LoadedRoundtable } from './config'
import type { BudgetState, PhaseRecord, RoundtableStatus, TextCaller } from './engine'
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
  // Oversized statement bodies land beside the record, not inside it.
  const writeArtifact = async (relativePath: string, content: string): Promise<number> => {
    const target = join(runDir, relativePath)
    await writeText(target, content)
    return new TextEncoder().encode(content).byteLength
  }

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
      writeArtifact,
      attempt,
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

export interface ResumeOptions extends Omit<RoundtableOptions, 'outDir'> {
  /** Run directory produced by a previous, interrupted execution. */
  runDir: string
}

/**
 * Continue an interrupted run from the phase that did not finish.
 *
 * Rules are fingerprinted: if a seat or the table changed, the previous
 * progress described a different meeting and cannot be resumed. That mirrors
 * "editing a prompt never rewrites an already-published draft".
 *
 * A run that already reached a terminal status is returned as-is rather than
 * re-executed: repeating a finished meeting would spend money to reach the same
 * answer.
 */
export async function resumeRoundtable(options: ResumeOptions): Promise<RoundtableResult> {
  const runDir = resolve(options.runDir)
  const loaded = await loadRoundtable({ configDir: options.configDir, schema: RECORD_SCHEMA })
  const state = await readState(runDir)
  if (!state) {
    throw new RoundtableConfigError(`No state.json in ${runDir}; nothing to resume`)
  }
  if (state.fingerprint !== loaded.fingerprint) {
    throw new RoundtableConfigError(
      'Rules changed since this run started; open a new meeting instead of resuming'
    )
  }

  const recordPath = join(runDir, 'record.json')
  const minutesPath = join(runDir, 'record.md')
  if (state.status !== 'running') {
    const existing = buildRecord(state, loaded)
    await writeJson(recordPath, existing)
    await writeText(minutesPath, renderRecordMarkdown(existing, loaded))
    return {
      status: existing.status,
      recordPath,
      runDir,
      record: existing,
      used: state.budget.used,
      budgetTotal: state.budget.total
    }
  }

  const context = state.context.length
    ? state.context
    : toContextList(options.context)
  const instructions = phaseInstructions(loaded, await readTableBody(options.configDir))
  const persist = () => writeJson(join(runDir, 'state.json'), state)
  const writeArtifact = async (relativePath: string, content: string): Promise<number> => {
    await writeText(join(runDir, relativePath), content)
    return new TextEncoder().encode(content).byteLength
  }

  // Start from the attempt that was interrupted; completed phases inside it are
  // re-read from state so a resume never repeats finished work.
  for (let attempt = state.rounds.length || 1; attempt <= loaded.table.maxAttempts; attempt++) {
    state.attempt = attempt
    options.onProgress?.(`roundtable: 续跑第 ${attempt} 轮`)

    const donePhases: PhaseRecord[] = state.rounds.find(round => round.attempt === attempt)?.phases ?? []
    // Resume at the first phase that has no completed record. A phase missing
    // from `donePhases` never finished, and a phase present but not completed
    // stopped midway; both must run. Everything before that is preserved.
    const startPhase: number = loaded.phases.findIndex((phase) => {
      const record = donePhases.find(item => item.id === phase.id)
      return !record || record.status !== 'completed'
    })
    if (startPhase === -1) {
      // Nothing left to run in this attempt; keep what we have.
      state.status = donePhases.some(phase => phase.judgement && !phase.judgement.passed)
        ? 'rejected'
        : 'passed'
      break
    }
    const startPhaseId: string | undefined = loaded.phases[startPhase]?.id
    const revisionNotes = collectRejectionNotes(
      { attempt: attempt - 1, phases: state.rounds.at(-1)?.phases ?? [] },
      loaded
    )

    const result = await runAttempt(attempt, {
      loaded,
      context,
      topic: state.topic ?? options.topic,
      env: options.env,
      budget: state.budget,
      phaseInstructions: instructions,
      revisionNotes,
      persist,
      callText: options.callText,
      writeArtifact,
      attempt,
      // Finished phases stay available as input for the resumed ones.
      completedPhases: donePhases.filter(phase => phase.status === 'completed'),
      events: {
        onStatement: (statement) => {
          const seat = loaded.byId.get(statement.seat)
          options.onProgress?.(`  ${seat?.identity.name ?? statement.seat} · ${statement.phase} · ${statement.status}`)
        },
        onPhaseStart: (phase) => {
          state.phaseId = phase.id
          state.phaseIndex = loaded.phases.findIndex(item => item.id === phase.id)
        }
      },
      startPhaseId
    })

    // Rebuild the round in table order so finished phases stay at their
    // position: a resumed attempt only produces the phases after the cut.
    const merged: PhaseRecord[] = loaded.phases.map((phase) => {
      const fresh = result.round.phases.find(item => item.id === phase.id)
      if (fresh) {
        return fresh
      }
      const previous = donePhases.find((item: PhaseRecord) => item.id === phase.id)
      return previous ?? { id: phase.id, status: 'skipped', statements: [] }
    })
    state.rounds = state.rounds.filter(round => round.attempt !== attempt)
      .concat({ attempt, phases: merged })

    if (result.stop) {
      state.status = 'aborted'
      state.error = result.stop === 'budget-exhausted'
        ? `预算在阶段 "${state.phaseId ?? ''}" 耗尽`
        : '有席位要求中止'
      break
    }

    const anyJudged = merged.some(phase => phase.judgement)
    const passed = anyJudged && merged.every(phase => !phase.judgement || phase.judgement.passed)
    if (anyJudged
      ? passed
      : merged.every(phase => phase.status === 'completed')) {
      state.status = 'passed'
      break
    }
    if (attempt === loaded.table.maxAttempts) {
      state.status = 'rejected'
      break
    }
    if (loaded.table.onVeto === 'abort') {
      state.status = 'aborted'
      state.error = '规则要求被否决即中止'
      break
    }
  }

  if (state.status === 'running') {
    state.status = 'rejected'
  }
  state.finishedAt = new Date().toISOString()
  state.resumable = false

  const record = buildRecord(state, loaded)
  await writeJson(join(runDir, 'state.json'), state)
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

async function readState(runDir: string): Promise<RunState | null> {
  const { readFile } = await import('node:fs/promises')
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf8')
    return JSON.parse(raw) as RunState
  }
  catch {
    return null
  }
}
