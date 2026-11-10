import type { FinalStatus, RecordVerdict, RoundtableRecord, RunState } from './record-types'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RECORD_SCHEMA } from './record-types'

export * from './record-render'
export * from './record-types'

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, 'utf8')
}

/** Assemble the record from a settled run state. */
export function buildRecord(state: RunState, title: string): RoundtableRecord {
  const final = state.attempts.at(-1)
  const status: FinalStatus = state.status === 'running'
    ? 'failed'
    : state.status

  const verdict: RecordVerdict = final?.verdict ?? {
    passed: false,
    vetoed: [],
    score: 0
  }

  return {
    schema: RECORD_SCHEMA,
    title,
    topic: state.topic,
    ...(state.brief
      ? { brief: state.brief }
      : {}),
    startedAt: state.startedAt,
    finishedAt: state.finishedAt ?? new Date().toISOString(),
    status,
    attempts: Math.max(1, state.attempts.length || state.attempt),
    verdict,
    statements: final?.statements ?? state.pool,
    usage: state.usage,
    ...(state.output
      ? { output: state.output }
      : {}),
    ...(state.error
      ? { error: state.error }
      : {})
  }
}

export function runDirOf(outDir: string, runId: string): string {
  return join(outDir, runId)
}

/** Local timestamp to the second, safe as a directory name on every platform. */
export function makeRunId(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    '-',
    pad(date.getMinutes()),
    '-',
    pad(date.getSeconds())
  ].join('')
}

/** ISO timestamp with the local offset, so a record is readable in the caller's zone. */
export function isoLocal(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0
    ? '+'
    : '-'
  const absolute = Math.abs(offset)
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
    sign,
    pad(Math.floor(absolute / 60)),
    ':',
    pad(absolute % 60)
  ].join('')
}
