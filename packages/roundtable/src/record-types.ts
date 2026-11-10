import type { RoundtableStatus, Usage } from './engine'
import type { Statement } from './prompt'

/** Bumped whenever `record.json` changes shape. Downstream code branches on it. */
export const RECORD_SCHEMA = 2

/** Terminal statuses; only these are written as a finished record. */
export type FinalStatus = Exclude<RoundtableStatus, 'running'>

export interface RecordVerdict {
  passed: boolean
  /** Seats whose valid veto blocked the meeting. */
  vetoed: string[]
  /** Weighted pass share, 0–1. */
  score: number
}

export interface RoundtableRecord {
  schema: number
  title: string
  /** Absent when the table opened its own question. */
  topic?: string
  brief?: string
  startedAt: string
  finishedAt: string
  status: FinalStatus
  attempts: number
  verdict: RecordVerdict
  /** Every statement of the final attempt, in the order it entered the pool. */
  statements: Statement[]
  usage: Usage
  /**
   * The structured result the table declared, when anyone settled it.
   *
   * Recorded as a top-level field rather than left in the statements: it is the
   * product of the meeting, and a caller reading the record should not have to
   * replay the accumulation rules to recover it.
   */
  output?: Record<string, string>
  /** One line explaining an abort or a failure. Never a provider payload. */
  error?: string
}

/** One finished discussion. Kept so a loop can feed the veto reasons forward. */
export interface AttemptState {
  attempt: number
  startedAt: string
  finishedAt?: string
  statements: Statement[]
  verdict?: RecordVerdict
  /** Set when a seat asked to abort; the meeting stops after this attempt. */
  aborted?: boolean
}

/**
 * Everything needed to resume an interrupted discussion.
 *
 * Not an external interface: `--resume` reads it, nothing else should.
 */
export interface RunState {
  schema: number
  runId: string
  status: RoundtableStatus
  attempt: number
  startedAt: string
  finishedAt?: string
  /** The question, when the caller supplied one; a table may open its own. */
  topic?: string
  brief?: string
  /** Material handed in by the caller, kept so a resume needs no arguments. */
  context: string[]
  /**
   * The structured result the table declared, once anyone settled it.
   *
   * Written when an attempt closes: it is what the caller came for, and it has
   * to survive a crash between the discussion and the record being built.
   */
  output?: Record<string, string>
  /** Statements of the current attempt, in landing order. */
  pool: Statement[]
  /**
   * What this attempt was opened with: the veto reasons of the attempt before it.
   *
   * Kept so a resumed attempt hears them again — a seat that speaks after the
   * crash must not miss why the table is meeting a second time.
   */
  notes?: string[]
  /** Finished attempts, oldest first. */
  attempts: AttemptState[]
  usage: Usage
  fingerprint: string
  error?: string
}
