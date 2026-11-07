import type { Seat } from '../src/seat'
import type { Table } from '../src/table'
import { describe, expect, it } from 'vitest'
import { readFrontmatter } from '../src/frontmatter'
import { parseSeat } from '../src/seat'
import { judgeMeeting, readVerdict, vetoReason } from '../src/verdict'

function seat(source: string): Seat {
  return parseSeat(readFrontmatter(source, 'f.md'), 'f.md')
}

const TABLE: Table = {
  title: '裁决',
  durationMs: 180_000,
  maxPoolTokens: 3000,
  threshold: 0.6,
  onVeto: 'abort',
  maxAttempts: 1
}

const GROM = seat(`---
id: grom
role: 门店读者视角
seat:
  output: json
---`)
const JAINA = seat(`---
id: jaina
role: 品牌与表达
seat:
  output: json
---`)
const UTHER = seat(`---
id: uther
role: 合规与风险
seat:
  output: json
  canVeto: true
---`)

describe('judgeMeeting', () => {
  it('passes when the weighted share reaches the threshold', () => {
    const judgement = judgeMeeting(
      [GROM, JAINA, UTHER],
      [
        {
          seatId: 'grom',
          weight: 1,
          vote: 'pass',
          veto: false
        },
        {
          seatId: 'jaina',
          weight: 1,
          vote: 'pass',
          veto: false
        },
        {
          seatId: 'uther',
          weight: 1,
          vote: 'reject',
          veto: false
        }
      ],
      { ...TABLE, threshold: 0.6 }
    )
    expect(judgement.score).toBeCloseTo(2 / 3)
    expect(judgement.passed).toBe(true)
    expect(judgement.rejected).toEqual(['uther'])
  })

  it('fails when the weighted share falls short', () => {
    const judgement = judgeMeeting(
      [GROM, JAINA, UTHER],
      [
        {
          seatId: 'grom',
          weight: 1,
          vote: 'pass',
          veto: false
        },
        {
          seatId: 'jaina',
          weight: 1,
          vote: 'reject',
          veto: false
        },
        {
          seatId: 'uther',
          weight: 1,
          vote: 'reject',
          veto: false
        }
      ],
      TABLE
    )
    expect(judgement.score).toBeCloseTo(1 / 3)
    expect(judgement.passed).toBe(false)
  })

  it('counts weight instead of heads', () => {
    const judgement = judgeMeeting(
      [GROM, JAINA, UTHER],
      [
        {
          seatId: 'grom',
          weight: 3,
          vote: 'pass',
          veto: false
        },
        {
          seatId: 'jaina',
          weight: 1,
          vote: 'reject',
          veto: false
        },
        {
          seatId: 'uther',
          weight: 1,
          vote: 'reject',
          veto: false
        }
      ],
      TABLE
    )
    expect(judgement.weights).toEqual({ pass: 3, total: 5 })
    expect(judgement.passed).toBe(true)
  })

  it('lets any veto-capable objection block the meeting', () => {
    const judgement = judgeMeeting(
      [GROM, JAINA, UTHER],
      [
        {
          seatId: 'grom',
          weight: 10,
          vote: 'pass',
          veto: false
        },
        {
          seatId: 'jaina',
          weight: 10,
          vote: 'pass',
          veto: false
        },
        {
          seatId: 'uther',
          weight: 1,
          vote: 'reject',
          veto: true
        }
      ],
      TABLE
    )
    expect(judgement.passed).toBe(false)
    expect(judgement.vetoed).toEqual(['uther'])
    // The score still reports what the table thought; the veto is separate.
    expect(judgement.score).toBeCloseTo(20 / 21)
  })

  it('leaves absent seats out of the denominator', () => {
    const judgement = judgeMeeting(
      [GROM, JAINA, UTHER],
      [
        {
          seatId: 'grom',
          weight: 1,
          vote: 'pass',
          veto: false
        }
      ],
      TABLE
    )
    expect(judgement.score).toBe(1)
    // One of three asked is 33%, which would read as a decision the table never made.
    expect(judgement.passed).toBe(true)
    expect(judgement.absent).toEqual(['jaina', 'uther'])
  })

  it('never passes a table where nobody voted', () => {
    const judgement = judgeMeeting([GROM, JAINA], [], TABLE)
    expect(judgement.score).toBe(0)
    expect(judgement.passed).toBe(false)
    expect(judgement.absent).toEqual(['grom', 'jaina'])
  })

  it('ignores a vote from a seat that is not attending', () => {
    const disabled = seat(`---
id: ghost
role: 幽灵
enabled: false
seat:
  output: json
---`)
    const judgement = judgeMeeting(
      [GROM, disabled],
      [
        {
          seatId: 'grom',
          weight: 1,
          vote: 'reject',
          veto: false
        },
        {
          seatId: 'ghost',
          weight: 100,
          vote: 'pass',
          veto: false
        }
      ],
      TABLE
    )
    expect(judgement.weights.total).toBe(1)
    expect(judgement.passed).toBe(false)
  })

  it('honours a threshold of 1 and of 0 at the edges', () => {
    const pass = [
      {
        seatId: 'grom',
        weight: 1,
        vote: 'pass' as const,
        veto: false
      }
    ]
    expect(judgeMeeting([GROM], pass, { ...TABLE, threshold: 1 }).passed).toBe(true)
    expect(judgeMeeting([GROM], pass, { ...TABLE, threshold: 0 }).passed).toBe(true)
    // Even at a threshold of 0 a unanimous rejection is still a rejection.
    const reject = [
      {
        seatId: 'grom',
        weight: 1,
        vote: 'reject' as const,
        veto: false
      }
    ]
    expect(judgeMeeting([GROM], reject, { ...TABLE, threshold: 0 }).passed).toBe(false)
  })

  it('needs at least one vote to pass, whatever the threshold', () => {
    expect(judgeMeeting([GROM], [], { ...TABLE, threshold: 0 }).passed).toBe(false)
  })
})

describe('readVerdict', () => {
  it('reads the documented judgement material', () => {
    expect(readVerdict({
      verdict: 'reject',
      reason: '平均寿命那句没给出处',
      score: 0.2,
      issues: ['缺出处', ''],
      suggestions: ['补来源']
    })).toEqual({
      verdict: 'reject',
      reason: '平均寿命那句没给出处',
      score: 0.2,
      issues: ['缺出处'],
      suggestions: ['补来源'],
      done: undefined
    })
  })

  it('reads finished only from an explicit true', () => {
    // The engine quiets a seat on `finished`, so the only safe reading is the
    // literal boolean. Anything else keeps the seat in the room.
    expect(readVerdict({ verdict: 'pass', finished: true }).finished).toBe(true)
    expect(readVerdict({ verdict: 'pass', finished: false }).finished).toBeUndefined()
    expect(readVerdict({ verdict: 'pass', finished: 'true' }).finished).toBeUndefined()
    expect(readVerdict({ verdict: 'pass', finished: 1 }).finished).toBeUndefined()
    expect(readVerdict({ verdict: 'pass' }).finished).toBeUndefined()
  })

  it('keeps only the non-empty output fields a seat filled', () => {
    expect(readVerdict({
      output: { title: '标题', content: '  正文  ' }
    }).output).toEqual({
      title: '标题',
      content: '正文'
    })
    // An empty field is not settled; a half-filled meeting must not read whole.
    expect(readVerdict({
      output: { title: '标题', content: '   ' }
    }).output).toEqual({ title: '标题' })
    expect(readVerdict({
      output: { title: '', content: '' }
    }).output).toBeUndefined()
    expect(readVerdict({ output: {} }).output).toBeUndefined()
    expect(readVerdict({ output: 'title' }).output).toBeUndefined()
    expect(readVerdict({}).output).toBeUndefined()
  })

  it('never infers a verdict from anything but the verdict field', () => {
    expect(readVerdict({ approved: true }).verdict).toBeUndefined()
    expect(readVerdict({ approved: false }).verdict).toBeUndefined()
    expect(readVerdict('否决：理由').verdict).toBeUndefined()
    expect(readVerdict(null).verdict).toBeUndefined()
    expect(readVerdict([
      { verdict: 'pass' }
    ]).verdict).toBeUndefined()
  })

  it('drops a score outside 0–1', () => {
    expect(readVerdict({ verdict: 'pass', score: 4 }).score).toBeUndefined()
    expect(readVerdict({ verdict: 'pass', score: -1 }).score).toBeUndefined()
  })

  it('ignores a verdict word it does not define', () => {
    expect(readVerdict({ verdict: 'approved' }).verdict).toBeUndefined()
  })
})

describe('vetoReason', () => {
  it('prefers the stated reason', () => {
    expect(vetoReason({ reason: '提到具体金额' }, '否决')).toBe('提到具体金额')
  })

  it('falls back to the issues a veto is backed by', () => {
    expect(vetoReason({
      issues: ['缺出处', '口径不明']
    }, '')).toBe('缺出处；口径不明')
  })

  it('reads the reason after a plain-text marker', () => {
    expect(vetoReason({}, '否决：这句话会被截图传播')).toBe('这句话会被截图传播')
    expect(vetoReason({}, 'REJECT: no source')).toBe('no source')
  })

  it('reports nothing when a veto says nothing', () => {
    expect(vetoReason({}, '否决')).toBe('')
    expect(vetoReason({}, '否决：')).toBe('')
    expect(vetoReason({}, '')).toBe('')
  })
})
