import type { JsonSchema } from '@ci-kit/ai'
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
  /**
   * The line this seat actually said, in words another seat can read.
   *
   * A `output: json` seat replies with a JSON document. Storing that verbatim in
   * the pool means every later seat reads `{"verdict":…}` instead of a sentence,
   * and the discussion turns into parsing. `content` keeps what the provider
   * returned — that is evidence — while the pool and the release note read this.
   */
  say?: string
  /** The seat's structured judgement, when `output: json` parsed cleanly. */
  verdict?: 'pass' | 'reject'
  /**
   * The seat reported it had nothing left to argue.
   *
   * The engine reads this to stop asking the seat to speak until someone names
   * it; the record keeps it so a reader can see why a seat went silent.
   */
  done?: boolean
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
 * The pool entries a seat hears.
 *
 * Everyone hears everything, including their own past statements. There is no
 * visibility switch: a real table has no way to mute one person for another, and
 * a seat that cannot hear the discussion cannot take part in it — it can only
 * restate its first opinion, which is what the old `sees: none` seats did for
 * fifty turns straight.
 *
 * Only `completed` entries are visible. A failed or skipped seat left a trace in
 * the record, but the meeting does not put error lines on the table.
 */
export function visibleStatements(pool: Statement[]): Statement[] {
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
  /** Pool entries this seat hears. */
  visible: Statement[]
  /** Count of statements trimmed out of the pool by `maxPoolTokens`. */
  dropped?: number
  /** Why the previous attempt was rejected; only a follow-up round has these. */
  revisionNotes?: string[]
  /**
   * Ask the seat to report whether it has finished, alongside its line.
   *
   * Set only for voting seats: the answer travels in the same structured reply
   * as the verdict, so it is stated once rather than in a second round-trip.
   */
  askDone?: boolean
  /**
   * Tell the closing seat the room is waiting on it and it must settle now.
   *
   * Set when a planning meeting has stalled without a plan. Without this the
   * host tends to ask one more question and the meeting ends with nothing.
   */
  closeNow?: boolean
  /**
   * Which stage of a planning meeting this turn belongs to.
   *
   * `title` asks for the headline alone; `body` is the later stage, told what
   * the headline already is. Absent for an ordinary turn.
   */
  stage?: 'title' | 'body'
  /** The settled headline, when the meeting has moved on to the body. */
  settledTitle?: string
}

/** What the closing seat is told when the meeting has run out of patience. */
export const CLOSE_NOW_INSTRUCTION = [
  '## 该收口了',
  '',
  '大家都说完了，会场在等你。',
  '',
  '不要再提问，不要再等别人表态。把已经说清楚的定下来。'
].join('\n')

/** What the host is told when it is time to settle the title. */
export const CLOSE_TITLE_INSTRUCTION = [
  '## 现在只定标题',
  '',
  '这一阶段只定标题，内容后面再谈。',
  '',
  '只填 `title`：一个能直接用的标题，不是方向描述、不是「往……走」。',
  'angle、audience、outline 这一轮一个都不要填——填了会让会议跳过讨论。',
  '',
  '几家都说了想法，你可以挑一个，也可以合成一个更好的。'
].join('\n')

/** What the host is told when it is time to settle the body. */
export const CLOSE_BODY_INSTRUCTION = [
  '## 标题定了，接着定内容',
  '',
  '标题已经定了。现在把这一篇怎么写成什么定下来，一次填满这三项：',
  '- angle：这一篇从什么角度写，一句话',
  '- audience：写给谁、解决他什么困扰',
  '- outline：正文分几块、每块讲什么',
  '',
  'title 保持已定的那个，不要改。say 里用一两句话把定下来的内容说清楚。'
].join('\n')

/**
 * What a seat is told about `done`, beyond the persona.
 *
 * The judgement itself is the seat's, but the line between "I have concluded"
 * and "I have an opinion" has to be the same for every seat, or the meeting ends
 * at whichever seat is most confident and keeps going for whichever is least.
 * So the distinction is stated once, here, rather than left to each project.
 */
export const DONE_INSTRUCTION = [
  '## 什么时候算说完了',
  '',
  '`done` 表示「我负责的这件事已经有确定结论，而且没有人对此提出异议」。',
  '',
  '**确定结论**：一段工作的终局判断，别人除了同意或反对，没别的话可说。',
  '- 「合规上我没意见，全文没有触发退稿事项的内容」',
  '- 「这几处我都查过，站得住」',
  '- 「我们店做不到，要总部配合才行」',
  '',
  '**不是结论**（`done` 必须是 false）：',
  '- 观点：「开头太平，读者会划走」——别人可以说「我觉得挺好」，还能继续聊',
  '- 附和：「同意吉安娜」——你没有说出自己的判断',
  '- 提问：「麦迪文，事实这块你看呢」——你在等别人回答',
  '',
  '判断标准只有一条：**这句话还能不能被继续讨论**。',
  '能，就 `false`；不能，只有同意或反对两条路，就是 `true`。'
].join('\n')

/**
 * Build the user message for one seat.
 *
 * Four blocks, always in this order and always labelled: 议题 / 背景 / 材料 /
 * 前序发言. The first three are the caller's input, the fourth is the discussion
 * itself; separating them is what lets a model tell "what we are deciding" from
 * "what others have said".
 *
 * The system prompt carries the persona. Keeping the two apart means a change to
 * the discussion never threatens the persona text.
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
    const rendered = input.visible.map(renderStatement).join('\n\n')
    if (input.dropped) {
      blocks.push(`## 前序发言\n\n（更早的 ${input.dropped} 条发言已超出长度上限，略去）\n\n${rendered}`)
    }
    else {
      blocks.push(`## 前序发言\n\n${rendered}`)
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

  if (input.askDone) {
    blocks.push(DONE_INSTRUCTION)
  }

  if (input.closeNow) {
    blocks.push(CLOSE_NOW_INSTRUCTION)
  }

  if (input.stage === 'title') {
    blocks.push(CLOSE_TITLE_INSTRUCTION)
  }
  if (input.stage === 'body') {
    if (input.settledTitle) {
      blocks.push(`## 已定的标题\n\n${input.settledTitle}\n\n标题不再讨论。`)
    }
    blocks.push(CLOSE_BODY_INSTRUCTION)
  }

  return blocks.join('\n\n')
}

/**
 * The shape a voting seat's reply must take.
 *
 * This is the contract, and it lives here rather than in the prompt: the same
 * schema is sent as the provider's output format and is what `readVerdict`
 * expects to parse. Describing fields in prose let a model paraphrase them and
 * produced replies the parser could not read.
 *
 * `verdict` has no `approved`: whether the table passes is computed from votes,
 * so a seat that could state an outcome would put the decision somewhere nobody
 * can audit later.
 */
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    say: {
      type: 'string',
      description: '你这一句发言本身，一句人话，会被其他人读到'
    },
    done: {
      type: 'boolean',
      description: '你负责的那件事是否已经有确定结论，且没有待讨论的异议'
    },
    verdict: {
      type: 'string',
      enum: ['pass', 'reject'],
      description: '审核席位的判断：pass 表示可以继续，reject 表示有问题'
    },
    reason: {
      type: 'string',
      description: '一句话理由。否决必须填，否则否决无效'
    },
    score: {
      type: 'number',
      description: '你对这份材料的自评，0 到 1'
    },
    issues: {
      type: 'array',
      description: '需要作者处理的具体问题，每条一句',
      items: {
        type: 'string'
      }
    },
    title: {
      type: 'string',
      description: '主持人收口第一阶段时给出：这篇文章的标题'
    },
    angle: {
      type: 'string',
      description: '主持人收口第二阶段时给出：这篇从什么角度写'
    },
    audience: {
      type: 'string',
      description: '主持人收口第二阶段时给出：写给谁、解决他的什么困扰'
    },
    outline: {
      type: 'string',
      description: '主持人收口第二阶段时给出：正文分几块、每块讲什么'
    }
  },
  required: ['say', 'done'],
  additionalProperties: false
} satisfies JsonSchema

/**
 * What a voting seat is told about its judgement, beyond the persona.
 *
 * Only meaning is stated here — who decides, and what a veto costs. The field
 * shape is enforced by {@link VERDICT_SCHEMA}, not by prose the model may drift
 * from.
 */
export function verdictInstruction(seat: Seat): string {
  const lines = [
    '说完这句话，再给出你的判断。是否通过由程序按权重与阈值计算，你只提供判断和理由。'
  ]
  if (seat.seat.canVeto) {
    lines.push('你有否决权：否决必须写明理由，没有理由的否决会被忽略。')
  }
  return lines.join('\n')
}
