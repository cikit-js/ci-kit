import type { Seat } from './seat'

/** One line of the pool: a seat's single statement, in the order it landed. */
export interface Statement {
  seat: string
  name: string
  role: string
  /** ISO timestamp of the moment it entered the pool. */
  at: string
  status: StatementStatus
  content: string
  /** The seat's structured judgement, when `output: json` parsed cleanly. */
  verdict?: 'pass' | 'reject'
  /** Everything else the seat returned in its JSON, kept for review. */
  structured?: unknown
  durationMs?: number
  model?: string
  usage?: { input: number, output: number }
  /** One log-safe line when the seat failed. Never the provider payload. */
  error?: string
  artifacts?: ArtifactRef[]
}

export type StatementStatus
  = | 'completed'
    | 'skipped'
    | 'failed'
    | 'invalid-veto'

export interface ArtifactRef {
  path: string
  bytes: number
}

/**
 * Which pool entries a seat may hear.
 *
 * This is the mechanism that keeps discussion from collapsing into an echo
 * chamber: with `none` a seat receives the topic, brief and material — never
 * anyone else's opinion, including its own.
 *
 * Only `completed` entries are visible. A failed or skipped seat left a trace in
 * the record, but the meeting does not put error lines on the table.
 */
export function visibleStatements(viewer: Seat, pool: Statement[]): Statement[] {
  if (viewer.seat.sees === 'none') {
    return []
  }
  return pool.filter(statement => statement.status === 'completed')
}

function renderStatement(statement: Statement): string {
  const label = [statement.name, statement.role].filter(Boolean).join(' · ')
  const body = statement.verdict !== undefined
    ? `${statement.content}\n（判断：${statement.verdict === 'pass'
      ? 'pass'
      : 'reject'}）`
    : statement.content
  return `### ${label}\n\n${body}`
}

export interface PromptInput {
  /** What this discussion must answer. Required at the API edge. */
  topic: string
  /** Why the meeting was called. */
  brief?: string
  /** Everything the caller put on the table, already numbered by position. */
  context: string[]
  /** Pool entries this seat is allowed to hear. */
  visible: Statement[]
  /** Count of statements trimmed out of the pool by `maxPoolTokens`. */
  dropped?: number
  /** Why the previous attempt was rejected; only a follow-up round has these. */
  revisionNotes?: string[]
}

/**
 * Build the user message for one seat.
 *
 * Four blocks, always in this order and always labelled: 议题 / 背景 / 材料 /
 * 前序发言. The first three are the caller's input, the fourth is the discussion
 * itself; separating them is what lets a model tell "what we are deciding" from
 * "what others have said".
 *
 * The system prompt carries the persona. Keeping the two apart means a change to
 * visibility never threatens the persona text.
 */
export function buildUserPrompt(input: PromptInput): string {
  const blocks: string[] = []

  blocks.push(`## 议题\n\n${input.topic.trim()}`)

  if (input.brief?.trim()) {
    blocks.push(`## 背景\n\n${input.brief.trim()}`)
  }

  if (input.context.length) {
    // Numbered so a seat can say "第 2 条材料里…" and be understood by everyone.
    const items = input.context.map((item, index) => `### 材料 ${index + 1}\n\n${item}`).join('\n\n')
    blocks.push(`## 材料\n\n${items}`)
  }

  if (input.visible.length) {
    if (input.dropped) {
      blocks.push(`## 前序发言\n\n（更早的 ${input.dropped} 条发言已超出长度上限，略去）\n\n${input.visible.map(renderStatement).join('\n\n')}`)
    }
    else {
      blocks.push(`## 前序发言\n\n${input.visible.map(renderStatement).join('\n\n')}`)
    }
  }

  if (input.revisionNotes?.length) {
    // A follow-up round opens with what blocked the last one. This is the
    // caller's list, not a pool entry, so it reaches every seat — asking a seat
    // to fix a problem it is not told about does not work.
    const notes = input.revisionNotes.map(note => `- ${note}`).join('\n')
    blocks.push(`## 上一轮的否决理由\n\n${notes}`)
  }

  blocks.push(
    '## 输出要求\n\n'
    + '只说一句你要说的话，像在圆桌上接话一样，不要复述材料、不要写报告。\n'
    + '如果要回应别人，直接点名回应，不要泛泛而谈。'
  )

  return blocks.join('\n\n')
}

/**
 * Instruction for a voting seat, appended to its user message.
 *
 * The seat supplies material — a verdict, a reason, issues — and the program
 * decides. Asking for `approved` would put the decision in a place nobody can
 * audit later, so it is never requested.
 */
export function verdictInstruction(seat: Seat): string {
  const veto = seat.seat.canVeto
    ? '你有否决权：否决必须写明理由，没有理由的否决会被忽略。'
    : ''
  return [
    '除这句话，还要给出你的判断，用 JSON 对象返回：',
    '{"verdict":"pass|reject","reason":"一句话理由","score":0到1,"issues":["…"]}',
    'verdict 由你给出，是否通过由程序按权重与阈值计算；不要写 approved。',
    veto
  ].filter(Boolean).join('\n')
}
