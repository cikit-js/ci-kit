import type { Statement } from '../src/prompt'
import type { Seat, Sees } from '../src/seat'
import { describe, expect, it } from 'vitest'
import { buildUserPrompt, defaultPhaseInstruction, visibleStatements } from '../src/prompt'

function seat(id: string, sees: Sees): Seat {
  return {
    id,
    role: id,
    enabled: true,
    identity: { name: id },
    persona: { personality: [] },
    seat: {
      phase: [],
      sees,
      canPropose: false,
      canVeto: false,
      lead: false,
      weight: 1,
      priority: 99,
      fallback: 'skip',
      output: 'text'
    },
    body: '',
    source: `${id}.md`
  }
}

function statement(seatId: string, content = seatId): Statement {
  return {
    seat: seatId,
    name: seatId,
    role: seatId,
    phase: 'propose',
    status: 'completed',
    content
  }
}

describe('visibleStatements', () => {
  const statements = [
    statement('a'),
    statement('b'),
    statement('lead')
  ]
  const leads = new Set(['lead'])

  it('shows every other statement when sees is all', () => {
    const visible = visibleStatements(seat('viewer', 'all'), statements, leads)
    expect(visible.map(item => item.seat)).toEqual(['a', 'b', 'lead'])
  })

  it('never shows a seat its own statement', () => {
    const visible = visibleStatements(seat('a', 'all'), statements, leads)
    expect(visible.map(item => item.seat)).toEqual(['b', 'lead'])
  })

  it('shows nothing when sees is none', () => {
    expect(visibleStatements(seat('viewer', 'none'), statements, leads)).toEqual([])
  })

  it('shows only lead statements for lead-only', () => {
    const visible = visibleStatements(seat('viewer', 'lead-only'), statements, leads)
    expect(visible.map(item => item.seat)).toEqual(['lead'])
  })

  it('shows only the listed seats for an explicit list', () => {
    const visible = visibleStatements(seat('viewer', ['a']), statements, leads)
    expect(visible.map(item => item.seat)).toEqual(['a'])
  })

  it('still hides a seat from itself inside an explicit list', () => {
    const visible = visibleStatements(seat('a', ['a', 'b']), statements, leads)
    expect(visible.map(item => item.seat)).toEqual(['b'])
  })
})

describe('buildUserPrompt', () => {
  it('includes topic, context, phase instruction, prior statements and revision notes', () => {
    const prompt = buildUserPrompt({
      phaseId: 'propose',
      topic: '要不要做会员积分互通',
      context: ['材料一', '材料二'],
      visible: [
        {
          ...statement('a', '我认为应该先验证'),
          name: '甲',
          role: '编辑'
        }
      ],
      revisionNotes: ['审核：缺少数据支撑'],
      phaseInstruction: '提出一个议题'
    })
    expect(prompt).toContain('要不要做会员积分互通')
    expect(prompt).toContain('1. 材料一')
    expect(prompt).toContain('2. 材料二')
    expect(prompt).toContain('提出一个议题')
    expect(prompt).toContain('甲 · 编辑')
    expect(prompt).toContain('我认为应该先验证')
    expect(prompt).toContain('缺少数据支撑')
  })

  it('omits sections that have no content', () => {
    const prompt = buildUserPrompt({ phaseId: 'propose', context: [], visible: [] })
    expect(prompt).not.toContain('## 本次议题')
    expect(prompt).not.toContain('## 已知材料')
    expect(prompt).not.toContain('## 前序发言')
    expect(prompt).not.toContain('## 上一轮的否决理由')
  })

  it('renders structured output as JSON rather than raw text', () => {
    const prompt = buildUserPrompt({
      phaseId: 'review',
      context: [],
      visible: [
        {
          ...statement('a', 'raw text'),
          structured: { verdict: 'reject', reason: '缺证' }
        }
      ]
    })
    expect(prompt).toContain('"verdict": "reject"')
    expect(prompt).not.toContain('raw text')
  })
})

describe('defaultPhaseInstruction', () => {
  it('describes the five conventional phases', () => {
    for (const id of [
      'propose',
      'discuss',
      'produce',
      'review',
      'converge'
    ]) {
      expect(defaultPhaseInstruction(id)).toBeTruthy()
    }
  })

  it('returns undefined for a custom phase name', () => {
    expect(defaultPhaseInstruction('custom')).toBeUndefined()
  })
})
