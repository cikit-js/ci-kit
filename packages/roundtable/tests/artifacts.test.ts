import type { TextCaller } from '../src/engine'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runRoundtable } from '../src/index'

const scratch: string[] = []

function stubWith(reply: () => string): TextCaller {
  return (async () => ({
    value: reply(),
    provider: 'stub',
    model: 'stub'
  })) as unknown as TextCaller
}

async function makeConfig(table: string, seats: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rt-artifact-'))
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
title: 产物测试
phases:
  - id: produce
    seats: [writer]
---
`

const WRITER = `---
id: writer
role: 作者
---
写作。
`

describe('artifacts', () => {
  it('writes an oversized body to artifacts and records the reference', async () => {
    const dir = await makeConfig(TABLE, { 'writer.md': WRITER })
    const long = '长'.repeat(9_000)

    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText: stubWith(() => long)
    })

    const statement = result.record.rounds[0]!.phases[0]!.statements[0]!
    expect(statement.artifacts).toHaveLength(1)
    expect(statement.artifacts![0]!.path).toBe('artifacts/attempt-1-writer-produce.md')

    const file = join(result.runDir, 'artifacts', 'attempt-1-writer-produce.md')
    const saved = await readFile(file, 'utf8')
    expect(saved).toBe(long)
    expect(statement.artifacts![0]!.bytes).toBe((await stat(file)).size)

    // The reference is also listed at the record level for downstream tools.
    expect(result.record.artifacts).toEqual(['artifacts/attempt-1-writer-produce.md'])

    const minutes = await readFile(join(result.runDir, 'record.md'), 'utf8')
    expect(minutes).toContain('## 产物')
    expect(minutes).toContain('artifacts/attempt-1-writer-produce.md')
  })

  it('keeps a short body inline with no artifact', async () => {
    const dir = await makeConfig(TABLE, { 'writer.md': WRITER })
    const result = await runRoundtable({
      configDir: dir,
      outDir: join(dir, 'out'),
      callText: stubWith(() => '短内容')
    })
    const statement = result.record.rounds[0]!.phases[0]!.statements[0]!
    expect(statement.artifacts).toBeUndefined()
    expect(statement.content).toBe('短内容')
    expect(result.record.artifacts).toBeUndefined()
  })
})
