import type { TextCaller } from '../src/engine'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resumeRoundtable, RoundtableConfigError, runRoundtable } from '../src/index'

const scratch: string[] = []

interface Call { prompt: string, system?: string }

function stubWith(reply: (call: Call) => string | Error): { callText: TextCaller, calls: Call[] } {
  const calls: Call[] = []
  const callText = (async (options: { prompt: string, system?: string }) => {
    const call: Call = { prompt: options.prompt, system: options.system }
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
  const dir = await mkdtemp(join(tmpdir(), 'rt-resume-'))
  scratch.push(dir)
  await mkdir(join(dir, 'seats'), { recursive: true })
  await writeFile(join(dir, 'table.md'), table, 'utf8')
  for (const [name, content] of Object.entries(seats)) {
    await writeFile(join(dir, 'seats', name), content, 'utf8')
  }
  return dir
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const TABLE = `---
title: 续跑会
maxAttempts: 1
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
---
选题。
`

const HOST = `---
id: host
role: 主持
---
收口。
`

describe('resumeRoundtable', () => {
  it('refuses a run directory with no state', async () => {
    const dir = await makeConfig(TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    await expect(resumeRoundtable({
      configDir: dir,
      runDir: join(dir, 'missing')
    })).rejects.toThrow(RoundtableConfigError)
  })

  it('refuses when the rules changed since the run started', async () => {
    const dir = await makeConfig(TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const { callText } = stubWith(() => '输出')
    const first = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText
    })

    // Editing a seat changes the fingerprint; the old progress no longer
    // describes the same meeting.
    await writeFile(join(dir, 'seats', 'host.md'), `${HOST}\n补充。\n`, 'utf8')
    await expect(resumeRoundtable({
      configDir: dir,
      runDir: first.runDir
    })).rejects.toThrow(/Rules changed/)
  })

  it('returns an already finished run without calling the model again', async () => {
    const dir = await makeConfig(TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const first = stubWith(() => '输出')
    const done = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText: first.callText
    })
    expect(first.calls).toHaveLength(2)

    const second = stubWith(() => '不该被调用')
    const resumed = await resumeRoundtable({
      configDir: dir,
      runDir: done.runDir,
      callText: second.callText
    })

    expect(second.calls).toHaveLength(0)
    expect(resumed.status).toBe('passed')
    expect(resumed.used).toBe(done.used)
  })

  it('reruns only the phases that never completed', async () => {
    const dir = await makeConfig(TABLE, { 'editor.md': EDITOR, 'host.md': HOST })
    const first = stubWith(call => call.system?.includes('收口。')
      ? new Error('boom')
      : '议题：某议题')
    const interrupted = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText: first.callText
    })
    expect(interrupted.status).toBe('rejected')

    // Mark the run as interrupted mid-way, as a crash would.
    const statePath = join(interrupted.runDir, 'state.json')
    const state = JSON.parse(await readFile(statePath, 'utf8'))
    state.status = 'running'
    state.rounds = [
      {
        attempt: 1,
        phases: [
          {
            id: 'propose',
            status: 'completed',
            statements: [
              {
                seat: 'editor',
                name: '选题',
                role: '选题',
                phase: 'propose',
                status: 'completed',
                content: '议题：某议题'
              }
            ]
          }
        ]
      }
    ]
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')

    const second = stubWith(() => '结论：可以推进')
    const resumed = await resumeRoundtable({
      configDir: dir,
      runDir: interrupted.runDir,
      callText: second.callText
    })

    expect(resumed.status).toBe('passed')
    // Only the converge seat ran; the proposal was preserved.
    expect(second.calls).toHaveLength(1)
    expect(second.calls[0]!.system).toContain('收口。')
    const phases = resumed.record.rounds[0]!.phases
    expect(phases[0]!.statements[0]!.content).toBe('议题：某议题')
  })
})
