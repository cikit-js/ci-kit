import type { LoadedRoundtable } from '../config'
import type { Statement } from '../prompt'
import type { CallContext } from './call'

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
