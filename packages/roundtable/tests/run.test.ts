import type { TextCaller } from '../src/engine'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRoundtable } from '../src/index'

const scratch: string[] = []

interface Call { prompt: string, system?: string, json?: boolean }

/** Stub that answers per seat id, recording what each seat was asked. */
function stubWith(reply: (call: Call) => string | Error): { callText: TextCaller, calls: Call[] } {
  const calls: Call[] = []
  const callText = (async (options: { prompt: string, system?: string, json?: boolean }) => {
    const call: Call = { prompt: options.prompt, system: options.system, json: options.json }
    calls.push(call)
    const value = reply(call)
    if (value instanceof Error) {
      throw value
    }
    return { value, provider: 'stub', model: 'stub-model' }
  }) as unknown as TextCaller
  return { callText, calls }
}

async function makeConfig(table: string, seats: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rt-run-'))
  scratch.push(dir)
  const seatsDir = join(dir, 'seats')
  await mkdir(seatsDir, { recursive: true })
  await writeFile(join(dir, 'table.md'), table, 'utf8')
  for (const [name, content] of Object.entries(seats)) {
    await writeFile(join(seatsDir, name), content, 'utf8')
  }
  return dir
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const SIMPLE_TABLE = `---
title: 简单会
budget:
  total: 10
maxAttempts: 2
phases:
  - id: propose
    seats: [editor]
  - id: converge
    seats: [host]
---
`

const EDITOR = `---
id: editor
role: 选题
seat:
  phase: [propose]
  canPropose: true
---
挑选议题。
`

const HOST = `---
id: host
role: 主持
seat:
  phase: [converge]
  lead: true
---
收口。
`

describe('runRoundtable', () => {
  it('runs a meeting and writes the four outputs', async () => {
    const dir = await makeConfig(SIMPLE_TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const out = join(dir, 'out')
    const { callText } = stubWith(call => call.prompt.includes('## 前序发言')
      ? '结论：先做小范围验证。'
      : '议题：交接班记录缺口值得单独处理。')

    const result = await runRoundtable({
      configDir: dir,
      outDir: out,
      context: ['材料一'],
      callText
    })

    expect(result.status).toBe('passed')
    expect(result.used).toBe(2)
    expect(result.record.attempts).toBe(1)
    expect(result.record.title).toBe('简单会')

    const state = JSON.parse(await readFile(join(result.runDir, 'state.json'), 'utf8'))
    const record = JSON.parse(await readFile(join(result.runDir, 'record.json'), 'utf8'))
    const minutes = await readFile(join(result.runDir, 'record.md'), 'utf8')
    expect(state.finishedAt).toBeTruthy()
    expect(record.status).toBe('passed')
    expect(minutes).toContain('# 简单会')
    expect(minutes).toContain('交接班记录缺口')
  })

  it('gives the propose phase the material and the converge phase the proposal', async () => {
    const dir = await makeConfig(SIMPLE_TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const { callText, calls } = stubWith(() => '输出')
    await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      context: ['材料一'],
      callText
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.prompt).toContain('材料一')
    expect(calls[0]!.prompt).not.toContain('## 前序发言')
    expect(calls[1]!.prompt).toContain('## 前序发言')
  })

  it('uses the seat persona as the system prompt', async () => {
    const dir = await makeConfig(SIMPLE_TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const { callText, calls } = stubWith(() => '输出')
    await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })

    expect(calls[0]!.system).toContain('选题')
    expect(calls[0]!.system).toContain('挑选议题。')
  })

  it('honours a human topic override', async () => {
    const dir = await makeConfig(SIMPLE_TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const { callText, calls } = stubWith(() => '输出')
    await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      topic: '要不要做会员积分互通',
      callText
    })
    expect(calls[0]!.prompt).toContain('要不要做会员积分互通')
  })

  it('keeps a seat with sees none blind to prior statements', async () => {
    const table = `---
phases:
  - id: propose
    seats: [editor]
  - id: review
    seats: [guard]
    vetoable: true
---
`
    const guard = `---
id: guard
role: 审核
seat:
  phase: [review]
  sees: none
  canVeto: true
  output: json
---
核对。
`
    const dir = await makeConfig(table, { 'editor.md': EDITOR, 'guard.md': guard })
    const { callText, calls } = stubWith(call => call.json
      ? JSON.stringify({ verdict: 'pass' })
      : '议题：某议题')
    await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })

    expect(calls[1]!.prompt).not.toContain('## 前序发言')
    expect(calls[1]!.prompt).not.toContain('某议题')
  })

  it('lets a vetoed meeting loop and feeds the veto reason forward', async () => {
    const table = `---
maxAttempts: 2
phases:
  - id: propose
    seats: [editor]
  - id: review
    seats: [guard]
    vetoable: true
---
`
    const guard = `---
id: guard
role: 审核
seat:
  phase: [review]
  sees: none
  canVeto: true
  output: json
---
核对。
`
    const dir = await makeConfig(table, { 'editor.md': EDITOR, 'guard.md': guard })
    let reviewCount = 0
    const { callText, calls } = stubWith((call) => {
      if (call.json) {
        reviewCount++
        // Reject the first pass, accept the second.
        return JSON.stringify(reviewCount === 1
          ? { verdict: 'reject', reason: '缺少门店证据' }
          : { verdict: 'pass' })
      }
      return '议题：某议题'
    })

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })

    expect(result.status).toBe('passed')
    expect(result.record.attempts).toBe(2)
    // The second proposal saw the veto reason from the first attempt.
    const secondProposals = calls.filter(call => !call.json)
    expect(secondProposals).toHaveLength(2)
    expect(secondProposals[1]!.prompt).toContain('缺少门店证据')
  })

  it('reports rejected once attempts are exhausted', async () => {
    const table = `---
maxAttempts: 2
phases:
  - id: propose
    seats: [editor]
  - id: review
    seats: [guard]
    vetoable: true
---
`
    const guard = `---
id: guard
role: 审核
seat:
  phase: [review]
  sees: none
  canVeto: true
  output: json
---
核对。
`
    const dir = await makeConfig(table, { 'editor.md': EDITOR, 'guard.md': guard })
    const { callText } = stubWith(call => call.json
      ? JSON.stringify({ verdict: 'reject', reason: '一直不合格' })
      : '议题：某议题')

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })
    expect(result.status).toBe('rejected')
    expect(result.record.attempts).toBe(2)
    expect(result.record.verdict.vetoed).toEqual(['guard'])
  })

  it('stops when the budget runs out', async () => {
    const table = `---
budget:
  total: 1
phases:
  - id: propose
    seats: [editor]
  - id: converge
    seats: [host]
---
`
    const dir = await makeConfig(table, { 'editor.md': EDITOR, 'host.md': HOST })
    const { callText, calls } = stubWith(() => '输出')

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })

    expect(result.status).toBe('aborted')
    expect(calls).toHaveLength(1)
    expect(result.record.error).toContain('预算')
  })

  it('skips a failing seat and records it as absent', async () => {
    const table = `---
phases:
  - id: discuss
    seats: [editor, host]
---
`
    const dir = await makeConfig(table, {
      'editor.md': `---
id: editor
role: 甲
---
甲。
`,
      'host.md': `---
id: host
role: 乙
---
乙。
`
    })
    const { callText } = stubWith((call) => {
      if (call.system?.includes('甲。')) {
        throw new Error('boom')
      }
      return '正常发言'
    })

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })
    const statements = result.record.rounds[0]!.phases[0]!.statements
    expect(statements.find(item => item.seat === 'editor')!.status).toBe('failed')
    expect(statements.find(item => item.seat === 'host')!.status).toBe('completed')
    // Every phase completed, so a meeting without a judgement still passes.
    expect(result.status).toBe('passed')
  })

  it('aborts the whole meeting when a seat asks for it', async () => {
    const table = `---
phases:
  - id: discuss
    seats: [editor, host]
---
`
    const dir = await makeConfig(table, {
      'editor.md': `---
id: editor
role: 甲
seat:
  fallback: abort
---
甲。
`,
      'host.md': `---
id: host
role: 乙
---
乙。
`
    })
    const { callText, calls } = stubWith((call) => {
      if (call.system?.includes('甲。')) {
        throw new Error('boom')
      }
      return '正常'
    })

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })
    expect(result.status).toBe('aborted')
    // The host never ran.
    expect(calls).toHaveLength(1)
  })

  it('marks an invalid JSON reply as a failed seat', async () => {
    const table = `---
phases:
  - id: review
    seats: [guard]
    vetoable: true
---
`
    const guard = `---
id: guard
role: 审核
seat:
  output: json
  canVeto: true
---
核对。
`
    const dir = await makeConfig(table, { 'guard.md': guard })
    const { callText } = stubWith(() => '这不是 JSON')

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })
    const statement = result.record.rounds[0]!.phases[0]!.statements[0]!
    expect(statement.status).toBe('failed')
    expect(statement.error).toContain('JSON')
  })

  it('prunes a phase whose dependency produced nothing', async () => {
    const table = `---
phases:
  - id: propose
    seats: [editor]
  - id: converge
    seats: [host]
---
`
    const dir = await makeConfig(table, { 'editor.md': EDITOR, 'host.md': HOST })
    const { callText } = stubWith((call) => {
      if (call.system?.includes('挑选议题。')) {
        throw new Error('boom')
      }
      return '不该被调用'
    })

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })
    const converge = result.record.rounds[0]!.phases[1]!
    expect(converge.status).toBe('skipped')
    expect(converge.pruned).toBe(true)
    expect(result.status).toBe('rejected')
  })

  it('runs a parallel phase without letting seats see each other', async () => {
    const table = `---
phases:
  - id: discuss
    seats: [editor, host]
    mode: parallel
---
`
    const dir = await makeConfig(table, {
      'editor.md': `---
id: editor
role: 甲
---
甲。
`,
      'host.md': `---
id: host
role: 乙
---
乙。
`
    })
    const { callText, calls } = stubWith(() => '发言')
    await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })

    for (const call of calls) {
      expect(call.prompt).not.toContain('## 前序发言')
    }
  })

  it('treats a text seat rejection without a reason as an invalid veto', async () => {
    const table = `---
maxAttempts: 1
phases:
  - id: review
    seats: [guard]
    vetoable: true
---
`
    const guard = `---
id: guard
role: 审核
seat:
  canVeto: true
---
核对。
`
    const dir = await makeConfig(table, { 'guard.md': guard })
    const { callText } = stubWith(() => '否决')

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })
    expect(result.record.verdict.invalidVetoes).toEqual(['guard'])
    const minutes = await readFile(join(result.runDir, 'record.md'), 'utf8')
    expect(minutes).toContain('被忽略的否决')
  })
})
