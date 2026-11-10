import type { Statement } from '../src/prompt'
import type { Call } from './helpers'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRoundtable } from '../src/config'
import { resumeRoundtable, RoundtableConfigError, runRoundtable } from '../src/index'
import { aiError, cleanupScratch, fakeClock, makeConfig, stubText } from './helpers'

afterEach(cleanupScratch)

/** One table, several seats — the shape of a real review meeting. */
const TABLE = `---
title: 文章审核圆桌
durationMs: 60000
maxPoolTokens: 5000
threshold: 0.6
onVeto: re-propose
maxAttempts: 2
---
`

const SEATS = {
  'grom.md': `---
id: grom
role: 门店读者视角
identity:
  name: 格罗姆
  avatar: 🏪
seat:
---
格罗姆。
`,
  'jaina.md': `---
id: jaina
role: 品牌与表达
identity:
  name: 吉安娜
  avatar: ✍️
seat:
---
吉安娜。
`,
  'uther.md': `---
id: uther
role: 合规与风险
identity:
  name: 乌瑟尔
  avatar: ⚖️
seat:
  canVeto: true
---
乌瑟尔。
`,
  'medivh.md': `---
id: medivh
role: 事实核查
identity:
  name: 麦迪文
  avatar: 🛡️
seat:
---
麦迪文。
`
}

const pass = JSON.stringify({ verdict: 'pass', reason: '' })

/**
 * A reply function for e2e runs.
 *
 * Seats close with a passing vote unless the test supplies another reply.
 */
function seatReplies(
  replies: Record<string, string | ((call: Call, index: number) => Promise<string | Error>)> = {}
): (call: Call, index: number) => string | Error | Promise<string | Error> {
  return (call, index) => {
    for (const [marker, reply] of Object.entries(replies)) {
      if (call.system?.trimEnd().endsWith(marker)) {
        return typeof reply === 'function'
          ? reply(call, index)
          : reply
      }
    }
    return pass
  }
}

/**
 * A stepping clock: a discussion ends when the simulated time is used up, not
 * when the machine happens to be fast enough. Every read costs 100ms.
 */
const clock = () => fakeClock(undefined, 100)

async function readRun(runDir: string) {
  return {
    record: JSON.parse(await readFile(join(runDir, 'record.json'), 'utf8')),
    state: JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')),
    minutes: await readFile(join(runDir, 'record.md'), 'utf8')
  }
}

describe('runRoundtable', () => {
  it('opens its own question when no topic is given', async () => {
    // The rule file is in every seat's system prompt, so a table can be told what
    // to decide without the caller carrying the question. An empty topic is the
    // same as none: it must not reach the prompt as a blank heading.
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText, calls } = stubText({
      reply: () => pass
    })
    const result = await runRoundtable({ configDir: dir, topic: '', callText })
    expect(result.status).not.toBe('rejected')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0]?.prompt ?? '').not.toContain('## 议题')
  })

  it('writes record.json, record.md and state.json into a directory named by start time', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText } = stubText({
      reply: () => pass
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: '这篇能不能发',
      brief: '机审刚过',
      context: ['文章正文', '素材'],
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })

    expect(result.runDir).toMatch(/[\\/]\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/)
    expect(result.recordPath).toBe(join(result.runDir, 'record.json'))

    const { record, state, minutes } = await readRun(result.runDir)
    expect(record.schema).toBe(2)
    expect(record.title).toBe('文章审核圆桌')
    expect(record.topic).toBe('这篇能不能发')
    expect(record.brief).toBe('机审刚过')
    expect(record.status).toBe('passed')
    expect(record.attempts).toBe(1)
    expect(record.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    expect(record.finishedAt).toBeTruthy()
    expect(record.verdict).toEqual({ passed: true, vetoed: [], score: 1 })
    expect(record.statements[0]).toMatchObject({
      seat: 'grom',
      name: '格罗姆',
      role: '门店读者视角',
      status: 'completed',
      content: '',
      speech: '',
      finished: true,
      verdict: 'pass'
    })
    expect(record.usage).toEqual({ input: 0, output: 0 })
    expect(state.schema).toBe(2)
    expect(state.status).toBe('passed')
    expect(state.fingerprint).toMatch(/^sha256:/)
    expect(minutes).toContain('# 文章审核圆桌')
    expect(minutes).toContain('**议题**：这篇能不能发')
    expect(minutes).toContain('**背景**：机审刚过')
    expect(minutes).toContain('**格罗姆 🏪 门店读者视角**')
    expect(minutes).toContain('**缺席**：无')
  })

  it('puts the topic, brief and numbered material in front of every seat', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText, calls } = stubText({
      reply: () => pass
    })
    await runRoundtable({
      configDir: dir,
      topic: '这篇能不能发',
      brief: '刚过机审',
      context: ['文章正文', '素材'],
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    const prompt = calls[0]!.prompt
    expect(prompt).toContain('## 议题\n\n这篇能不能发')
    expect(prompt).toContain('## 背景\n\n刚过机审')
    expect(prompt).toContain('### 材料 1\n\n文章正文')
    expect(prompt).toContain('### 材料 2\n\n素材')
  })

  it('uses the seat persona and offers the closing tool', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText, calls } = stubText({
      reply: () => pass
    })
    await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(calls[0]!.system).toContain('你是格罗姆')
    expect(calls[0]!.system).toContain('格罗姆。')
    expect(calls[0]!.schema).toMatchObject({ type: 'object' })
  })

  it('decides with the weighted votes, not with the prose', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: {
        'grom.md': SEATS['grom.md'],
        'jaina.md': SEATS['jaina.md'],
        'uther.md': SEATS['uther.md']
      }
    })
    // 吉安娜 passes, 乌瑟尔 rejects with a reason, 格罗姆 passes by default: 2/3
    // of the weight, but the veto decides regardless of the arithmetic.
    const { callText } = stubText({
      reply: seatReplies({
        '乌瑟尔。': JSON.stringify({ verdict: 'reject', reason: '这句话会被截图传播' })
      })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.status).toBe('rejected')
    expect(result.record.verdict.score).toBeCloseTo(2 / 3)
    expect(result.record.verdict.vetoed).toEqual(['uther'])
    // The human-readable minutes name the seat that blocked it, not its id.
    const vetoedRun = await readRun(result.runDir)
    expect(vetoedRun.minutes).toContain('**结论**：未通过（通过率')
    expect(vetoedRun.minutes).toContain('乌瑟尔否决')
  })

  it('opens another discussion for onVeto revise just as for re-propose', async () => {
    const dir = await makeConfig({
      table: TABLE
        .replace('onVeto: re-propose', 'onVeto: revise')
        .replace('durationMs: 60000', 'durationMs: 2000'),
      seats: { 'grom.md': SEATS['grom.md'], 'uther.md': SEATS['uther.md'] }
    })
    const { callText, calls } = stubText({
      reply: seatReplies({
        '乌瑟尔。': JSON.stringify({ verdict: 'reject', reason: '方向对但做法不对' })
      })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.record.attempts).toBe(2)
    const secondRound = calls.filter(call => call.prompt.includes('## 上一轮的否决理由'))
    expect(secondRound.length).toBeGreaterThan(0)
    expect(secondRound[0]!.prompt).toContain('方向对但做法不对')
  })

  it('aborts immediately when onVeto is abort and the table is vetoed', async () => {
    const dir = await makeConfig({
      table: TABLE.replace('onVeto: re-propose', 'onVeto: abort'),
      seats: { 'grom.md': SEATS['grom.md'], 'uther.md': SEATS['uther.md'] }
    })
    const { callText } = stubText({
      reply: seatReplies({
        '乌瑟尔。': JSON.stringify({ verdict: 'reject', reason: '承诺效果不能发' })
      })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.status).toBe('aborted')
    expect(result.record.attempts).toBe(1)
    expect(result.record.verdict.vetoed).toEqual(['uther'])
    expect(result.record.error).toContain('onVeto: abort')
  })

  it('opens a second discussion with the veto reasons on the table', async () => {
    // A veto is what carries forward: a plain rejection is a vote, not a reason
    // the next round must open with.
    const dir = await makeConfig({
      table: TABLE.replace('durationMs: 60000', 'durationMs: 2000'),
      seats: { 'grom.md': SEATS['grom.md'], 'uther.md': SEATS['uther.md'] }
    })
    const { callText, calls } = stubText({
      reply: seatReplies({
        '乌瑟尔。': JSON.stringify({ verdict: 'reject', reason: '还没给出第一步' })
      })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.record.attempts).toBe(2)
    // The second discussion opens by being told why the first one did not pass.
    const secondRound = calls.filter(call => call.prompt.includes('## 上一轮的否决理由'))
    expect(secondRound.length).toBeGreaterThan(0)
    expect(secondRound[0]!.prompt).toContain('还没给出第一步')
  })

  it('reports rejected once maxAttempts is used up', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText } = stubText({
      reply: () => JSON.stringify({ verdict: 'reject', reason: '还是不行' })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.status).toBe('rejected')
    expect(result.record.attempts).toBe(2)
  })

  it('aborts the meeting when a seat with fallback: abort fails', async () => {
    const seats = {
      'grom.md': SEATS['grom.md'].replace('seat:\n', 'seat:\n  fallback: abort\n')
    }
    const dir = await makeConfig({ table: TABLE, seats })
    const { callText } = stubText({
      reply: () => new Error('凭证过期')
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.status).toBe('aborted')
    expect(result.record.error).toContain('凭证过期')
    expect(result.record.statements[0]!.status).toBe('failed')
  })

  it('skips a failing seat and records it as absent, not as a vote', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: {
        'grom.md': SEATS['grom.md'],
        'medivh.md': SEATS['medivh.md']
      }
    })
    const { callText } = stubText({
      reply: seatReplies({
        '麦迪文。': () => aiError('network', true)
      })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    // 格罗姆 passed; 麦迪文's absence does not drag the ratio to 0.
    expect(result.status).toBe('passed')
    expect(result.record.verdict.score).toBe(1)
    const failed = result.record.statements.filter(item => item.status === 'failed')
    expect(failed.map(item => item.seat)).toEqual(['medivh'])
    expect(result.record.statements.some(item => item.seat === 'medivh' && item.verdict !== undefined)).toBe(false)
  })

  it('marks a veto without a reason as invalid-veto and does not count it', async () => {
    // One discussion only: every seat speaks once, so the recorded statement is
    // the one whose status the veto rule is about.
    const dir = await makeConfig({
      table: TABLE
        .replace('durationMs: 60000', 'durationMs: 2000')
        .replace('maxAttempts: 2', 'maxAttempts: 1'),
      seats: {
        'grom.md': SEATS['grom.md'],
        'uther.md': SEATS['uther.md']
      }
    })
    const { callText } = stubText({
      reply: seatReplies({
        '乌瑟尔。': JSON.stringify({ verdict: 'reject' })
      })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    const fromUther = result.record.statements.filter(item => item.seat === 'uther')
    expect(fromUther.length).toBeGreaterThan(0)
    // Every veto with no reason on record is marked, and none of them counts.
    expect(fromUther.every(item => item.status === 'invalid-veto')).toBe(true)
    expect(result.record.verdict.vetoed).toEqual([])
    const { minutes } = await readRun(result.runDir)
    expect(minutes).toContain('被忽略的否决')
  })

  it('counts every call it paid for and has no call budget', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'], 'jaina.md': SEATS['jaina.md'] }
    })
    const { callText, calls } = stubText({
      reply: () => pass
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.used).toBe(result.record.statements.length)
    expect(result.used).toBe(calls.length)
    expect(result.record).not.toHaveProperty('budget')
    expect(result.record).not.toHaveProperty('rounds')
  })

  it('reports progress through a callback', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const lines: string[] = []
    const { callText } = stubText({
      reply: () => pass
    })
    await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now,
      onProgress: line => lines.push(line)
    })
    expect(lines.some(line => line.includes('第 1 轮讨论开始'))).toBe(true)
    expect(lines.some(line => line.includes('格罗姆'))).toBe(true)
  })

  it('stamps every statement with when it landed', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText } = stubText({
      reply: (_call, index) => JSON.stringify({ verdict: 'pass', reason: `第 ${index} 句` })
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(result.record.statements.length).toBeGreaterThan(0)
    for (const statement of result.record.statements) {
      expect(Date.parse(statement.at)).toBeGreaterThan(0)
    }
  })

  it('does not retry a failure that cannot succeed later', async () => {
    const auth = await aiError('auth', false)
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText, calls } = stubText({
      reply: () => auth
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    expect(calls).toHaveLength(1)
    expect(result.status).toBe('rejected')
  })
})

describe('artifacts', () => {
  /** A writing seat: plain text output, so a long draft is a statement, not a vote. */
  const WRITER = `---
id: writer
role: 作者
identity:
  name: 执笔
---
执笔。
`

  it('writes an oversized statement to its own file and references it', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'writer.md': WRITER }
    })
    const long = '长'.repeat(9_000)
    const { callText } = stubText({
      reply: () => long
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })

    const statement = result.record.statements.find((item: Statement) => item.seat === 'writer')!
    expect(statement.artifacts).toHaveLength(1)
    const artifact = statement.artifacts![0]!
    // Forward slashes, relative to the run directory, per the contract. The attempt
    // number is in the name so a retry never overwrites the previous draft.
    expect(artifact.path).toMatch(/^artifacts\/attempt-\d+-writer-\d+\.md$/)
    const saved = await readFile(join(result.runDir, artifact.path), 'utf8')
    expect(saved).toBe(long)
    expect(artifact.bytes).toBe(new TextEncoder().encode(long).byteLength)
  })

  it('keeps a short statement inline', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'writer.md': WRITER }
    })
    const { callText } = stubText({
      reply: () => '短内容'
    })
    const result = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })
    const statement = result.record.statements[0]!
    expect(statement.artifacts).toBeUndefined()
    expect(statement.content).toBe('短内容')
  })
})

describe('resumeRoundtable', () => {
  it('refuses a directory with no state', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    await expect(resumeRoundtable({
      configDir: dir,
      runDir: join(dir, 'missing')
    })).rejects.toThrow(RoundtableConfigError)
  })

  it('refuses when the rules changed since the run started', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText } = stubText({
      reply: () => pass
    })
    const first = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })

    await writeFile(join(dir, 'seats', 'grom.md'), SEATS['grom.md'].replace('格罗姆。', '格罗姆，改过。'), 'utf8')
    await expect(resumeRoundtable({ configDir: dir, runDir: first.runDir }))
      .rejects
      .toThrow(/Rules changed/)
  })

  it('re-renders a finished run without paying for it again', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const first = stubText({
      reply: () => pass
    })
    const done = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText: first.callText,
      now: clock().now
    })
    expect(first.calls.length).toBeGreaterThan(0)

    const second = stubText({
      reply: () => '不该被调用'
    })
    const resumed = await resumeRoundtable({
      configDir: dir,
      runDir: done.runDir,
      callText: second.callText,
      now: clock().now
    })
    expect(second.calls).toHaveLength(0)
    expect(resumed.status).toBe('passed')
    expect(resumed.used).toBe(done.used)
    expect(resumed.record.statements).toEqual(done.record.statements)
  })

  it('continues from the pool already on disk, keeping what was said', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText } = stubText({
      reply: () => pass
    })
    const done = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })

    // Simulate a crash: marked running, one line already on the table.
    const statePath = join(done.runDir, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const kept: Statement = {
      seat: 'grom',
      name: '格罗姆',
      role: '门店读者视角',
      at: new Date().toISOString(),
      status: 'completed',
      content: '这篇文章说的是我遇到的问题',
      verdict: 'pass'
    }
    state.status = 'running'
    state.pool = [kept]
    state.attempts = [
      {
        attempt: 1,
        startedAt: state.startedAt,
        statements: [kept]
      }
    ]
    state.usage = { input: 0, output: 0 }
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')

    const second = stubText({
      reply: () => pass
    })
    const resumed = await resumeRoundtable({
      configDir: dir,
      runDir: done.runDir,
      callText: second.callText,
      now: clock().now
    })
    expect(resumed.status).toBe('passed')
    expect(resumed.record.statements[0]!.content).toBe('这篇文章说的是我遇到的问题')
    // The kept line survives and the resumed seat speaks on top of it. One new
    // statement is the expected shape here: a single seat has nobody to answer,
    // so the meeting ends after its line instead of looping to the deadline.
    expect(resumed.record.statements.length).toBe(2)
    // The resumed seat was asked with the kept line on the table.
    expect(second.calls[0]!.prompt).toContain('这篇文章说的是我遇到的问题')
  })

  it('drops straight to the verdict when the remaining time is gone', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const { callText } = stubText({
      reply: () => pass
    })
    const done = await runRoundtable({
      configDir: dir,
      topic: 'q',
      outDir: join(dir, 'out'),
      callText,
      now: clock().now
    })

    const statePath = join(done.runDir, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    const kept: Statement = {
      seat: 'grom',
      name: '格罗姆',
      role: '门店读者视角',
      at: '2026-11-06T08:00:10+08:00',
      status: 'completed',
      content: '',
      speech: '',
      finished: true,
      verdict: 'pass'
    }
    state.status = 'running'
    // Started long ago: nothing is left of `durationMs`.
    state.startedAt = isoLocalDaysAgo(30)
    state.pool = [kept]
    state.attempts = [
      {
        attempt: 1,
        startedAt: state.startedAt,
        statements: [kept]
      }
    ]
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')

    const second = stubText({
      reply: () => '不该被调用'
    })
    const lines: string[] = []
    const resumed = await resumeRoundtable({
      configDir: dir,
      runDir: done.runDir,
      callText: second.callText,
      now: clock().now,
      onProgress: line => lines.push(line)
    })
    expect(second.calls).toHaveLength(0)
    expect(lines.some(line => line.includes('剩余时间为 0'))).toBe(true)
    expect(resumed.status).toBe('passed')
  })

  it('treats a run left in failed state as finished', async () => {
    const dir = await makeConfig({
      table: TABLE,
      seats: { 'grom.md': SEATS['grom.md'] }
    })
    const loaded = await loadRoundtable({ configDir: dir })
    const runDir = join(dir, 'out', '2026-11-06T08-00-00')
    await mkdir(runDir, { recursive: true })
    await writeFile(join(runDir, 'state.json'), JSON.stringify({
      schema: 2,
      runId: '2026-11-06T08-00-00',
      status: 'failed',
      attempt: 1,
      startedAt: '2026-11-06T08:00:00+08:00',
      finishedAt: '2026-11-06T08:00:05+08:00',
      topic: 'q',
      context: [],
      pool: [],
      attempts: [],
      usage: { input: 0, output: 0 },
      fingerprint: loaded.fingerprint,
      error: 'connection lost'
    }, null, 2), 'utf8')

    const second = stubText({
      reply: () => '不该被调用'
    })
    const resumed = await resumeRoundtable({ configDir: dir, runDir, callText: second.callText })
    expect(second.calls).toHaveLength(0)
    expect(resumed.status).toBe('failed')
    expect(resumed.record.error).toBe('connection lost')
  })
})

/** An ISO timestamp `days` behind now, with the local offset. */
function isoLocalDaysAgo(days: number): string {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0
    ? '+'
    : '-'
  const absolute = Math.abs(offset)
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
    sign,
    pad(Math.floor(absolute / 60)),
    ':',
    pad(absolute % 60)
  ].join('')
}
