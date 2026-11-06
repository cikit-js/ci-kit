import { describe, expect, it } from 'vitest'
import { parseYaml, YamlError } from '../src/yaml'

describe('parseYaml', () => {
  it('parses flat scalars with types', () => {
    const value = parseYaml([
      'id: guard',
      'role: 事实审核',
      'enabled: true',
      'weight: 2',
      'ratio: 0.5',
      'empty:'
    ].join('\n'))
    expect(value).toEqual({
      id: 'guard',
      role: '事实审核',
      enabled: true,
      weight: 2,
      ratio: 0.5,
      empty: null
    })
  })

  it('keeps quoted strings literal', () => {
    const value = parseYaml('count: "4-6"\ntext: \'a: b\'\n')
    expect(value.count).toBe('4-6')
    expect(value.text).toBe('a: b')
  })

  it('parses inline lists including quoted commas', () => {
    const value = parseYaml('tags: [较真, 不留情面]\nsees: [writer, "a, b"]\n')
    expect(value.tags).toEqual(['较真', '不留情面'])
    expect(value.sees).toEqual(['writer', 'a, b'])
  })

  it('parses nested mappings', () => {
    const value = parseYaml([
      'identity:',
      '  name: 周慎',
      '  avatar: 🛡️',
      'persona:',
      '  stance: 宁可错杀',
      '  personality: [较真]',
      'seat:',
      '  canVeto: true'
    ].join('\n'))
    expect(value).toEqual({
      identity: { name: '周慎', avatar: '🛡️' },
      persona: {
        stance: '宁可错杀',
        personality: ['较真']
      },
      seat: { canVeto: true }
    })
  })

  it('parses a list of mappings', () => {
    const value = parseYaml([
      'phases:',
      '  - id: propose',
      '    seats: [editor]',
      '  - id: discuss',
      '    seats: [writer, guard]',
      '    vetoable: true',
      '  - id: review',
      '    seats: [guard]'
    ].join('\n'))
    expect(value.phases).toEqual([
      {
        id: 'propose',
        seats: ['editor']
      },
      {
        id: 'discuss',
        seats: ['writer', 'guard'],
        vetoable: true
      },
      {
        id: 'review',
        seats: ['guard']
      }
    ])
  })

  it('parses a list of scalars', () => {
    const value = parseYaml('items:\n  - a\n  - b\n')
    expect(value.items).toEqual(['a', 'b'])
  })

  it('ignores blank lines and comments', () => {
    const value = parseYaml('# leading\n\na: 1\n\n# mid\nb: 2\n')
    expect(value).toEqual({ a: 1, b: 2 })
  })

  it('returns an empty mapping for empty input', () => {
    expect(parseYaml('')).toEqual({})
  })

  it('rejects duplicate keys', () => {
    expect(() => parseYaml('a: 1\na: 2\n')).toThrow(YamlError)
    expect(() => parseYaml('a: 1\na: 2\n')).toThrow(/Duplicate key/)
  })

  it('rejects tabs used for indentation', () => {
    expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(/Tabs are not allowed/)
  })

  it('rejects inline mappings', () => {
    expect(() => parseYaml('a: { b: 1 }\n')).toThrow(/Inline mappings/)
  })

  it('rejects a list root', () => {
    expect(() => parseYaml('- a\n- b\n')).toThrow(/must be a mapping/)
  })

  it('rejects inconsistent indentation', () => {
    expect(() => parseYaml('a:\n  b: 1\n   c: 2\n')).toThrow(YamlError)
  })

  it('rejects lines that are not key value pairs', () => {
    expect(() => parseYaml('just text\n')).toThrow(/Expected "key: value"/)
  })
})
