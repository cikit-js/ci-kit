import type { Statement } from './prompt'
import type { FinalStatus, RoundtableRecord } from './record-types'
import type { Seat } from './seat'

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

  // Only when the caller set one: a table that opens its own question has no
  // line to show here, and printing "undefined" would read as a bug.
  if (record.topic) {
    lines.push(`**议题**：${record.topic}`)
  }
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
