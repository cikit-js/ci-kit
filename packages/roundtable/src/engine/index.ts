export { callSeat, describeError, isAbortError } from './call'
export type { CallContext, CallOutcome, TextCaller } from './call'
/**
 * Discussion runtime.
 *
 * Split by responsibility because the loop, the AI call and the pool cap each
 * have their own reasons to change:
 *
 * - `pool`       — how much of the transcript fits in one prompt
 * - `call`       — one seat, one request, and how a failure is classified
 * - `discussion` — the loop: when a seat may speak, and when it stops
 * - `votes`      — turning statements into the tally the judge reads
 */
export {
  ARTIFACT_THRESHOLD,
  discuss,
  emptyStatement,
  planFrom,
  POOL_POLL_MS,
  RETRY_BACKOFF_MS
} from './discussion'
export type {
  DiscussionPlan,
  DiscussionResult,
  EngineEvents,
  EngineOptions,
  RoundtableStatus,
  Usage
} from './discussion'
export { estimateTokens, trimPool } from './pool'
export { finalVotes, voteOf } from './votes'
