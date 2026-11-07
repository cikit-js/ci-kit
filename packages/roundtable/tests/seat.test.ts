import { describe, expect, it } from 'vitest'
import { readFrontmatter } from '../src/frontmatter'
import { parseSeat, renderSeatSystemPrompt, SEAT_DEFAULTS, SeatError } from '../src/seat'

function parse(source: string) {
  return parseSeat(readFrontmatter(source, 'guard.md'), 'guard.md')
}

const GUARD = `---
id: guard
role: 事实审核

identity:
  name: 周慎
  avatar: 🛡️
  title: 做了十年事实核查的老审核
  background: 做过十年媒体事实核查，见过太多「有出处但没出处对」的引用

persona:
  stance: 宁可错杀，不可放过
  personality: [较真, 不留情面, 对引用敏感]
  style: 冷静、逐条、不绕弯
  speech: 说话像写核查单，每条只问一句话
  values: 一条没有原文支撑的观点，等于没有观点
  quirks: 看到数字就要追问口径和日期
  avoid: 不做风格评价，只管事实

seat:
  canVeto: true
  weight: 2
  maxTokens: 80
  fallback: skip
  output: json
---

你负责核对每个观点是否有依据。
`

describe('parseSeat', () => {
  it('reads the contract example field for field', () => {
    const seat = parse(GUARD)
    expect(seat.id).toBe('guard')
    expect(seat.role).toBe('事实审核')
    expect(seat.enabled).toBe(true)
    expect(seat.identity).toEqual({
      name: '周慎',
      avatar: '🛡️',
      title: '做了十年事实核查的老审核',
      background: '做过十年媒体事实核查，见过太多「有出处但没出处对」的引用'
    })
    expect(seat.persona.personality).toEqual(['较真', '不留情面', '对引用敏感'])
    expect(seat.persona.stance).toBe('宁可错杀，不可放过')
    expect(seat.seat).toEqual({
      canVeto: true,
      weight: 2,
      maxTokens: 80,
      fallback: 'skip',
      output: 'json'
    })
    expect(seat.body).toBe('你负责核对每个观点是否有依据。')
  })

  it('applies every documented default when a seat says nothing', () => {
    const seat = parse(`---
id: grom
role: 门店读者视角
---
一次只说一句。
`)
    expect(seat.seat.canVeto).toBe(false)
    expect(seat.seat.weight).toBe(1)
    expect(seat.seat.maxTokens).toBe(SEAT_DEFAULTS.maxTokens)
    expect(seat.seat.fallback).toBe('skip')
    expect(seat.seat.output).toBe('text')
    expect(seat.enabled).toBe(true)
  })

  it('falls the name back to the role', () => {
    const seat = parse(`---
id: grom
role: 门店读者视角
---`)
    expect(seat.identity.name).toBe('门店读者视角')
  })

  it('accepts a seat that is not attending', () => {
    const seat = parse(`---
id: grom
role: 读者
enabled: false
---`)
    expect(seat.enabled).toBe(false)
  })

  it('rejects an unknown group instead of ignoring it', () => {
    expect(() => parse(`---
id: grom
role: 读者
personna:
  stance: 保守
---`)).toThrow(/unknown field "personna"/)
  })

  it('rejects an unknown field inside a group', () => {
    expect(() => parse(`---
id: grom
role: 读者
persona:
  temper: 急躁
---`)).toThrow(/unknown field.*persona.*temper/)
  })

  it('requires id and role', () => {
    expect(() => parse(`---
role: 读者
---`)).toThrow(/id is required/)
    expect(() => parse(`---
id: grom
---`)).toThrow(/role is required/)
  })

  it('rejects an id that cannot be used as an anchor', () => {
    expect(() => parse(`---
id: 周慎
role: 读者
---`)).toThrow(/letters, digits, underscore or hyphen/)
  })

  it('accepts the documented flat form', () => {
    const seat = parse(`---
id: jaina
role: 品牌与表达
name: 吉安娜
avatar: ✍️
weight: 2
---
一次只说一句。
`)
    expect(seat.identity.name).toBe('吉安娜')
    expect(seat.identity.avatar).toBe('✍️')
    expect(seat.seat.weight).toBe(2)
  })

  it('rejects a flat field that is also written inside its group', () => {
    expect(() => parse(`---
id: jaina
role: 品牌与表达
weight: 2
seat:
  weight: 3
---`)).toThrow(/declared both at the top level and inside seat/)
  })

  it('rejects the fields the one-discussion model removed', () => {
    expect(() => parse(`---
id: grom
role: 读者
seat:
  phase: [discuss]
---`)).toThrow(/unknown field.*phase/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  lead: true
---`)).toThrow(/unknown field.*lead/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  canPropose: true
---`)).toThrow(/unknown field.*canPropose/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  budget: 3
---`)).toThrow(/unknown field.*budget/)
  })

  it('rejects the removed sees field instead of ignoring it', () => {
    // Visibility is gone: everyone hears the same pool, so a seat file that still
    // carries `sees` is a stale contract, and silence would leave it in place.
    expect(() => parse(`---
id: grom
role: 读者
seat:
  sees: none
---`)).toThrow(/unknown field.*sees/)
  })

  it('does not convert types implicitly', () => {
    expect(() => parse(`---
id: grom
role: 读者
seat:
  weight: "two"
---`)).toThrow(/weight must be a number/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  canVeto: "yes"
---`)).toThrow(/canVeto must be true or false/)
    expect(() => parse(`---
id: grom
role: 读者
enabled: 0
---`)).toThrow(/enabled must be true or false/)
  })

  it('checks range and enum values', () => {
    expect(() => parse(`---
id: grom
role: 读者
seat:
  weight: 0
---`)).toThrow(/weight must be greater than 0/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  maxTokens: 0
---`)).toThrow(/maxTokens must be a positive integer/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  fallback: ignore
---`)).toThrow(/fallback must be skip, retry or abort/)
    expect(() => parse(`---
id: grom
role: 读者
seat:
  output: markdown
---`)).toThrow(/output must be text or json/)
  })

  it('labels an error with the file it came from', () => {
    try {
      parse(`---
role: 读者
---`)
    }
    catch (error) {
      expect(error).toBeInstanceOf(SeatError)
      expect((error as Error).message.startsWith('seat guard.md: ')).toBe(true)
      return
    }
    throw new Error('expected parse to fail')
  })
})

describe('renderSeatSystemPrompt', () => {
  it('renders every section in the documented order', () => {
    expect(renderSeatSystemPrompt(parse(GUARD))).toBe([
      '你是周慎，做了十年事实核查的老审核。',
      '',
      '## 背景',
      '做过十年媒体事实核查，见过太多「有出处但没出处对」的引用',
      '',
      '## 你的性格',
      '较真、不留情面、对引用敏感',
      '',
      '## 你的立场',
      '宁可错杀，不可放过',
      '',
      '## 你的说话方式',
      '- 冷静、逐条、不绕弯',
      '- 说话像写核查单，每条只问一句话',
      '- 看到数字就要追问口径和日期',
      '',
      '## 你的原则',
      '一条没有原文支撑的观点，等于没有观点',
      '',
      '## 你的边界',
      '不做风格评价，只管事实',
      '',
      '你负责核对每个观点是否有依据。'
    ].join('\n'))
  })

  it('drops empty sections whole, title included', () => {
    const prompt = renderSeatSystemPrompt(parse(`---
id: grom
role: 门店读者视角
identity:
  name: 格罗姆
persona:
  stance: 先看门店能不能做到
---
一次只说一句。
`))
    expect(prompt).toBe([
      '你是格罗姆，是一名门店读者视角。',
      '',
      '## 你的立场',
      '先看门店能不能做到',
      '',
      '一次只说一句。'
    ].join('\n'))
    for (const heading of [
      '## 背景',
      '## 你的性格',
      '## 你的说话方式',
      '## 你的原则',
      '## 你的边界'
    ]) {
      expect(prompt).not.toContain(heading)
    }
  })

  it('keeps how it talks apart from how it judges', () => {
    const prompt = renderSeatSystemPrompt(parse(`---
id: uther
role: 合规与风险
persona:
  personality: [谨慎]
  stance: 拿不准的一律删
---
判断能不能公开。
`))
    expect(prompt).toContain('## 你的性格\n谨慎')
    expect(prompt).toContain('## 你的立场\n拿不准的一律删')
    expect(prompt.indexOf('## 你的性格')).toBeLessThan(prompt.indexOf('## 你的立场'))
  })
})
