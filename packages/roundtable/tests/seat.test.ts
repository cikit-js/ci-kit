import type { Seat } from '../src/seat'
import { describe, expect, it } from 'vitest'
import { readFrontmatter } from '../src/frontmatter'
import { parseSeat, renderSeatSystemPrompt } from '../src/seat'

function seatFrom(source: string): Seat {
  return parseSeat(readFrontmatter(source, 'seat.md'), 'seat.md')
}

const FULL = `---
id: guard
role: 事实审核

identity:
  name: 周慎
  avatar: 🛡️
  title: 做了十年事实核查的老审核
  background: 见过太多「有出处但没出处对」的引用

persona:
  stance: 宁可错杀，不可放过
  personality: [较真, 不留情面]
  style: 冷静
  speech: 每条只问一句话
  values: 一条没有原文支撑的观点，等于没有观点
  quirks: 看到数字就要追问口径
  avoid: 不做风格评价

seat:
  canVeto: true
---

你负责核对每个观点是否有依据。
`

describe('renderSeatSystemPrompt', () => {
  it('follows the documented section order', () => {
    const prompt = renderSeatSystemPrompt(seatFrom(FULL))
    const order = [
      '## 背景',
      '## 你的性格',
      '## 你的立场',
      '## 你的说话方式',
      '## 你的原则',
      '## 你的边界',
      '你负责核对'
    ]
    const positions = order.map(marker => prompt.indexOf(marker))
    for (const position of positions) {
      expect(position).toBeGreaterThan(-1)
    }
    const sorted = [...positions].sort((a, b) => a - b)
    expect(positions).toEqual(sorted)
  })

  it('opens with a name and role line', () => {
    const prompt = renderSeatSystemPrompt(seatFrom(FULL))
    expect(prompt.split('\n')[0]).toContain('周慎')
    expect(prompt.split('\n')[0]).toContain('事实审核')
  })

  it('omits empty sections entirely', () => {
    const prompt = renderSeatSystemPrompt(seatFrom(`---
id: bare
role: 旁听
---

只听。
`))
    expect(prompt).not.toContain('## 背景')
    expect(prompt).not.toContain('## 你的性格')
    expect(prompt).not.toContain('## 你的立场')
    expect(prompt).not.toContain('## 你的说话方式')
    expect(prompt).not.toContain('## 你的原则')
    expect(prompt).not.toContain('## 你的边界')
    expect(prompt).toContain('只听。')
    // No dangling empty heading: every '## ' line is followed by content.
    const lines = prompt.split('\n')
    lines.forEach((line, index) => {
      if (line.startsWith('## ')) {
        expect(lines[index + 1]?.trim()).not.toBe('')
      }
    })
  })

  it('appends the markdown body verbatim', () => {
    const prompt = renderSeatSystemPrompt(seatFrom(FULL))
    expect(prompt.trimEnd().endsWith('你负责核对每个观点是否有依据。')).toBe(true)
  })

  it('groups style, speech and quirks under the speech section', () => {
    const prompt = renderSeatSystemPrompt(seatFrom(FULL))
    const section = prompt.slice(prompt.indexOf('## 你的说话方式'), prompt.indexOf('## 你的原则'))
    expect(section).toContain('冷静')
    expect(section).toContain('每条只问一句话')
    expect(section).toContain('看到数字就要追问口径')
  })
})

describe('parseSeat', () => {
  it('reads the documented fields', () => {
    const seat = seatFrom(FULL)
    expect(seat.id).toBe('guard')
    expect(seat.role).toBe('事实审核')
    expect(seat.identity.name).toBe('周慎')
    expect(seat.identity.avatar).toBe('🛡️')
    expect(seat.persona.personality).toEqual(['较真', '不留情面'])
    expect(seat.seat.canVeto).toBe(true)
  })

  it('falls back to role when name is absent', () => {
    const seat = seatFrom('---\nid: x\nrole: 编辑\n---\n')
    expect(seat.identity.name).toBe('编辑')
  })

  it('rejects a non-numeric weight', () => {
    expect(() => seatFrom('---\nid: x\nrole: r\nseat:\n  weight: two\n---\n'))
      .toThrow(/seat\.weight must be a number/)
  })

  it('rejects an invalid fallback value', () => {
    expect(() => seatFrom('---\nid: x\nrole: r\nseat:\n  fallback: ignore\n---\n'))
      .toThrow(/fallback must be skip/)
  })

  it('rejects an invalid output value', () => {
    expect(() => seatFrom('---\nid: x\nrole: r\nseat:\n  output: html\n---\n'))
      .toThrow(/output must be text/)
  })

  it('rejects an empty sees list', () => {
    expect(() => seatFrom('---\nid: x\nrole: r\nseat:\n  sees: []\n---\n'))
      .toThrow(/sees/)
  })

  it('rejects an id with spaces', () => {
    expect(() => seatFrom('---\nid: a b\nrole: r\n---\n')).toThrow(/letters, digits/)
  })

  it('rejects a missing role', () => {
    expect(() => seatFrom('---\nid: x\n---\n')).toThrow(/role is required/)
  })
})
