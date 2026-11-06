import type { Seat } from './seat'

/** One seat's turn in a phase, as seen by later seats. */
export interface Statement {
  seat: string
  name: string
  role: string
  phase: string
  status: StatementStatus
  content: string
  structured?: unknown
  durationMs?: number
  model?: string
  usage?: { input: number, output: number }
  /** One log-safe line when the seat failed. */
  error?: string
  artifacts?: ArtifactRef[]
}

export type StatementStatus
  = | 'completed'
    | 'skipped'
    | 'failed'
    | 'budget-exhausted'
    | 'invalid-veto'

export interface ArtifactRef {
  path: string
  bytes: number
}

/**
 * Which earlier statements a seat may see.
 *
 * This is the mechanism that keeps discussion from collapsing into an echo
 * chamber, and the reason an independent reviewer stays independent: with
 * `none` it receives only the material and its own instructions, never the
 * author's self-justification.
 */
export function visibleStatements(
  viewer: Seat,
  statements: Statement[],
  leadIds: Set<string>
): Statement[] {
  const { sees } = viewer.seat
  if (sees === 'none') {
    return []
  }
  if (sees === 'all') {
    return statements.filter(statement => statement.seat !== viewer.id)
  }
  if (sees === 'lead-only') {
    return statements.filter(statement => statement.seat !== viewer.id && leadIds.has(statement.seat))
  }
  const allowed = new Set(sees)
  return statements.filter(statement => statement.seat !== viewer.id && allowed.has(statement.seat))
}

function renderStatement(statement: Statement): string {
  const label = [statement.name, statement.role].filter(Boolean).join(' · ')
  const body = statement.structured !== undefined && statement.structured !== null
    ? JSON.stringify(statement.structured, null, 2)
    : statement.content
  return `### ${label}\n\n${body}`
}

export interface PromptInput {
  phaseId: string
  topic?: string
  /** Initial material handed in by the caller. */
  context: string[]
  /** Statements this seat is allowed to see. */
  visible: Statement[]
  /** Previous attempt's rejection notes, when the meeting loops. */
  revisionNotes?: string[]
  /** Extra instruction describing what this phase expects. */
  phaseInstruction?: string
}

/**
 * Build the user message for one seat.
 *
 * The system prompt carries the persona; this carries only what the seat is
 * permitted to know at this moment. Keeping the two apart means a visibility
 * change never threatens the persona text.
 */
export function buildUserPrompt(input: PromptInput): string {
  const blocks: string[] = []

  if (input.topic) {
    blocks.push(`## 本次议题\n\n${input.topic}`)
  }

  if (input.context.length) {
    const items = input.context.map((item, index) => `${index + 1}. ${item}`).join('\n')
    blocks.push(`## 已知材料\n\n${items}`)
  }

  if (input.phaseInstruction) {
    blocks.push(`## 当前阶段\n\n${input.phaseInstruction}`)
  }

  if (input.visible.length) {
    blocks.push(`## 前序发言\n\n${input.visible.map(renderStatement).join('\n\n')}`)
  }

  if (input.revisionNotes?.length) {
    const notes = input.revisionNotes.map(note => `- ${note}`).join('\n')
    blocks.push(`## 上一轮的否决理由\n\n${notes}`)
  }

  blocks.push(
    '## 输出要求\n\n'
    + '只输出你的发言本身，不要复述上述材料。\n'
    + '若你拥有否决权，请在需要否决时写明理由；没有理由的否决会被忽略。'
  )

  return blocks.join('\n\n')
}

/** Instruction text injected for a named phase, when the table does not override it. */
export function defaultPhaseInstruction(phaseId: string): string | undefined {
  switch (phaseId) {
    case 'propose':
      return '提出一个你认为值得讨论的具体议题，并说明为什么是现在、为什么值得做。'
    case 'discuss':
      return '对你看到的前序观点作出回应：可以附议、反驳或补充，但必须给出理由。'
    case 'produce':
      return '按已达成的方向产出实际结果。'
    case 'review':
      return '核对产出是否满足要求。发现问题请逐条列出；需要否决时写明理由。'
    case 'converge':
      return '收口：给出结论、遗留分歧和下一步。'
    default:
      return undefined
  }
}
