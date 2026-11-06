/**
 * @ci-kit/roundtable
 *
 * Placeholder package. The design is settled in `ai-docs/design-docs/roundtable/`;
 * the implementation has not started yet, so this module exports only the
 * names and types that downstream code may already reference.
 *
 * Do not add behaviour here before the design document is followed end to end:
 * seat parsing, phase scheduling, programmatic adjudication and resumable runs
 * are one unit, and half of them is worse than none.
 */

export const ROUNDTABLE_SCHEMA = 1 as const

export type RoundtableStatus = 'passed' | 'rejected' | 'aborted' | 'failed'

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
}

export interface RoundtableResult {
  status: RoundtableStatus
  recordPath: string
}

function notImplemented(): never {
  throw new Error('@ci-kit/roundtable is not implemented yet; see ai-docs/design-docs/roundtable/')
}

/** Validate `table.md` and `seats/*.md` without calling a model. */
export async function loadRoundtable(_options: RoundtableOptions): Promise<never> {
  return notImplemented()
}

/** Alias kept for the CLI `check` command: no paid calls, config errors only. */
export async function checkRoundtable(_options: RoundtableOptions): Promise<never> {
  return notImplemented()
}

/** Run one meeting and return its verdict. Business failure is reported via `status`. */
export async function runRoundtable(_options: RoundtableOptions): Promise<RoundtableResult> {
  return notImplemented()
}
