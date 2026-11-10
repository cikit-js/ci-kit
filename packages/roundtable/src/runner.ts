import type { RoundtableOptions, RoundtableResult } from './api-types'
import type { LoadedRoundtable } from './config'
import type { RunState } from './record'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { defaultOutDir, loadRoundtable, RoundtableConfigError } from './config'
import { isoLocal, makeRunId, RECORD_SCHEMA, writeJson, writeText } from './record'
import { judgeAttempt, runLoop, writeOutputs } from './runner-loop'

function readTopic(topic: string | undefined): string | undefined {
  return typeof topic === 'string' && topic.trim()
    ? topic.trim()
    : undefined
}

function toContextList(context: string | string[] | undefined): string[] {
  if (context === undefined || context === null)
    return []
  if (typeof context === 'string') {
    return context.trim()
      ? [
          context.trim()
        ]
      : []
  }
  if (!Array.isArray(context))
    throw new RoundtableConfigError('context must be a string or an array of strings')
  return context.map((item, index) => {
    if (typeof item !== 'string')
      throw new RoundtableConfigError(`context[${index}] must be a string`)
    return item.trim()
  }).filter(Boolean)
}

function assertTools(loaded: LoadedRoundtable, options: RoundtableOptions): void {
  for (const seat of loaded.seats.filter(item => item.enabled)) {
    for (const name of seat.seat.tools) {
      if (!options.tools?.[name]) {
        throw new RoundtableConfigError(`Seat ${seat.id} requests tool "${name}" but no handler was registered`)
      }
    }
  }
}

function makeContext(
  loaded: LoadedRoundtable,
  state: RunState,
  runDir: string,
  options: RoundtableOptions,
  now: () => number
): import('./runner-loop').RunnerContext {
  return {
    loaded,
    state,
    runDir,
    options,
    persist: () => writeJson(join(runDir, 'state.json'), state),
    writeArtifact: async (relativePath, content) => {
      await writeText(join(runDir, relativePath), content)
      return new TextEncoder().encode(content).byteLength
    },
    startedAt: Date.parse(state.startedAt) || now(),
    now,
    stamp: () => isoLocal(new Date(now()))
  }
}

function initialState(runId: string, loaded: LoadedRoundtable, options: RoundtableOptions, now: () => number): RunState {
  return {
    schema: RECORD_SCHEMA,
    runId,
    status: 'running',
    attempt: 1,
    startedAt: isoLocal(new Date(now())),
    topic: readTopic(options.topic),
    brief: options.brief?.trim() || undefined,
    context: toContextList(options.context),
    pool: [],
    attempts: [],
    usage: { input: 0, output: 0 },
    fingerprint: loaded.fingerprint
  }
}

export async function runRoundtable(options: RoundtableOptions): Promise<RoundtableResult> {
  const now = options.now ?? (() => Date.now())
  const loaded = await loadRoundtable({ configDir: options.configDir })
  assertTools(loaded, options)
  const outDir = resolve(options.outDir ?? defaultOutDir())
  const runId = makeRunId()
  const runDir = join(outDir, runId)
  await mkdir(runDir, { recursive: true })
  const state = initialState(runId, loaded, options, now)
  return runLoop(makeContext(loaded, state, runDir, options, now))
}

export interface ResumeOptions extends Omit<RoundtableOptions, 'outDir' | 'topic'> {
  runDir: string
  topic?: string
}

async function readState(runDir: string): Promise<RunState | null> {
  try {
    const parsed = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')) as RunState
    return parsed && typeof parsed === 'object' && parsed.schema === RECORD_SCHEMA
      ? parsed
      : null
  }
  catch {
    return null
  }
}

export async function resumeRoundtable(options: ResumeOptions): Promise<RoundtableResult> {
  const runDir = resolve(options.runDir)
  const now = options.now ?? (() => Date.now())
  const loaded = await loadRoundtable({ configDir: options.configDir })
  assertTools(loaded, options)
  const state = await readState(runDir)
  if (!state)
    throw new RoundtableConfigError(`No resumable state.json in ${runDir}`)
  if (state.fingerprint !== loaded.fingerprint)
    throw new RoundtableConfigError('Rules changed since this run started; open a new meeting instead of resuming')
  if (!state.topic)
    state.topic = readTopic(options.topic)
  const context = makeContext(loaded, state, runDir, { ...options, topic: state.topic }, now)
  if (state.status !== 'running') {
    if (!state.finishedAt)
      state.finishedAt = context.stamp()
    return writeOutputs(context)
  }
  const elapsed = context.now() - context.startedAt
  const remaining = loaded.table.durationMs - elapsed
  if (remaining <= 0) {
    options.onProgress?.('roundtable: 剩余时间为 0，直接进入裁决')
    const attempt = state.attempts.find(item => item.attempt === state.attempt)
    if (attempt) {
      attempt.statements = state.pool
      attempt.finishedAt = context.stamp()
      const verdict = judgeAttempt(loaded, attempt.statements)
      attempt.verdict = verdict
      state.status = verdict.passed ? 'passed' : 'rejected'
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
  return runLoop(context, { pool: state.pool ?? [], startedAt: context.startedAt })
}

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
