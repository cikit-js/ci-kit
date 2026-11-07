import type { LoadedRoundtable } from '../src/config'
import type { Statement } from '../src/prompt'
import type { Seat } from '../src/seat'
import { describe, expect, it } from 'vitest'
import { discuss, estimateTokens, finalVotes, trimPool } from '../src/engine'
import { readFrontmatter } from '../src/frontmatter'
import { parseSeat } from '../src/seat'
import { aiError, fakeClock, stubText } from './helpers'

function seat(source: string): Seat {
  return parseSeat(readFrontmatter(source, 'f.md'), 'f.md')
}

const A = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
---
甲。
`)
const B = seat(`---
id: b
role: 乙
identity:
  name: 阿乙
---
乙。
`)

function loaded(seats: Seat[], overrides: { durationMs?: number, maxPoolTokens?: number, outputFields?: Record<string, string> } = {}): LoadedRoundtable {
  const enabled = seats.filter(item => item.enabled)
  return {
    table: {
      title: '测试',
      durationMs: overrides.durationMs ?? 3_000,
      maxPoolTokens: overrides.maxPoolTokens ?? 3000,
      threshold: 0.6,
      onVeto: 'abort',
      maxAttempts: 1,
      ...(overrides.outputFields
        ? { outputFields: overrides.outputFields }
        : {})
    },
    seats,
    byId: new Map(enabled.map(item => [item.id, item])),
    configDir: '/nowhere',
    fingerprint: 'sha256:test'
  }
}

describe('estimateTokens', () => {
  it('counts a Han character as about one token', () => {
    expect(estimateTokens('一二三四五')).toBe(5)
  })

  it('counts latin text at about four characters per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('counts an empty statement as nothing', () => {
    expect(estimateTokens('')).toBe(0)
  })
})

describe('trimPool', () => {
  function statement(content: string, at = '2026-11-06T08:00:00+08:00'): Statement {
    return {
      seat: 'a',
      name: '阿甲',
      role: '甲',
      at,
      status: 'completed',
      content
    }
  }

  it('keeps everything that fits', () => {
    const pool = [
      statement('一'),
      statement('二')
    ]
    expect(trimPool(pool, 10)).toEqual({ kept: pool, dropped: 0 })
  })

  it('drops the oldest statements and counts them', () => {
    const pool = [
      statement('一'),
      statement('二'),
      statement('三')
    ]
    const result = trimPool(pool, 2)
    expect(result.kept.map(item => item.content)).toEqual(['二', '三'])
    expect(result.dropped).toBe(1)
  })

  it('always keeps the newest statement even when it alone exceeds the cap', () => {
    const pool = [
      statement('一'),
      statement('很长的发言'.repeat(100))
    ]
    const result = trimPool(pool, 5)
    expect(result.kept).toHaveLength(1)
    expect(result.kept[0]!.content.startsWith('很长的发言')).toBe(true)
  })

  it('leaves an empty pool alone', () => {
    expect(trimPool([], 10)).toEqual({ kept: [], dropped: 0 })
  })
})

describe('discuss', () => {
  it('lets every seat talk at once and share the pool', async () => {
    const clock = fakeClock()
    const { callText, calls } = stubText({
      reply: (call, index) => {
        // Each call advances the clock so a seat is not in an infinite loop.
        clock.advance(1_000)
        return `第 ${index + 1} 句`
      }
    })
    const result = await discuss({
      // 1.5s: one call per seat before the deadline closes.
      loaded: loaded([A, B], { durationMs: 1_500 }),
      topic: '要不要发',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(calls).toHaveLength(2)
    // Both seats were asked in the same round, without waiting for each other.
    expect(calls[0]!.prompt).not.toContain('## 前序发言')
    expect(calls[1]!.prompt).not.toContain('## 前序发言')
    expect(result.statements).toHaveLength(2)
  })

  it('has every seat say one line, then ends the meeting', async () => {
    const clock = fakeClock()
    const { callText, calls } = stubText({
      reply: () => {
        clock.advance(1_000)
        return '一句'
      }
    })
    const result = await discuss({
      loaded: loaded([A, B], { durationMs: 3_000 }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    // Two seats, each speaks once. Then both are waiting for the other and the
    // room is stalled — the meeting ends on agreement, not on the deadline.
    expect(calls).toHaveLength(2)
    expect(result.statements).toHaveLength(2)
    expect(new Set(result.statements.map(item => item.seat)).size).toBe(2)
  })

  it('waits for a request already in flight when the deadline passes', async () => {
    const clock = fakeClock()
    const { callText } = stubText({
      reply: () => {
        // The call takes longer than the whole discussion.
        clock.advance(10_000)
        return '迟到的发言'
      }
    })
    const result = await discuss({
      loaded: loaded([A], { durationMs: 3_000 }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    // Paid for, so the statement lands even though the time is up.
    expect(result.statements).toHaveLength(1)
    expect(result.statements[0]!.content).toBe('迟到的发言')
  })

  it('puts the pool in front of a seat that comes back for a second line', async () => {
    // The opening turn is simultaneous, so every first line lands on an empty
    // table — that is the nature of a real roundtable, not a visibility filter.
    // What matters is the next turn: a seat that speaks again reads the pool.
    const spoken: string[] = []
    let firstTurn = true
    const { callText } = stubText({
      reply: (call) => {
        // 甲 never yields after its first line, so 乙's second turn happens
        // once 甲's first statement is on the table.
        if (call.system?.includes('阿甲')) {
          return '甲说话了'
        }
        spoken.push(call.prompt)
        firstTurn = false
        return '乙说话了'
      }
    })
    await discuss({
      loaded: loaded([A, B], { durationMs: 10_000 }),
      topic: 'q',
      context: [],
      callText,
      now: fakeClock(undefined, 200).now,
      sleep: async () => {}
    })
    // The opening line of each seat is unprepared, as it should be.
    expect(spoken[0]).not.toContain('## 前序发言')
    expect(firstTurn).toBe(false)
    // Whatever a later turn reads, it reads the whole completed pool — there is
    // no per-seat filter to give it a narrower view.
    for (const prompt of spoken.slice(1)) {
      expect(prompt).toContain('阿甲：')
    }
  })

  it('gives a seat that fails with skip a failed statement and lets others talk on', async () => {
    const clock = fakeClock()
    const { callText } = stubText({
      reply: (call) => {
        clock.advance(500)
        return call.system?.includes('甲。')
          ? new Error('boom')
          : '正常发言'
      }
    })
    const result = await discuss({
      loaded: loaded([A, B]),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    const failed = result.statements.filter(item => item.seat === 'a')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.status).toBe('failed')
    expect(failed[0]!.error).toBe('boom')
    // A seat that fails leaves the room; it does not vote and does not come back.
    expect(result.abortedBy).toBeUndefined()
    // The other seat still spoke: one failure does not cancel the meeting.
    expect(result.statements.filter(item => item.seat === 'b').length).toBeGreaterThanOrEqual(1)
  })

  it('retries a retryable failure for a seat with fallback: retry', async () => {
    const retrying = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  fallback: retry
---
甲。
`)
    const clock = fakeClock()
    let attempts = 0
    const error = await aiError('server', true)
    const { callText, calls } = stubText({
      reply: () => {
        clock.advance(500)
        attempts++
        // Fail once, then a real statement, then keep talking.
        return attempts === 1
          ? error
          : '补上了'
      }
    })
    await discuss({
      loaded: loaded([retrying], { durationMs: 1_000 }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(calls[0]!.retries).toBeUndefined()
    expect(calls.every(call => call.system?.includes('甲。'))).toBe(true)
    expect(attempts).toBe(2)
  })

  it('does not retry a failure that cannot succeed later', async () => {
    const retrying = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  fallback: retry
---
甲。
`)
    const clock = fakeClock()
    const error = await aiError('auth', false)
    const { callText, calls } = stubText({
      reply: () => {
        clock.advance(500)
        return error
      }
    })
    const result = await discuss({
      loaded: loaded([retrying]),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(calls).toHaveLength(1)
    expect(result.statements[0]!.status).toBe('failed')
  })

  it('ends the whole meeting for a seat with fallback: abort', async () => {
    const aborting = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  fallback: abort
---
甲。
`)
    const clock = fakeClock()
    const { callText } = stubText({
      reply: (call) => {
        clock.advance(500)
        return call.system?.includes('甲。')
          ? new Error('凭证失效')
          : '正常'
      }
    })
    const result = await discuss({
      loaded: loaded([aborting, B]),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(result.abortedBy?.seat).toBe('a')
    expect(result.abortedBy?.error).toBe('凭证失效')
  })

  it('sends maxTokens from the seat to the model', async () => {
    const terse = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  maxTokens: 40
---
甲。
`)
    const clock = fakeClock()
    const { callText, calls } = stubText({
      reply: () => {
        clock.advance(2_000)
        return '一句'
      }
    })
    await discuss({
      loaded: loaded([terse]),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(calls[0]!.maxTokens).toBe(40)
  })

  it('never asks a non-retry seat to be retried by the transport', async () => {
    const clock = fakeClock()
    const { callText, calls } = stubText({
      reply: () => {
        clock.advance(2_000)
        return '一句'
      }
    })
    await discuss({
      loaded: loaded([A], { durationMs: 2_500 }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(calls[0]!.retries).toBe(0)
  })

  it('marks an unparseable JSON reply as a failed statement', async () => {
    const voting = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const clock = fakeClock()
    const { callText, calls } = stubText({
      reply: () => {
        clock.advance(2_000)
        return '这不是 JSON'
      }
    })
    const result = await discuss({
      loaded: loaded([voting]),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(calls[0]!.schema).toMatchObject({ type: 'object' })
    expect(result.statements[0]!.status).toBe('failed')
    expect(result.statements[0]!.error).toContain('JSON')
    expect(result.statements[0]!.verdict).toBeUndefined()
  })

  it('adds up the usage it is given', async () => {
    const clock = fakeClock()
    const { callText } = stubText({
      reply: () => {
        clock.advance(2_000)
        return '一句'
      },
      usage: { input: 100, output: 10 }
    })
    const result = await discuss({
      loaded: loaded([A], { durationMs: 1_000 }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(result.usage).toEqual({ input: 100, output: 10 })
  })

  it('puts the sentence a JSON seat said into the pool, not its envelope', async () => {
    // A json seat replies with a document. The next seat has to read the
    // sentence inside it; handing it `{"speech":"…","finished":false}` turns the
    // discussion into parsing and the release note into a log dump.
    const first = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const clock = fakeClock(undefined, 300)
    let turn = 0
    const { callText } = stubText({
      reply: () => JSON.stringify({ speech: `我选第二个候选${++turn}`, finished: false })
    })
    const result = await discuss({
      loaded: loaded([first], { durationMs: 10_000 }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    // Nothing in the record is a JSON envelope: the pool and the release note
    // read the sentence, while `structured` keeps the reply as evidence.
    expect(result.statements.length).toBeGreaterThan(0)
    for (const statement of result.statements) {
      expect(statement.content).not.toContain('"speech"')
      expect(statement.content).toContain('我选第二个候选')
      expect(statement.speech).toBe(statement.content)
      expect(statement.structured).toEqual({ speech: statement.content, finished: false })
    }
  })

  it('reads the declared output back from the statements', async () => {
    const host = seat(`---
id: a
role: 主持
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const clock = fakeClock(undefined, 300)
    const { callText } = stubText({
      reply: () => JSON.stringify({
        speech: '定了',
        finished: true,
        output: {
          title: '位置该有人',
          content: '固定岗位不固定人'
        }
      })
    })
    const result = await discuss({
      loaded: loaded([host], {
        durationMs: 10_000,
        outputFields: { title: '文章标题', content: '文章正文' }
      }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(result.output).toEqual({
      title: '位置该有人',
      content: '固定岗位不固定人'
    })
  })

  it('reports no output when nobody filled the declared fields', async () => {
    const host = seat(`---
id: a
role: 主持
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const { callText } = stubText({
      // Talking about the fields is not filling them: the caller reads fields.
      reply: () => JSON.stringify({ speech: '大家再看看', finished: true })
    })
    const result = await discuss({
      loaded: loaded([host], {
        durationMs: 10_000,
        outputFields: { title: '文章标题', content: '文章正文' }
      }),
      topic: 'q',
      context: [],
      callText,
      now: fakeClock(undefined, 300).now,
      sleep: async () => {}
    })
    expect(result.output).toBeUndefined()
  })

  it('reports no output when the table declares no fields', async () => {
    const host = seat(`---
id: a
role: 主持
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const { callText } = stubText({
      reply: () => JSON.stringify({ speech: '说完了', finished: true })
    })
    const result = await discuss({
      loaded: loaded([host], { durationMs: 10_000 }),
      topic: 'q',
      context: [],
      callText,
      now: fakeClock(undefined, 300).now,
      sleep: async () => {}
    })
    expect(result.output).toBeUndefined()
  })

  it('accumulates output per field across statements', async () => {
    // One seat settles the title, a later one adds the body without repeating
    // it: neither statement carries the whole result on its own.
    const a = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const b = seat(`---
id: b
role: 乙
identity:
  name: 阿乙
seat:
  output: json
---
乙。
`)
    const clock = fakeClock(undefined, 300)
    let turn = 0
    const { callText } = stubText({
      reply: () => {
        turn++
        // The first statement settles the title; the second adds the body
        // without repeating it. Each carries only half of the result.
        return JSON.stringify(turn === 1
          ? {
              speech: '标题就这么定',
              finished: false,
              output: { title: '位置该有人' }
            }
          : {
              speech: '正文这样写',
              finished: true,
              output: { content: '固定岗位不固定人' }
            })
      }
    })
    const result = await discuss({
      loaded: loaded([a, b], {
        durationMs: 10_000,
        outputFields: { title: '文章标题', content: '文章正文' }
      }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    expect(result.output).toEqual({
      title: '位置该有人',
      content: '固定岗位不固定人'
    })
    expect(turn).toBeGreaterThan(1)
  })

  it('takes the newest value when a field is revised', async () => {
    const a = seat(`---
id: a
role: 甲
identity:
  name: 阿甲
seat:
  output: json
---
甲。
`)
    const clock = fakeClock(undefined, 300)
    let turn = 0
    const { callText } = stubText({
      reply: () => {
        turn++
        return JSON.stringify({
          speech: `第${turn}次`,
          finished: false,
          output: { title: `标题${turn}` }
        })
      }
    })
    const result = await discuss({
      loaded: loaded([a], {
        durationMs: 10_000,
        outputFields: { title: '文章标题' }
      }),
      topic: 'q',
      context: [],
      callText,
      now: clock.now,
      sleep: async () => {}
    })
    // A later statement overrides an earlier one for the same key.
    expect(result.output).toEqual({ title: `标题${turn}` })
  })
})

describe('finalVotes', () => {
  function voting(seatSource: string) {
    return seat(seatSource)
  }

  const GROM = voting(`---
id: grom
role: 读者
seat:
  output: json
---`)
  const UTHER = voting(`---
id: uther
role: 合规
seat:
  output: json
  canVeto: true
---`)

  function said(seatId: string, structured: unknown, content = '说一句'): Statement {
    return {
      seat: seatId,
      name: seatId,
      role: '',
      at: '2026-11-06T08:00:00+08:00',
      status: 'completed',
      content,
      structured,
      verdict: (structured as { verdict?: 'pass' | 'reject' })?.verdict
    }
  }

  it('takes the last statement of each seat as its word', () => {
    const votes = finalVotes([GROM], [
      said('grom', { verdict: 'reject' }),
      said('grom', { verdict: 'pass' })
    ])
    expect(votes).toEqual([
      {
        seatId: 'grom',
        weight: 1,
        vote: 'pass',
        veto: false
      }
    ])
  })

  it('collects one vote per seat, not one per statement', () => {
    const votes = finalVotes([GROM, UTHER], [
      said('grom', { verdict: 'pass' }),
      said('uther', { verdict: 'pass' }),
      said('grom', { verdict: 'pass' })
    ])
    expect(votes.map(vote => vote.seatId)).toEqual(['grom', 'uther'])
  })

  it('treats a plain-text seat as speaking, not voting', () => {
    const plain = voting(`---
id: jaina
role: 表达
---`)
    expect(finalVotes([plain], [
      said('jaina', undefined, '通过')
    ])).toEqual([])
  })

  it('treats a JSON seat without a verdict as not having voted', () => {
    expect(finalVotes([GROM], [
      said('grom', { reason: '还没想好' })
    ])).toEqual([])
  })

  it('only grants a veto to a seat that holds one and states a reason', () => {
    expect(finalVotes([UTHER], [
      said('uther', { verdict: 'reject', reason: '会被投诉' })
    ]))
      .toEqual([
        {
          seatId: 'uther',
          weight: 1,
          vote: 'reject',
          veto: true
        }
      ])
    // No reason on a structured veto: it is recorded, but it cannot block.
    expect(finalVotes([UTHER], [
      said('uther', { verdict: 'reject' })
    ])[0]!.veto).toBe(false)
    // A reason after a marker is a reason; the opening 「说一句」 is not.
    expect(finalVotes([UTHER], [
      said('uther', { verdict: 'reject' }, '说一句\n否决：会被投诉')
    ])[0]!.veto).toBe(true)
    // Rejecting without veto power is a vote, never a veto.
    expect(finalVotes([GROM], [
      said('grom', { verdict: 'reject', reason: '不好' })
    ])[0]!.veto).toBe(false)
  })

  it('keeps weight from the seat', () => {
    const heavy = voting(`---
id: grom
role: 读者
seat:
  output: json
  weight: 3
---`)
    expect(finalVotes([heavy], [
      said('grom', { verdict: 'pass' })
    ])[0]!.weight).toBe(3)
  })
})
