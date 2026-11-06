import type { LoadedRoundtable } from './config'
import type { BudgetState, PhaseRecord, RoundRecord, RoundtableStatus } from './engine'
import type { Statement } from './prompt'
import type { Judgement } from './verdict'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const RECORD_SCHEMA = 1

export interface RoundtableRecord {
  schema: number
  title: string
  startedAt: string
  finishedAt?: string
  status: RoundtableStatus
  attempts: number
  verdict: {
    passed: boolean
    vetoed: string[]
    rejected: string[]
    score: number
    invalidVetoes: string[]
  }
  rounds: RoundRecord[]
  budget: { total?: number, used: number, perSeat: Record<string, number> }
  /** Files produced under artifacts/, referenced by statements. */
  artifacts?: string[]
  error?: string
}

export interface RunState {
  schema: number
  runId: string
  /** `running` until the loop settles on a terminal status. */
  status: RoundtableStatus | 'running'
  attempt: number
  phaseIndex: number
  phaseId?: string
  budget: BudgetState
  fingerprint: string
  resumable: boolean
  rounds: RoundRecord[]
  startedAt: string
  finishedAt?: string
  topic?: string
  context: string[]
  error?: string
}

function statusWord(status: RoundtableStatus): string {
  switch (status) {
    case 'passed':
      return '通过'
    case 'rejected':
      return '未通过'
    case 'aborted':
      return '中止'
    case 'failed':
      return '失败'
    default:
      return '进行中'
  }
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest
    ? `${minutes} 分 ${rest} 秒`
    : `${minutes} 分`
}

function statementLabel(statement: Statement, loaded: LoadedRoundtable): string {
  const seat = loaded.byId.get(statement.seat)
  const name = statement.name || seat?.identity.name || statement.seat
  const role = statement.role || seat?.role || ''
  const avatar = seat?.identity.avatar
  const parts = [avatar, name].filter(Boolean).join(' ')
  return role
    ? `${parts} · ${role}`
    : parts
}

/** Render the human-readable minutes from the structured record. */
export function renderRecordMarkdown(record: RoundtableRecord, loaded: LoadedRoundtable): string {
  const lines: string[] = []
  const date = record.startedAt.slice(0, 10)
  lines.push(`# ${record.title} · ${date}`, '')

  const vetoText = record.verdict.vetoed.length
    ? `，否决：${record.verdict.vetoed.join('、')}`
    : '，无否决'
  lines.push(`**结论**：${statusWord(record.status)}（通过率 ${Math.round(record.verdict.score * 100)}%${vetoText}）`)
  const elapsed = record.finishedAt
    ? formatDuration(new Date(record.finishedAt).getTime() - new Date(record.startedAt).getTime())
    : '进行中'
  const total = record.budget.total === undefined
    ? '不限'
    : String(record.budget.total)
  lines.push(`**轮次**：第 ${record.attempts} 轮 · 预算 ${record.budget.used}/${total} · 用时 ${elapsed}`)

  const absent: string[] = []
  const latest = record.rounds[record.rounds.length - 1]

  if (latest) {
    // Group phase output by the role the phase plays, so a reader follows the
    // meeting rather than the implementation's phase names.
    for (const phase of latest.phases) {
      const heading = phaseHeading(phase.id, loaded)
      const completed = phase.statements.filter(statement => statement.status === 'completed')
      for (const statement of phase.statements) {
        if (statement.status !== 'completed') {
          absent.push(`${statementLabel(statement, loaded)}（${describeStatus(statement.status)}）`)
        }
      }
      if (!completed.length) {
        if (phase.pruned) {
          lines.push('', `## ${heading}`, '', '（前置阶段没有产出，本阶段跳过）')
        }
        continue
      }
      lines.push('', `## ${heading}`, '')
      for (const statement of completed) {
        lines.push(`**${statementLabel(statement, loaded)}**`, '')
        lines.push(renderStatementBody(statement), '')
      }
      if (phase.judgement) {
        lines.push(renderJudgement(phase.judgement, loaded), '')
      }
    }
  }

  if (record.verdict.invalidVetoes.length) {
    lines.push('## 被忽略的否决', '', `以下否决未写明理由，按规则视为无效：${record.verdict.invalidVetoes.join('、')}`, '')
  }

  if (absent.length) {
    lines.push('## 缺席名单', '', ...absent.map(item => `- ${item}`), '')
  }

  if (record.artifacts?.length) {
    lines.push('## 产物', '', ...record.artifacts.map(path => `- ${path}`), '')
  }

  return `${lines.join('\n').trimEnd()}\n`
}

function phaseHeading(phaseId: string, loaded: LoadedRoundtable): string {
  const special = loaded.table.special
  if (phaseId === special.propose) {
    return '议题'
  }
  if (phaseId === special.converge) {
    return '收口'
  }
  const season: Record<string, string> = {
    propose: '议题',
    discuss: '讨论',
    produce: '产出',
    review: '审核',
    converge: '收口'
  }
  return season[phaseId] ?? phaseId
}

function describeStatus(status: Statement['status']): string {
  switch (status) {
    case 'skipped':
      return '跳过'
    case 'failed':
      return '失败'
    case 'budget-exhausted':
      return '预算耗尽'
    case 'invalid-veto':
      return '否决无效'
    default:
      return status
  }
}

function renderStatementBody(statement: Statement): string {
  const { structured } = statement
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    const entries = Object.entries(structured as Record<string, unknown>)
    if (entries.length) {
      const rows = entries.map(([key, value]) => {
        const text = typeof value === 'string'
          ? value
          : JSON.stringify(value)
        return `| ${key} | ${String(text).replace(/\|/g, '\\|')} |`
      })
      return ['| 键 | 值 |', '| --- | --- |', ...rows].join('\n')
    }
  }
  return statement.content.trim()
}

function renderJudgement(judgement: Judgement, loaded: LoadedRoundtable): string {
  const parts: string[] = []
  parts.push(judgement.passed ? '裁决：通过' : '裁决：未通过')
  parts.push(`通过率 ${Math.round(judgement.score * 100)}%`)
  if (judgement.vetoed.length) {
    const names = judgement.vetoed.map(id => loaded.byId.get(id)?.identity.name ?? id)
    parts.push(`否决：${names.join('、')}`)
  }
  if (judgement.rejected.length && !judgement.vetoed.length) {
    const names = judgement.rejected.map(id => loaded.byId.get(id)?.identity.name ?? id)
    parts.push(`反对：${names.join('、')}`)
  }
  return `> ${parts.join(' · ')}`
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

/** Build the record object from the run state. */
export function buildRecord(state: RunState, loaded: LoadedRoundtable): RoundtableRecord {
  const finalJudgement = state.rounds
    .flatMap(round => round.phases)
    .filter((phase): phase is PhaseRecord & { judgement: Judgement } => Boolean(phase.judgement))
    .pop()
    ?.judgement

  const artifacts = state.rounds
    .flatMap(round => round.phases)
    .flatMap(phase => phase.statements)
    .flatMap(statement => statement.artifacts ?? [])
    .map(item => item.path)

  return {
    schema: RECORD_SCHEMA,
    title: loaded.table.title,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    status: state.status,
    attempts: state.rounds.length,
    verdict: {
      passed: state.status === 'passed',
      vetoed: finalJudgement?.vetoed ?? [],
      rejected: finalJudgement?.rejected ?? [],
      score: finalJudgement?.score ?? 0,
      invalidVetoes: state.rounds
        .flatMap(round => round.phases)
        .flatMap(phase => phase.judgement?.invalidVetoes ?? [])
    },
    rounds: state.rounds,
    budget: {
      total: state.budget.total,
      used: state.budget.used,
      perSeat: state.budget.perSeat
    },
    artifacts: artifacts.length ? artifacts : undefined,
    error: state.error
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
