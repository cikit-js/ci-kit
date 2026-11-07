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
  speech?: string
  /** The seat's structured judgement, when `output: json` parsed cleanly. */
  verdict?: 'pass' | 'reject'
  /**
   * The seat reported its own target is met.
   *
   * The engine reads this to stop asking the seat to speak until someone names
   * it; the record keeps it so a reader can see why a seat went silent.
   */
  finished?: boolean
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
   * Ask the seat to report whether its own target is met, alongside its line.
   *
   * Set only for voting seats: the answer travels in the same structured reply
   * as the verdict, so it is stated once rather than in a second round-trip.
   */
  askFinished?: boolean
  /** The `output.fields` this table declared, when it declared any. */
  outputFields?: Record<string, string>
  /**
   * The room has gone quiet and this seat still has not finished.
   *
   * Every seat waits for someone else to move, so a room can deadlock with
   * nobody satisfied and no decision made. This tells the seat now holding the
   * floor that waiting is over for it: say what you were waiting to say.
   */
  roomQuiet?: boolean
}

/**
 * What a seat is told about `finished`, beyond the persona.
 *
 * The judgement itself is the seat's, but the line between "I met my target" and
 * "I have an opinion" has to be the same for every seat, or the meeting ends at
 * whichever seat is most confident and keeps going for whichever is least. So
 * the distinction is stated once, here, rather than left to each project.
 *
 * What each seat is chasing is its own `target`, read from its own file: the
 * table has no goal, only seats with goals.
 */
export const FINISHED_INSTRUCTION = [
  '## 什么时候算你这一份做到了',
  '',
  '`finished` 表示「我自己的 target 里那件事已经有确定结论，而且没有人对此提出异议」。',
  '',
  '**确定结论**：一段工作的终局判断，别人除了同意或反对，没别的话可说。',
  '- 「合规上我没意见，全文没有触发退稿事项的内容」',
  '- 「这几处我都查过，站得住」',
  '- 「我们店做不到，要总部配合才行」',
  '',
  '**不是结论**（`finished` 必须是 false）：',
  '- 观点：「开头太平，读者会划走」——别人可以说「我觉得挺好」，还能继续聊',
  '- 附和：「同意吉安娜」——你没有说出自己的判断',
  '- 提问：「麦迪文，事实这块你看呢」——你在等别人回答',
  '',
  '判断标准只有一条：**这句话还能不能被继续讨论**。',
  '能，就 `false`；不能，只有同意或反对两条路，就是 `true`。'
].join('\n')

/**
 * What a seat is told when the room fell silent while it still had not finished.
 *
 * Nobody is being polite by waiting here: every seat sits on the same rule, so
 * waiting is what ends the meeting. This is the one seat now holding the floor.
 */
export const ROOM_QUIET_INSTRUCTION = [
  '## 会场静下来了',
  '',
  '大家都停了，不是都说完了，是谁都在等别人先开口。现在轮到你说。',
  '',
  '- 有你还没说到的判断，就说出来',
  '- 你负责的事已经有结论，就把 `finished` 设成 true',
  '- 你负责的事需要别人先表态，就点名把话说清楚',
  '',
  '不要再说「等某某先说」。会场就这么停住的。'
].join('\n')

/**
 * How a seat is asked to fill the table's declared output fields.
 *
 * Built from `table.md`'s `output.fields`, so the wording carries whatever
 * constraints the project wrote and nothing else: the library knows there are
 * fields, not what they mean.
 */
export function outputInstruction(fields: Record<string, string>): string {
  const lines = [
    '## 这场会要交的东西',
    '',
    '当你能把下面每一项都定下来时，逐项填进对应的字段。只写在发言里不算定案——程序只读字段。'
  ]
  for (const [key, hint] of Object.entries(fields)) {
    lines.push(`- \`${key}\`：${hint}`)
  }
  return lines.join('\n')
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

  if (input.askFinished) {
    blocks.push(FINISHED_INSTRUCTION)
  }

  if (input.roomQuiet) {
    // The room stopped because everyone was waiting, not because everyone was
    // done. Saying so is the difference between a meeting that ends in a
    // decision and one that ends because nobody wanted to go first.
    blocks.push(ROOM_QUIET_INSTRUCTION)
  }

  if (input.outputFields && Object.keys(input.outputFields).length) {
    blocks.push(outputInstruction(input.outputFields))
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
 *
 * Built per table: the two protocol fields are always here, and the output
 * fields come from `output.fields` with each project's own constraints as
 * their descriptions. A table that declares none gets no output object at all —
 * that meeting only talks and votes.
 */
export function buildVerdictSchema(outputFields?: Record<string, string>): JsonSchema {
  const fields = outputFields ?? {}
  const declared = Object.keys(fields)

  return {
    type: 'object',
    properties: {
      speech: {
        type: 'string',
        description: '你这一轮要说的话，一句人话，会被其他席位读到'
      },
      finished: {
        type: 'boolean',
        description: '对照你自己 target 描述的那件事，是否已经有确定结论'
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
      ...(declared.length
        ? {
            output: {
              type: 'object',
              description: '这场会要交的东西：能定下来就逐项填',
              properties: Object.fromEntries(
                declared.map(key => [
                  key,
                  {
                    type: 'string',
                    description: fields[key]!
                  }
                ])
              ),
              required: declared,
              additionalProperties: false
            }
          }
        : {})
    },
    required: ['speech', 'finished'],
    additionalProperties: false
  } satisfies JsonSchema
}

/** The schema for a table that declares no output fields. */
export const VERDICT_SCHEMA = buildVerdictSchema()

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
