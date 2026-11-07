import type { ReasoningEffort } from '@ci-kit/ai'
import type { Seat } from '../seat'
import type { Usage } from './discussion'
import { text as aiText, isAiError } from '@ci-kit/ai'
import { VERDICT_SCHEMA, verdictInstruction } from '../prompt'
import { renderSeatSystemPrompt } from '../seat'

/** The AI call the engine depends on; injectable so discussions can be tested offline. */
export type TextCaller = typeof aiText

/** Kinds that may succeed later without changing anything, per the contract. */
const RETRYABLE_KINDS = new Set(['quota', 'server', 'network'])

/** The parts of engine options that affect a single call. */
export interface CallContext {
  env?: NodeJS.ProcessEnv
  callText?: TextCaller
  now?: () => number
  /** How hard thinking models should think; `undefined` keeps the provider default. */
  reasoningEffort?: ReasoningEffort
}

export interface CallOutcome {
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

export function describeError(error: unknown): { text: string, kind?: string, retryable: boolean } {
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

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * One AI call for a seat.
 *
 * `retries` is left to the transport only when the seat asked for `retry`:
 * a paid call that may have already completed must not be re-sent blindly, and
 * a seat that wants another go states it in its own config.
 */
export async function callSeat(seat: Seat, prompt: string, context: CallContext): Promise<CallOutcome> {
  const started = context.now?.() ?? Date.now()
  const wantJson = seat.seat.output === 'json'
  const call = context.callText ?? aiText
  const elapsed = (): number => (context.now?.() ?? Date.now()) - started

  try {
    const result = await call({
      prompt: wantJson
        ? `${prompt}\n\n${verdictInstruction(seat)}`
        : prompt,
      system: renderSeatSystemPrompt(seat),
      // A voting seat's reply is constrained by the schema, not by a prompt that
      // describes JSON: the field names live in code where the parser reads them.
      // `output: text` seats stay unconstrained and simply speak.
      ...wantJson
        ? { schema: VERDICT_SCHEMA }
        : {},
      maxTokens: seat.seat.maxTokens,
      // A discussion turn is one short line. Thinking models bill their
      // reasoning against `maxTokens`, so at 80 tokens a long pool leaves
      // nothing for the answer and the seat returns an empty statement. The
      // effort comes from the table so a project can choose the trade-off.
      reasoningEffort: context.reasoningEffort,
      retries: seat.seat.fallback === 'retry'
        ? undefined
        : 0,
      env: context.env
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
          durationMs: elapsed(),
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
      durationMs: elapsed(),
      fatal: false,
      retryable: false
    }
  }
  catch (error) {
    const described = describeError(error)
    return {
      ok: false,
      content: '',
      durationMs: elapsed(),
      error: described.text,
      kind: described.kind,
      fatal: seat.seat.fallback === 'abort',
      retryable: described.kind !== undefined && RETRYABLE_KINDS.has(described.kind) && described.retryable
    }
  }
}
