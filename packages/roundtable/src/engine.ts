import type { LoadedRoundtable } from './config'
import type { ArtifactRef, Statement, StatementStatus } from './prompt'
import type { Seat } from './seat'
import type { Phase } from './table'
import type { Judgement, Vote } from './verdict'
import { text as aiText, isAiError } from '@ci-kit/ai'
import { buildUserPrompt, defaultPhaseInstruction, visibleStatements } from './prompt'
import { renderSeatSystemPrompt } from './seat'
import { judgePhase } from './verdict'

export type RoundtableStatus = 'running' | 'passed' | 'rejected' | 'aborted' | 'failed'
export type PhaseStatus = 'completed' | 'skipped' | 'failed' | 'budget-exhausted'

export interface PhaseRecord {
  id: string
  status: PhaseStatus
  statements: Statement[]
  judgement?: Judgement
  /** True when a completed phase had no input from its dependencies. */
  pruned?: boolean
}

export interface RoundRecord {
  attempt: number
  phases: PhaseRecord[]
}

export interface BudgetState {
  total?: number
  used: number
  perSeat: Record<string, number>
  perSeatLimit: Record<string, number | undefined>
}

export interface EngineEvents {
  onStatement?: (statement: Statement) => void
  onPhaseStart?: (phase: Phase, attempt: number) => void
  onPhaseEnd?: (phase: Phase, record: PhaseRecord, attempt: number) => void
  onAttempt?: (attempt: number, judgement: Judgement | undefined) => void
}

/** The AI call the engine depends on; injectable so meetings can be tested offline. */
export type TextCaller = typeof aiText

/**
 * Above this length a statement's body is written to `artifacts/` instead of
 * being inlined in `record.json`.
 *
 * The record stays a compact index of what happened; a long draft belongs in
 * its own file that a later step can read, diff or publish without parsing a
 * megabyte of JSON.
 */
export const ARTIFACT_THRESHOLD = 8_000

export interface EngineOptions {
  loaded: LoadedRoundtable
  /** Initial material, already normalized to a list. */
  context: string[]
  /** Optional human topic override. */
  topic?: string
  env?: NodeJS.ProcessEnv
  budget: BudgetState
  /** Per-phase instruction overrides from the table body, keyed by phase id. */
  phaseInstructions?: Record<string, string>
  events?: EngineEvents
  /** Persist progress; called after every phase and every call. */
  persist?: () => Promise<void>
  /** Defaults to `@ci-kit/ai`'s text(); tests pass a stub. */
  callText?: TextCaller
  /**
   * Write oversized statement bodies under `artifacts/`. Receives the relative
   * path and content, returns the byte count for the recorded reference.
   * Without this, long bodies stay inline in the record.
   */
  writeArtifact?: (relativePath: string, content: string) => Promise<number>
  /** Attempt number, used to keep artifact names unique across attempts. */
  attempt?: number
}

export interface AttemptResult {
  round: RoundRecord
  judgement: Judgement | undefined
  /** Set when the meeting must stop (abort or budget exhaustion). */
  stop?: 'aborted' | 'budget-exhausted'
}

export interface AttemptOptions extends EngineOptions {
  /** Veto reasons from the previous attempt, fed to the propose phase. */
  revisionNotes?: string[]
  /** Resume this attempt at the given phase instead of the first one. */
  startPhaseId?: string
  /**
   * Records of phases that already finished before an interruption. They are
   * treated as produced input so downstream phases are not pruned, and their
   * statements stay visible to seats that allow it.
   */
  completedPhases?: PhaseRecord[]
}

function remainingTotal(budget: BudgetState): number {
  if (budget.total === undefined) {
    return Number.POSITIVE_INFINITY
  }
  return budget.total - budget.used
}

function seatLimit(seat: Seat, budget: BudgetState): number | undefined {
  return seat.seat.budget ?? budget.perSeatLimit[seat.id]
}

function canSpend(seat: Seat, budget: BudgetState): boolean {
  if (remainingTotal(budget) <= 0) {
    return false
  }
  const limit = seatLimit(seat, budget)
  if (limit === undefined) {
    return true
  }
  return (budget.perSeat[seat.id] ?? 0) < limit
}

function spend(seatId: string, budget: BudgetState): void {
  budget.used += 1
  budget.perSeat[seatId] = (budget.perSeat[seatId] ?? 0) + 1
}

/** One AI call for a seat, tracked and classified. */
interface CallResult {
  ok: boolean
  content: string
  structured?: unknown
  model?: string
  usage?: { input: number, output: number }
  durationMs: number
  error?: string
  /** True when the failure must stop the whole meeting. */
  fatal?: boolean
}

async function callSeat(seat: Seat, prompt: string, options: EngineOptions): Promise<CallResult> {
  const started = Date.now()
  const wantJson = seat.seat.output === 'json'
  const call = options.callText ?? aiText
  try {
    const result = await call({
      prompt,
      system: renderSeatSystemPrompt(seat),
      json: wantJson,
      temperature: seat.seat.temperature,
      maxTokens: seat.seat.maxTokens,
      // Paid, non-idempotent: never resend after an unknown outcome.
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
          durationMs: Date.now() - started,
          error: 'output: seat returned invalid JSON'
        }
      }
    }
    return {
      ok: true,
      content: result.value,
      structured,
      model: result.model,
      usage: result.usage,
      durationMs: Date.now() - started
    }
  }
  catch (error) {
    const describe = isAiError(error)
      ? error.describe()
      : error instanceof Error
        ? error.message
        : String(error)
    // A timeout after the provider accepted the request is deliberately not
    // retried; ai() already models that as non-retryable.
    return {
      ok: false,
      content: '',
      durationMs: Date.now() - started,
      error: describe
    }
  }
}

function emptyStatement(seat: Seat, phaseId: string, status: StatementStatus, extra?: Partial<Statement>): Statement {
  return {
    seat: seat.id,
    name: seat.identity.name,
    role: seat.role,
    phase: phaseId,
    status,
    content: '',
    ...extra
  }
}

/** Run every seat of one phase and return its record. */
async function runPhase(
  phase: Phase,
  attempt: number,
  options: EngineOptions,
  priorStatements: Statement[],
  revisionNotes: string[],
  dependenciesProduced: boolean
): Promise<{ record: PhaseRecord, stop?: 'aborted' | 'budget-exhausted' }> {
  const { loaded, budget, events } = options
  const seats = phase.seats.map(id => loaded.byId.get(id)).filter((seat): seat is Seat => Boolean(seat))
  const leadIds = new Set(loaded.seats.filter(seat => seat.seat.lead).map(seat => seat.id))

  // `requires` prunes a phase whose inputs never materialized. That is the
  // phase-level counterpart to a seat's `fallback`.
  if (!dependenciesProduced) {
    return {
      record: {
        id: phase.id,
        status: 'skipped',
        statements: [],
        pruned: true
      }
    }
  }

  events?.onPhaseStart?.(phase, attempt)

  const instruction = options.phaseInstructions?.[phase.id] ?? defaultPhaseInstruction(phase.id)
  const statements: Statement[] = []
  const votes: Vote[] = []
  let stop: 'aborted' | 'budget-exhausted' | undefined

  const runSeat = async (seat: Seat): Promise<void> => {
    if (!canSpend(seat, budget)) {
      statements.push(emptyStatement(seat, phase.id, 'budget-exhausted'))
      return
    }

    // Visibility is resolved against what already happened, so serial phases
    // let later seats answer earlier ones while parallel phases see nothing
    // from the same phase.
    const visible = visibleStatements(seat, priorStatements.concat(statements), leadIds)
    const prompt = buildUserPrompt({
      phaseId: phase.id,
      topic: options.topic,
      context: options.context,
      visible,
      revisionNotes,
      phaseInstruction: instruction
    })

    spend(seat.id, budget)
    await options.persist?.()
    const call = await callSeat(seat, prompt, options)

    if (!call.ok) {
      const status: StatementStatus = 'failed'
      statements.push(emptyStatement(seat, phase.id, status, {
        content: call.content,
        error: call.error,
        durationMs: call.durationMs,
        model: call.model,
        usage: call.usage
      }))
      if (seat.seat.fallback === 'abort') {
        stop = 'aborted'
      }
      return
    }

    const statement: Statement = {
      seat: seat.id,
      name: seat.identity.name,
      role: seat.role,
      phase: phase.id,
      status: 'completed',
      content: call.content,
      structured: call.structured,
      durationMs: call.durationMs,
      model: call.model,
      usage: call.usage
    }

    // A long body belongs in its own file: the record stays a compact index,
    // and the artifact is named per attempt so a retry never overwrites the
    // previous one — old output is evidence for review.
    if (options.writeArtifact && call.content.length > ARTIFACT_THRESHOLD) {
      const attempt = options.attempt ?? 1
      const relative = `artifacts/attempt-${attempt}-${seat.id}-${phase.id}.md`
      const bytes = await options.writeArtifact(relative, call.content)
      statement.artifacts = [
        { path: relative, bytes }
      ]
    }

    statements.push(statement)
    events?.onStatement?.(statement)

    // Only vetoable phases collect votes; elsewhere the meeting is expected to
    // produce something rather than to decide something.
    if (phase.vetoable) {
      const verdict = readJudgement(call.structured, call.content)
      const vote: Vote = {
        seatId: seat.id,
        weight: seat.seat.weight,
        vote: verdict.verdict,
        veto: verdict.veto,
        hasReason: verdict.hasReason
      }
      if (verdict.invalidVeto) {
        statement.status = 'invalid-veto'
      }
      votes.push(vote)
    }
  }

  if (phase.mode === 'parallel') {
    await Promise.all(seats.map(async seat => runSeat(seat)))
  }
  else {
    for (const seat of seats) {
      await runSeat(seat)
      if (stop) {
        break
      }
    }
  }

  if (stop) {
    return {
      record: { id: phase.id, status: 'failed', statements },
      stop
    }
  }

  const judgement = phase.vetoable
    ? judgePhase(phase, seats, votes, loaded.table)
    : undefined
  const exhausted = statements.some(statement => statement.status === 'budget-exhausted')
  const completed = statements.some(statement => statement.status === 'completed')
  const status: PhaseStatus = exhausted && !completed
    ? 'budget-exhausted'
    : completed
      ? 'completed'
      : 'failed'

  const record: PhaseRecord = {
    id: phase.id,
    status,
    statements,
    judgement
  }
  events?.onPhaseEnd?.(phase, record, attempt)
  return {
    record,
    stop: exhausted && !completed
      ? 'budget-exhausted'
      : undefined
  }
}

/**
 * Read a seat's judgement from structured output, falling back to plain text.
 *
 * A seat with `output: text` can still vote: its content may start with a
 * leading `否决`/`通过` marker. Anything else is treated as no vote at all,
 * which is safer than inferring a decision from prose.
 */
function readJudgement(structured: unknown, content: string): {
  verdict?: 'pass' | 'reject'
  veto?: boolean
  hasReason?: boolean
  invalidVeto?: boolean
} {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const source = structured as Record<string, unknown>
    const verdict = source.verdict === 'pass' || source.verdict === 'reject'
      ? source.verdict
      : undefined
    const reason = typeof source.reason === 'string'
      ? source.reason.trim()
      : ''
    const veto = verdict === 'reject'
    return {
      verdict,
      veto,
      hasReason: reason.length > 0,
      invalidVeto: veto && reason.length === 0
    }
  }

  const head = content.trim().slice(0, 40)
  if (/^(?:否决|不通过|reject)/i.test(head)) {
    const reason = content.trim().slice(head.length).replace(/^[：:\s]+/, '').trim()
    return {
      verdict: 'reject',
      veto: true,
      hasReason: reason.length > 0,
      invalidVeto: reason.length === 0
    }
  }
  if (/^(?:通过|approve|pass)\b/i.test(head)) {
    return { verdict: 'pass', veto: false }
  }
  return {}
}

/** Run one attempt: every phase in order, stopping early when told to. */
export async function runAttempt(
  attempt: number,
  options: AttemptOptions
): Promise<AttemptResult> {
  const { loaded, events } = options
  const phases: PhaseRecord[] = []
  let stop: 'aborted' | 'budget-exhausted' | undefined
  let judgement: Judgement | undefined

  const startIndex = options.startPhaseId
    ? Math.max(0, loaded.phases.findIndex(item => item.id === options.startPhaseId))
    : 0

  // Phases finished before a resume count as produced input; without them the
  // first resumed phase would look like it had no dependency and get pruned.
  const finished: PhaseRecord[] = [
    ...(options.completedPhases ?? [])
  ]
  // Seats may see what a previous run already produced, subject to `sees`.
  let allStatements: Statement[] = finished.flatMap(phase => phase.statements)

  for (let index = startIndex; index < loaded.phases.length; index++) {
    const phase = loaded.phases[index]!
    const previous = loaded.phases[index - 1]
    const deps = phase.requires.length
      ? phase.requires
      : previous
        ? [previous.id]
        : []
    const dependenciesProduced = deps.every((dep) => {
      const record = phases.find(item => item.id === dep) ?? finished.find(item => item.id === dep)
      return Boolean(record && record.status === 'completed')
    })

    // Only the opening phase re-reads the rejection notes; later phases in the
    // same attempt are downstream of whatever the new proposal turns into.
    const notes = attempt > 1 && phase.id === loaded.table.special.propose
      ? options.revisionNotes ?? []
      : []

    const { record, stop: phaseStop } = await runPhase(
      phase,
      attempt,
      options,
      allStatements,
      notes,
      deps.length === 0 || dependenciesProduced
    )
    phases.push(record)
    allStatements = allStatements.concat(record.statements)
    await options.persist?.()

    if (record.judgement) {
      judgement = record.judgement
    }
    if (phaseStop) {
      stop = phaseStop
      break
    }
  }

  events?.onAttempt?.(attempt, judgement)
  return {
    round: { attempt, phases },
    judgement,
    stop
  }
}

/** Collect veto reasons from a rejected round, for the next attempt. */
export function collectRejectionNotes(round: RoundRecord, loaded: LoadedRoundtable): string[] {
  const notes: string[] = []
  for (const phase of round.phases) {
    const judgement = phase.judgement
    if (!judgement) {
      continue
    }
    for (const seatId of [
      ...judgement.vetoed,
      ...judgement.rejected
    ]) {
      const statement = phase.statements.find(item => item.seat === seatId && item.status === 'completed')
      if (!statement) {
        continue
      }
      const seat = loaded.byId.get(seatId)
      const label = seat
        ? `${seat.identity.name}（${seat.role}）`
        : seatId
      const reason = extractReason(statement)
      notes.push(`${label}：${reason || '未说明具体理由'}`)
    }
  }
  return notes
}

function extractReason(statement: Statement): string {
  if (statement.structured && typeof statement.structured === 'object' && !Array.isArray(statement.structured)) {
    const source = statement.structured as Record<string, unknown>
    if (typeof source.reason === 'string' && source.reason.trim()) {
      return source.reason.trim()
    }
    if (Array.isArray(source.issues)) {
      const issues = source.issues.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
      if (issues.length) {
        return issues.slice(0, 5).join('；')
      }
    }
  }
  return statement.content.trim().slice(0, 300)
}

export type { ArtifactRef }
