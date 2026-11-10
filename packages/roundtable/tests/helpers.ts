import type { AiError } from '@ci-kit/ai'
import type { TextCaller } from '../src/engine'
import type { Statement } from '../src/prompt'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Scratch directories created by a test, removed in `afterEach`.
 *
 * Tests write real table/seat files and real run directories: the loader and the
 * record writer are half of what is being tested, so faking the filesystem would
 * leave the interesting parts untested.
 */
const scratch: string[] = []

export async function makeScratch(prefix = 'rt-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

export async function cleanupScratch(): Promise<void> {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}

export interface Call {
  prompt: string
  system?: string
  /** The output contract the seat asked for; present for voting seats. */
  schema?: unknown
  maxTokens?: number
  retries?: number
  model?: string
}

export interface StubOptions {
  /** Reply for one call; an `Error` is thrown, a string is returned. */
  reply: (call: Call, index: number) => string | Error | Promise<string | Error>
  usage?: { input: number, output: number }
  model?: string
}

/**
 * A `text()` stub that records every call.
 *
 * The real caller is the only thing a discussion needs from the outside world,
 * so stubbing it turns a meeting into a pure function of its config.
 */
export function stubText(options: StubOptions): { callText: TextCaller, calls: Call[] } {
  const calls: Call[] = []
  const callText = (async (input: {
    prompt: string
    system?: string
    schema?: unknown
    maxTokens?: number
    retries?: number
  }) => {
    const call: Call = {
      prompt: input.prompt,
      system: input.system,
      schema: input.schema,
      maxTokens: input.maxTokens,
      retries: input.retries
    }
    calls.push(call)
    const value = await options.reply(call, calls.length - 1)
    if (value instanceof Error) {
      throw value
    }
    let structured: Record<string, unknown> | undefined
    if (input.schema) {
      try {
        structured = JSON.parse(value)
      }
      catch {
        // Simulate a provider reply without validated tool arguments.
      }
    }
    return {
      value,
      structured,
      provider: 'stub',
      model: options.model ?? 'stub-model',
      usage: options.usage
    }
  }) as unknown as TextCaller
  return { callText, calls }
}

/**
 * A reply function keyed on the seat asking, by its `.`-terminated body line.
 *
 * Each test seat's body is `<name>。`, which lands verbatim at the end of its
 * system prompt — a reliable seat marker that no other seat's prompt contains.
 * A function value is called per request, so a test can fail once and then pass.
 */
export function bySeat(
  replies: Record<string, string | ((call: Call, index: number) => Promise<string | Error>)>
): (call: Call, index: number) => string | Error | Promise<string | Error> {
  return (call, index) => {
    for (const [marker, reply] of Object.entries(replies)) {
      if (call.system?.trimEnd().endsWith(marker)) {
        return typeof reply === 'function'
          ? reply(call, index)
          : reply
      }
    }
    return '发言'
  }
}

/** Build an `AiError` with a stable kind, mimicking what `@ci-kit/ai` throws. */
export async function aiError(kind: 'quota' | 'server' | 'network' | 'auth' | 'config' | 'request' | 'output', retryable = true): Promise<AiError> {
  const { AiError: AiErrorClass } = await import('@ci-kit/ai')
  return new AiErrorClass({
    kind,
    provider: 'stub',
    model: 'stub-model',
    retryable,
    message: `${kind} failure`
  })
}

export interface ConfigFiles {
  table: string
  seats: Record<string, string>
}

/** Write a roundtable directory and return its path. */
export async function makeConfig(files: ConfigFiles): Promise<string> {
  const dir = await makeScratch('rt-config-')
  await mkdir(join(dir, 'seats'), { recursive: true })
  await writeFile(join(dir, 'table.md'), files.table, 'utf8')
  for (const [name, content] of Object.entries(files.seats)) {
    await writeFile(join(dir, 'seats', name), content, 'utf8')
  }
  return dir
}

/**
 * A clock that only moves when the test says so.
 *
 * A discussion is bounded by wall time; letting it use the real clock would make
 * every run take three minutes or force tiny `durationMs` values that test
 * truncation instead of behaviour.
 *
 * `stepMs` makes every read advance the clock, which is how a table full of
 * seats behaves: nobody speaks at the same instant. With a step, a read is both
 * "what time is it" and "time passed while I was talking".
 */
export function fakeClock(start = Date.parse('2026-11-06T08:00:00+08:00'), stepMs = 0): {
  now: () => number
  advance: (ms: number) => void
} {
  let current = start
  return {
    now: () => {
      const value = current
      current += stepMs
      return value
    },
    advance: (ms: number) => {
      current += ms
    }
  }
}

/** Statements in the order they landed, for assertions. */
export function spokenBy(statements: Statement[]): string[] {
  return statements
    .filter(statement => statement.status === 'completed')
    .map(statement => statement.seat)
}

/** The environment test seats should not read; keeps assertions independent of the machine. */
export const CLEAN_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AI_TEXT_MODEL: undefined
}
