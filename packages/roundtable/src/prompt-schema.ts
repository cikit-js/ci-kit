import type { JsonSchema } from '@ci-kit/ai'
import type { Seat } from './seat'

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
        items: { type: 'string' }
      },
      ...(declared.length
        ? {
            output: {
              type: 'object',
              description: '这场会要交的东西：能定下来就逐项填',
              properties: Object.fromEntries(
                declared.map(key => [
                  key,
                  { type: 'string', description: fields[key]! }
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

export const VERDICT_SCHEMA = buildVerdictSchema()

export function verdictInstruction(seat: Seat): string {
  const lines = ['说完这句话，再给出你的判断。是否通过由程序按权重与阈值计算，你只提供判断和理由。']
  if (seat.seat.canVeto) {
    lines.push('你有否决权：否决必须写明理由，没有理由的否决会被忽略。')
  }
  return lines.join('\n')
}
