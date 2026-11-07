import type { DiscussionPlan, RoundtableStatus, Usage } from './engine'
import type { Statement } from './prompt'
import type { Seat } from './seat'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
  topic: string
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
   * What a planning meeting settled, when it settled anything.
   *
   * Recorded as a top-level field rather than left in the statements: the plan
   * is the product of the meeting, and a caller reading the record should not
   * have to replay the closing rules to recover it.
   */
  plan?: DiscussionPlan
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
  topic: string
  brief?: string
  /** Material handed in by the caller, kept so a resume needs no arguments. */
  context: string[]
  /**
   * What the meeting decided, once it decided anything.
   *
   * Written when an attempt closes: the plan is what the caller came for, and it
   * has to survive a crash between the discussion and the record being built.
   */
  plan?: DiscussionPlan
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

const STATUS_WORD: Record<FinalStatus, string> = {
  passed: '通过',
  rejected: '未通过',
  aborted: '中止',
  failed: '失败'
}

/** `1 分 14 秒`; the minutes part is dropped below one minute. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest
    ? `${minutes} 分 ${rest} 秒`
    : `${minutes} 分`
}

/** `1m14s` for the one-line CLI summary. */
export function formatShortDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) {
    return `${minutes}m${String(rest).padStart(2, '0')}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** `格罗姆 🏪 门店读者视角`, the label a reader sees above one paragraph. */
function statementLabel(statement: Statement, seats: Map<string, Seat>): string {
  const seat = seats.get(statement.seat)
  const name = statement.name || seat?.identity.name || statement.seat
  const role = statement.role || seat?.role || ''
  const avatar = seat?.identity.avatar
  const parts = avatar
    ? `${name} ${avatar}`
    : name
  return role
    ? `${parts} ${role}`
    : parts
}

function describeStatus(status: Statement['status']): string {
  switch (status) {
    case 'skipped':
      return '跳过'
    case 'failed':
      return '失败'
    case 'invalid-veto':
      return '否决未写理由'
    default:
      return status
  }
}

/**
 * Render the human-readable minutes from the record alone.
 *
 * No model call: the summary must say exactly what the record says, or the two
 * will drift and someone will quote the wrong one.
 */
export function renderRecordMarkdown(record: RoundtableRecord, seats: Map<string, Seat>): string {
  const lines: string[] = []
  const date = record.startedAt.slice(0, 10)
  lines.push(`# ${record.title} · ${date}`, '')

  lines.push(`**议题**：${record.topic}`)
  if (record.brief) {
    lines.push(`**背景**：${record.brief}`)
  }

  const vetoNames = record.verdict.vetoed
    .map(id => seats.get(id)?.identity.name ?? id)
  const percent = Math.round(record.verdict.score * 100)
  const verdictParts: string[] = []
  if (vetoNames.length) {
    verdictParts.push(`${vetoNames.join('、')}否决`)
  }
  if (record.status === 'passed') {
    verdictParts.unshift(`通过（通过率 ${percent}%）`)
  }
  else if (record.status === 'rejected') {
    verdictParts.unshift(`未通过（通过率 ${percent}%${vetoNames.length ? '' : '，未达门槛'}）`)
  }
  else {
    verdictParts.unshift(STATUS_WORD[record.status])
  }
  lines.push(`**结论**：${verdictParts.join('，')}`)

  const elapsed = formatDuration(new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime())
  const calls = record.statements.filter(statement => statement.status !== 'skipped').length
  lines.push(`**用时**：${elapsed} · ${calls} 次发言 · ${record.attempts} 轮`)
  if (record.error) {
    lines.push(`**说明**：${record.error}`)
  }

  lines.push('', '## 讨论', '')

  const absent: string[] = []
  for (const statement of record.statements) {
    if (statement.status === 'completed') {
      lines.push(`**${statementLabel(statement, seats)}**`, '')
      lines.push(statement.content.trim(), '')
      continue
    }
    // Absence is listed once per seat, at the end, rather than interrupting the
    // conversation with an error line in the middle of a sentence.
    absent.push(`${statementLabel(statement, seats)}（${describeStatus(statement.status)}）`)
  }

  const invalidVetoes = record.statements
    .filter(statement => statement.status === 'invalid-veto')
    .map(statement => statementLabel(statement, seats))
  if (invalidVetoes.length) {
    lines.push('## 被忽略的否决', '', `以下否决没有写明理由，按规则不计入：${invalidVetoes.join('、')}`, '')
  }

  lines.push('---', '')
  lines.push(`**缺席**：${absent.length
    ? absent.join('、')
    : '无'}`)
  lines.push('')

  return `${lines.join('\n').trimEnd()}\n`
}

/** Write a JSON file, creating the directory when needed. */
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
    ...(state.plan
      ? { plan: state.plan }
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
