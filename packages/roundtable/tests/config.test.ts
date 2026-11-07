import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkRoundtable, loadRoundtable, RoundtableConfigError } from '../src/config'
import { readFrontmatter } from '../src/frontmatter'
import { parseTable, TABLE_DEFAULTS, TableError } from '../src/table'
import { cleanupScratch, makeConfig } from './helpers'

afterEach(cleanupScratch)

function table(source: string, fallbackTitle = '目录名') {
  return parseTable(readFrontmatter(source, 'table.md'), fallbackTitle)
}

/** The final config from 03-table.md, pasted as-is. */
const FINAL_TABLE = `---
title: 文章审核圆桌
durationMs: 180000
maxPoolTokens: 5000

threshold: 0.6
onVeto: abort
maxAttempts: 1
---

# 文章审核圆桌

一篇文章写完、通过机器审核之后，交给这张圆桌再过一遍。
`

const UTHER = `---
id: uther
role: 合规与风险

identity:
  name: 乌瑟尔
  title: 内容合规审核
  background: 见过因为一句话被投诉、被截图传播的案例

persona:
  stance: 拿不准的一律删
  style: 冷静、不带情绪

seat:
  canVeto: true
  weight: 1
  maxTokens: 80
  fallback: skip
  output: json
---

你负责判断这篇文章能不能公开。
一次只说一句：哪里不能发，或者可以发。
`

describe('parseTable', () => {
  it('reads the documented final config', () => {
    expect(table(FINAL_TABLE)).toEqual({
      title: '文章审核圆桌',
      durationMs: 180000,
      maxPoolTokens: 5000,
      threshold: 0.6,
      onVeto: 'abort',
      maxAttempts: 1,
      // The body is the meeting's own rules and now travels with the config.
      body: '# 文章审核圆桌\n\n一篇文章写完、通过机器审核之后，交给这张圆桌再过一遍。'
    })
  })

  it('reads output fields as a mapping of field name to its constraint', () => {
    const parsed = table(`---
output:
  fields:
    title: 文章标题
    content: 文章正文
---`)
    expect(parsed.outputFields).toEqual({
      title: '文章标题',
      content: '文章正文'
    })
  })

  it('leaves outputFields absent when a table declares none', () => {
    expect(table('---\ndurationMs: 60000\n---').outputFields).toBeUndefined()
    // An empty mapping is the same as no declaration: nothing to settle.
    expect(table('---\noutput:\n  fields:\n---').outputFields).toBeUndefined()
  })

  it('rejects a malformed output declaration', () => {
    expect(() => table('---\noutput:\n  fields:\n    - title\n---')).toThrow(/must be a mapping/)
    expect(() => table('---\noutput:\n  fields:\n    title: 标题\n  extra: 1\n---')).toThrow(/unknown field/)
    expect(() => table('---\noutput:\n  fields:\n    title: "  "\n---')).toThrow(/non-empty constraint/)
    // A name that is not a plain word never reaches the field parser: the YAML
    // layer rejects the quoted key first. Either way it is refused.
    expect(() => table('---\noutput:\n  fields:\n    "有 空格": 标题\n---')).toThrow(/table\.md/)
  })

  it('applies every default when the table states nothing', () => {
    expect(table('---\ndurationMs: 60000\n---')).toEqual({
      title: '目录名',
      durationMs: 60000,
      maxPoolTokens: TABLE_DEFAULTS.maxPoolTokens,
      threshold: TABLE_DEFAULTS.threshold,
      onVeto: TABLE_DEFAULTS.onVeto,
      maxAttempts: TABLE_DEFAULTS.maxAttempts
    })
    expect(TABLE_DEFAULTS).toEqual({
      durationMs: 180000,
      maxPoolTokens: 3000,
      threshold: 0.5,
      onVeto: 're-propose',
      maxAttempts: 3
    })
  })

  it('rejects unknown fields, including the ones this model removed', () => {
    expect(() => table('---\nphases:\n  - id: propose\n---')).toThrow(/unknown field.*phases/)
    expect(() => table('---\nbudget:\n  total: 10\n---')).toThrow(/unknown field.*budget/)
    expect(() => table('---\nschedule: daily\n---')).toThrow(/unknown field.*schedule/)
    expect(() => table('---\ntimeoutMs: 1000\n---')).toThrow(/unknown field.*timeoutMs/)
  })

  it('requires positive integers', () => {
    for (const field of ['durationMs', 'maxPoolTokens', 'maxAttempts']) {
      expect(() => table(`---\n${field}: 0\n---`)).toThrow(new RegExp(`${field} must be a positive integer`))
      expect(() => table(`---\n${field}: -1\n---`)).toThrow(new RegExp(`${field} must be a positive integer`))
      expect(() => table(`---\n${field}: 1.5\n---`)).toThrow(new RegExp(`${field} must be a positive integer`))
      expect(() => table(`---\n${field}: "180000"\n---`)).toThrow(new RegExp(`${field} must be a`))
    }
  })

  it('keeps threshold within 0 and 1, both ends included', () => {
    expect(table('---\nthreshold: 0\n---').threshold).toBe(0)
    expect(table('---\nthreshold: 1\n---').threshold).toBe(1)
    expect(() => table('---\nthreshold: 1.2\n---')).toThrow(/threshold must be between 0 and 1/)
    expect(() => table('---\nthreshold: -0.1\n---')).toThrow(/threshold must be between 0 and 1/)
    expect(() => table('---\nthreshold: high\n---')).toThrow(/threshold must be a number/)
  })

  it('accepts only the three onVeto actions', () => {
    for (const value of ['re-propose', 'revise', 'abort']) {
      expect(table(`---\nonVeto: ${value}\n---`).onVeto).toBe(value)
    }
    expect(() => table('---\nonVeto: retry\n---')).toThrow(/onVeto must be re-propose, revise or abort/)
  })

  it('names the table it came from', () => {
    try {
      table('---\ndurationMs: 0\n---')
    }
    catch (error) {
      expect(error).toBeInstanceOf(TableError)
      expect((error as Error).message.startsWith('table: ')).toBe(true)
      return
    }
    throw new Error('expected parse to fail')
  })
})

describe('loadRoundtable', () => {
  it('loads the table, every seat, and only enables the attending ones', async () => {
    const dir = await makeConfig({
      table: FINAL_TABLE,
      seats: {
        'uther.md': UTHER,
        'grom.md': `---
id: grom
role: 门店读者视角
enabled: false
---
一次只说一句。
`
      }
    })
    const loaded = await loadRoundtable({ configDir: dir })
    expect(loaded.table.title).toBe('文章审核圆桌')
    expect(loaded.seats.map(seat => seat.id)).toEqual(['grom', 'uther'])
    expect([
      ...loaded.byId.keys()
    ]).toEqual(['uther'])
    expect(loaded.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('reports a missing directory, a missing table and a missing seats folder', async () => {
    const missing = join(await makeConfig({ table: FINAL_TABLE, seats: {} }), 'nope')
    await expect(loadRoundtable({ configDir: missing })).rejects.toThrow(/not found/)

    const noTable = await makeConfig({ table: FINAL_TABLE, seats: {} })
    const { rm } = await import('node:fs/promises')
    await rm(join(noTable, 'table.md'))
    await expect(loadRoundtable({ configDir: noTable })).rejects.toThrow(/Missing table\.md/)

    const noSeats = await makeConfig({ table: FINAL_TABLE, seats: {} })
    await expect(loadRoundtable({ configDir: noSeats })).rejects.toThrow(/No seat files/)
  })

  it('rejects duplicate ids naming both files', async () => {
    const dir = await makeConfig({
      table: FINAL_TABLE,
      seats: {
        'a.md': UTHER,
        'b.md': UTHER
      }
    })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/Duplicate seat id "uther" in a\.md and b\.md/)
  })

  it('rejects a table with no seat left to attend', async () => {
    const dir = await makeConfig({
      table: FINAL_TABLE,
      seats: {
        'uther.md': UTHER.replace('  output: json\n', '  output: json\n').replace('\nidentity:', '\nenabled: false\n\nidentity:')
      }
    })
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/Every seat is disabled/)
  })

  it('wraps seat, table and frontmatter errors as config errors', async () => {
    const badSeat = await makeConfig({
      table: FINAL_TABLE,
      seats: {
        'bad.md': '---\nrole: 无 id\n---'
      }
    })
    await expect(loadRoundtable({ configDir: badSeat })).rejects.toThrow(RoundtableConfigError)

    const badTable = await makeConfig({
      table: '---\ndurationMs: nope\n---',
      seats: { 'u.md': UTHER }
    })
    await expect(loadRoundtable({ configDir: badTable })).rejects.toThrow(RoundtableConfigError)

    const badYaml = await makeConfig({
      table: '---\ntitle: [unclosed\n---',
      seats: { 'u.md': UTHER }
    })
    await expect(loadRoundtable({ configDir: badYaml })).rejects.toThrow(RoundtableConfigError)
  })

  it('includes ignored seats in the fingerprint so toggling one changes it', async () => {
    const table = '---\ntitle: 指纹\n---'
    const dir = await makeConfig({
      table,
      seats: {
        'a.md': '---\nid: a\nrole: 甲\n---\n甲。',
        'b.md': '---\nid: b\nrole: 乙\n---\n乙。'
      }
    })
    const before = await loadRoundtable({ configDir: dir })
    await writeFile(join(dir, 'seats', 'b.md'), '---\nid: b\nrole: 乙\nenabled: false\n---\n乙。', 'utf8')
    const after = await loadRoundtable({ configDir: dir })
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.byId.has('b')).toBe(false)
  })

  it('changes the fingerprint when the table changes', async () => {
    const dir = await makeConfig({
      table: '---\ntitle: 一个名字\n---',
      seats: { 'u.md': UTHER }
    })
    const before = await loadRoundtable({ configDir: dir })
    await writeFile(join(dir, 'table.md'), '---\ntitle: 另一个名字\n---', 'utf8')
    const after = await loadRoundtable({ configDir: dir })
    expect(after.fingerprint).not.toBe(before.fingerprint)
  })

  it('checks without touching a model or the environment', async () => {
    const dir = await makeConfig({
      table: FINAL_TABLE,
      seats: { 'uther.md': UTHER }
    })
    const loaded = await checkRoundtable({ configDir: dir })
    expect(loaded.byId.size).toBe(1)
  })

  it('orders seats by file name regardless of locale', async () => {
    const dir = await makeConfig({
      table: '---\ntitle: 排序\n---',
      seats: {
        '02-b.md': '---\nid: b\nrole: 乙\n---\n乙。',
        '01-a.md': '---\nid: a\nrole: 甲\n---\n甲。'
      }
    })
    const loaded = await loadRoundtable({ configDir: dir })
    expect(loaded.seats.map(seat => seat.id)).toEqual(['a', 'b'])
  })

  it('rejects a table.md that is a directory', async () => {
    const dir = await makeConfig({
      table: '---\ntitle: x\n---',
      seats: { 'u.md': UTHER }
    })
    const { rm } = await import('node:fs/promises')
    await rm(join(dir, 'table.md'))
    await mkdir(join(dir, 'table.md'))
    await expect(loadRoundtable({ configDir: dir })).rejects.toThrow(/not a file/)
  })
})
