import type { Statement } from '../src/prompt'
import type { Seat } from '../src/seat'
import { describe, expect, it } from 'vitest'
import { readFrontmatter } from '../src/frontmatter'
import { buildUserPrompt, verdictInstruction, visibleStatements } from '../src/prompt'
import { parseSeat } from '../src/seat'

function seat(source: string): Seat {
  return parseSeat(readFrontmatter(source, 'f.md'), 'f.md')
}

const OPEN = seat(`---
id: grom
role: 门店读者视角
identity:
  name: 格罗姆
---`)

const BLIND = seat(`---
id: guard
role: 事实审核
identity:
  name: 周慎
seat:
  sees: none
  output: json
---`)

function statement(overrides: Partial<Statement>): Statement {
  return {
    seat: 'jaina',
    name: '吉安娜',
    role: '品牌与表达',
    at: '2026-11-06T08:00:11+08:00',
    status: 'completed',
    content: '开头太平，读者会划走。',
    ...overrides
  }
}

const POOL: Statement[] = [
  statement({
    seat: 'grom',
    name: '格罗姆',
    role: '门店读者视角',
    content: '这个方案我们店做不到'
  }),
  statement({
    seat: 'jaina',
    name: '吉安娜',
    role: '品牌与表达',
    content: '开头太平，读者会划走'
  }),
  statement({
    seat: 'medivh',
    name: '麦迪文',
    role: '事实核查',
    status: 'failed',
    content: '',
    error: 'network: boom'
  }),
  statement({
    seat: 'grom',
    name: '格罗姆',
    role: '门店读者视角',
    content: '不过第三个动作可以试'
  })
]

describe('visibleStatements', () => {
  it('shows the whole pool to a seat that hears everyone', () => {
    expect(visibleStatements(OPEN, POOL).map(item => item.content)).toEqual([
      '这个方案我们店做不到',
      '开头太平，读者会划走',
      '不过第三个动作可以试'
    ])
  })

  it('shows nothing to a seat that judges on its own', () => {
    expect(visibleStatements(BLIND, POOL)).toEqual([])
  })

  it('leaves failed statements out of what anyone hears', () => {
    const contents = visibleStatements(OPEN, POOL).map(item => item.content)
    expect(contents.some(text => text.includes('boom'))).toBe(false)
    expect(visibleStatements(OPEN, POOL).some(item => item.status !== 'completed')).toBe(false)
  })
})

describe('buildUserPrompt', () => {
  it('labels the four blocks in the documented order', () => {
    const prompt = buildUserPrompt({
      topic: '这篇《昨天的服务》能不能发',
      brief: '刚通过机器审核，需要几个人从不同角度再过一遍。',
      context: ['文章正文', '素材'],
      visible: [
        statement({})
      ]
    })
    const order = [
      '## 议题',
      '## 背景',
      '## 材料',
      '## 前序发言',
      '## 输出要求'
    ]
    const positions = order.map(heading => prompt.indexOf(heading))
    expect(positions.every(index => index >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(prompt).toContain('这篇《昨天的服务》能不能发')
    expect(prompt).toContain('刚通过机器审核')
  })

  it('numbers the material so a seat can cite it', () => {
    const prompt = buildUserPrompt({
      topic: '问题',
      context: ['文章正文', '素材'],
      visible: []
    })
    expect(prompt).toContain('### 材料 1\n\n文章正文')
    expect(prompt).toContain('### 材料 2\n\n素材')
  })

  it('omits optional blocks instead of leaving empty headings', () => {
    const prompt = buildUserPrompt({ topic: '只有议题', context: [], visible: [] })
    expect(prompt).toContain('## 议题\n\n只有议题')
    expect(prompt).not.toContain('## 背景')
    expect(prompt).not.toContain('## 材料')
    expect(prompt).not.toContain('## 前序发言')
    expect(prompt).not.toContain('## 上一轮的否决理由')
  })

  it('shows a blind seat the topic but none of the discussion', () => {
    const prompt = buildUserPrompt({
      topic: '文章能不能发',
      brief: '机审已过',
      context: ['文章正文'],
      visible: visibleStatements(BLIND, POOL)
    })
    expect(prompt).toContain('文章能不能发')
    expect(prompt).toContain('文章正文')
    expect(prompt).not.toContain('## 前序发言')
    expect(prompt).not.toContain('开头太平')
  })

  it('renders a statement with who said it, not which seat id it was', () => {
    const prompt = buildUserPrompt({
      topic: 'q',
      context: [],
      visible: [
        statement({})
      ]
    })
    expect(prompt).toContain('### 吉安娜 · 品牌与表达\n\n开头太平，读者会划走。')
    expect(prompt).not.toContain('jaina')
  })

  it('says how many older statements were trimmed', () => {
    const prompt = buildUserPrompt({
      topic: 'q',
      context: [],
      visible: [
        statement({})
      ],
      dropped: 3
    })
    expect(prompt).toContain('更早的 3 条发言已超出长度上限')
  })

  it('carries the previous round veto reasons to every seat', () => {
    const prompt = buildUserPrompt({
      topic: 'q',
      context: [],
      visible: visibleStatements(BLIND, POOL),
      revisionNotes: ['乌瑟尔（合规与风险）：提到具体金额不能公开']
    })
    expect(prompt).toContain('## 上一轮的否决理由')
    expect(prompt).toContain('提到具体金额不能公开')
  })
})

describe('verdictInstruction', () => {
  it('asks for material and never for an approval', () => {
    const text = verdictInstruction(seat(`---
id: guard
role: 审核
seat:
  output: json
---`))
    expect(text).toContain('"verdict":"pass|reject"')
    expect(text).toContain('不要写 approved')
    expect(text).not.toContain('你有否决权')
  })

  it('tells a veto holder that a veto needs a reason', () => {
    const text = verdictInstruction(seat(`---
id: guard
role: 审核
seat:
  output: json
  canVeto: true
---`))
    expect(text).toContain('你有否决权')
    expect(text).toContain('没有理由的否决会被忽略')
  })
})
