import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadRoundtable, RoundtableConfigError } from '../src/config'

const scratch: string[] = []

async function makeConfig(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rt-config-'))
  scratch.push(dir)
  const seatsDir = join(dir, 'seats')
  await mkdir(seatsDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(name === 'table.md'
      ? dir
      : seatsDir, name), content, 'utf8')
  }
  return dir
}

afterEach(async () => {
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const TABLE = `---
title: 测试会
budget:
  total: 6
  perSeat: 2
phases:
  - id: propose
    seats: [editor]
  - id: review
    seats: [guard]
    vetoable: true
---
`

const EDITOR = `---
id: editor
role: 选题
seat:
  phase: [propose]
  canPropose: true
---
从材料里挑一个议题。
`

const GUARD = `---
id: guard
role: 审核
seat:
  phase: [review]
  canVeto: true
  sees: none
---
核对事实。
`

describe('loadRoundtable', () => {
  it('loads a valid table and seats', async () => {
    const dir = await makeConfig({ 'table.md': TABLE, 'editor.md': EDITOR, 'guard.md': GUARD })
    const loaded = await loadRoundtable({ configDir: dir })

    expect(loaded.table.title).toBe('测试会')
    expect(loaded.table.budget).toEqual({ total: 6, perSeat: 2 })
    expect(loaded.phases.map(phase => phase.id)).toEqual(['propose', 'review'])
    expect(loaded.phases[0]!.seats).toEqual(['editor'])
    expect(loaded.phases[1]!.seats).toEqual(['guard'])
    expect(loaded.byId.get('guard')!.seat.sees).toBe('none')
  })

  it('derives phase participants from seat.phase when the table omits seats', async () => {
    const table = `---
phases:
  - id: propose
  - id: review
    vetoable: true
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR, 'guard.md': GUARD })
    const loaded = await loadRoundtable({ configDir: dir })
    expect(loaded.phases[0]!.seats).toEqual(['editor'])
    expect(loaded.phases[1]!.seats).toEqual(['guard'])
  })

  it('defaults unseen fields per the design', async () => {
    const dir = await makeConfig({
      'table.md': TABLE,
      'editor.md': 'id: editor\nrole: 选题\n',
      'guard.md': GUARD
    })
    const loaded = await loadRoundtable({ configDir: dir })
    const editor = loaded.byId.get('editor')!
    expect(editor.identity.name).toBe('选题')
    expect(editor.seat.sees).toBe('all')
    expect(editor.seat.fallback).toBe('skip')
    expect(editor.seat.output).toBe('text')
    expect(editor.seat.weight).toBe(1)
    expect(editor.enabled).toBe(true)
  })

  it('fails when the config directory is missing', async () => {
    await expect(loadRoundtable({
      configDir: join(tmpdir(), 'does-not-exist-rt')
    }))
      .rejects
      .toThrow(RoundtableConfigError)
  })

  it('fails when table.md is missing', async () => {
    const dir = await makeConfig({ 'editor.md': EDITOR, 'guard.md': GUARD })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/Missing table.md/)
  })

  it('fails when seats/ has no seat files', async () => {
    const dir = await makeConfig({ 'table.md': TABLE })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/No seat files/)
  })

  it('rejects duplicate seat ids', async () => {
    const dir = await makeConfig({
      'table.md': TABLE,
      'a.md': 'id: dup\nrole: 甲\n',
      'b.md': 'id: dup\nrole: 乙\n'
    })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/Duplicate seat id/)
  })

  it('rejects a phase naming an unknown seat', async () => {
    const table = `---
phases:
  - id: propose
    seats: [ghost]
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/unknown seat "ghost"/)
  })

  it('rejects a phase whose seats all belong to other phases', async () => {
    const table = `---
phases:
  - id: review
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/no participating seats/)
  })

  it('rejects duplicate phase ids', async () => {
    const table = `---
phases:
  - id: propose
  - id: propose
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/duplicate phase id/)
  })

  it('rejects a require pointing forward in time', async () => {
    const table = `---
phases:
  - id: propose
    requires: [review]
  - id: review
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR, 'guard.md': GUARD })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/comes later/)
  })

  it('rejects a require pointing at an unknown phase', async () => {
    const table = `---
phases:
  - id: propose
    requires: [ghost]
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/requires unknown phase/)
  })

  it('rejects a seat listed in a phase it does not attend', async () => {
    const table = `---
phases:
  - id: review
    seats: [editor, guard]
    vetoable: true
---
`
    const dir = await makeConfig({ 'table.md': table, 'editor.md': EDITOR, 'guard.md': GUARD })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/seat.phase does not include it/)
  })

  it('rejects unknown fields at every level', async () => {
    const dir = await makeConfig({
      'table.md': TABLE,
      'editor.md': 'id: editor\nrole: 选题\nbogus: 1\n',
      'guard.md': GUARD
    })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/unknown field "bogus"/)

    const dir2 = await makeConfig({
      'table.md': TABLE,
      'editor.md': 'id: editor\nrole: 选题\npersona:\n  temper: 急\n',
      'guard.md': GUARD
    })
    await expect(loadRoundtable({ configDir: dir2 })).rejects.toThrow(/unknown field in persona: temper/)
  })

  it('rejects a field declared both flat and grouped', async () => {
    const dir = await makeConfig({
      'table.md': TABLE,
      'editor.md': 'id: editor\nrole: 选题\nname: 甲\nidentity:\n  name: 乙\n',
      'guard.md': GUARD
    })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/declared both at the top level/)
  })

  it('fails when every seat is disabled', async () => {
    const dir = await makeConfig({
      'table.md': TABLE,
      'editor.md': 'id: editor\nrole: 选题\nenabled: false\n',
      'guard.md': 'id: guard\nrole: 审核\nenabled: false\n'
    })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/at least one enabled seat/)
  })

  it('skips disabled seats when resolving participants', async () => {
    const dir = await makeConfig({
      'table.md': TABLE,
      'editor.md': EDITOR,
      'guard.md': `${GUARD.replace('    sees: none', '    sees: none\n    lead: true')}\n`,
      'extra.md': `---
id: extra
role: 旁听
enabled: false
seat:
  phase: [review]
---
`
    })
    const loaded = await loadRoundtable({ configDir: dir })
    expect(loaded.phases[1]!.seats).toEqual(['guard'])
  })

  it('changes the fingerprint only when rules change', async () => {
    const dir = await makeConfig({ 'table.md': TABLE, 'editor.md': EDITOR, 'guard.md': GUARD })
    const first = await loadRoundtable({ configDir: dir })
    const second = await loadRoundtable({ configDir: dir })
    expect(first.fingerprint).toBe(second.fingerprint)
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)

    await writeFile(join(dir, 'seats', 'guard.md'), `${GUARD}\n补充一句。\n`, 'utf8')
    const third = await loadRoundtable({ configDir: dir })
    expect(third.fingerprint).not.toBe(first.fingerprint)
  })

  it('orders seats in a phase by priority then id', async () => {
    const table = `---
phases:
  - id: discuss
---
`
    const dir = await makeConfig({
      'table.md': table,
      'a.md': 'id: b-seat\nrole: 乙\nseat:\n  priority: 1\n',
      'b.md': 'id: a-seat\nrole: 甲\nseat:\n  priority: 1\n',
      'c.md': 'id: c-seat\nrole: 丙\nseat:\n  priority: 5\n'
    })
    const loaded = await loadRoundtable({ configDir: dir })
    expect(loaded.phases[0]!.seats).toEqual(['a-seat', 'b-seat', 'c-seat'])
  })
})
