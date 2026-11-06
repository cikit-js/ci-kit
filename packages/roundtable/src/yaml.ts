/**
 * Minimal YAML subset parser for roundtable frontmatter.
 *
 * The design only ever needs a narrow slice of YAML: scalars, inline lists,
 * block lists of scalars, block lists of mappings, and one level of nested
 * mappings. Supporting more would mean a real YAML dependency, and a real
 * dependency would accept syntax the roundtable spec does not define.
 *
 * Everything outside the subset throws instead of guessing. A silently
 * misparsed seat is worse than a loud config error: the meeting would run with
 * the wrong permissions.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue }
export interface YamlMapping { [key: string]: YamlValue }

export class YamlError extends Error {
  constructor(message: string, readonly line?: number) {
    super(line === undefined
      ? message
      : `line ${line}: ${message}`)
    this.name = 'YamlError'
  }
}

interface Line {
  indent: number
  text: string
  number: number
}

/** Scalar coercion: only the shapes a frontmatter realistically uses. */
function parseScalar(raw: string, line: number): YamlValue {
  const value = raw.trim()
  if (!value) {
    return null
  }
  if (value === 'true') {
    return true
  }
  if (value === 'false') {
    return false
  }
  if (value === 'null' || value === '~') {
    return null
  }
  // Quoted strings keep everything literally, including leading zeros.
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith('\'') && value.endsWith('\'') && value.length >= 2)) {
    const inner = value.slice(1, -1)
    return value.startsWith('"')
      ? unescapeDouble(inner, line)
      : inner.replace(/''/g, '\'')
  }
  // Inline list: [a, b, "c, d"]
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) {
      throw new YamlError(`Unterminated inline list: ${value}`, line)
    }
    return splitInlineList(value.slice(1, -1), line)
  }
  // Inline mapping is deliberately unsupported; it hides nesting in one line.
  if (value.startsWith('{')) {
    throw new YamlError('Inline mappings are not supported in frontmatter; use a block mapping', line)
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value)
  }
  if (/^-?\d+\.\d+$/.test(value)) {
    return Number(value)
  }
  return value
}

function unescapeDouble(value: string, line: number): string {
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (char === '\\' && i + 1 < value.length) {
      const next = value[++i]!
      result += next === 'n'
        ? '\n'
        : next === 't'
          ? '\t'
          : next === '"'
            ? '"'
            : next === '\\'
              ? '\\'
              : next
      continue
    }
    if (char === '"') {
      throw new YamlError('Unescaped double quote inside a double-quoted string', line)
    }
    result += char
  }
  return result
}

/** Split `a, b, "c, d"` respecting quotes. */
function splitInlineList(body: string, line: number): YamlValue[] {
  const items: YamlValue[] = []
  let current = ''
  let quote: string | null = null
  for (const char of body) {
    if (quote) {
      current += char
      if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      items.push(parseScalar(current, line))
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() || body.trim() === '') {
    items.push(parseScalar(current, line))
  }
  return items
}

/** `key: value` or `key:`. Returns null when the line is not a mapping entry. */
function splitKey(text: string): { key: string, rest: string } | null {
  // Anchored key then colon; the rest is split afterwards so no nested
  // quantifier can backtrack across a long value.
  const match = /^([A-Z_][\w-]*)\s*:(.*)$/i.exec(text)
  if (!match) {
    return null
  }
  return {
    key: match[1]!,
    rest: (match[2] ?? '').trim()
  }
}

function toLines(source: string): Line[] {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw, index) => ({
      indent: raw.length - raw.trimStart().length,
      text: raw.trim(),
      number: index + 1
    }))
    // Blank lines and comments carry no structure.
    .filter(line => line.text !== '' && !line.text.startsWith('#'))
}

/**
 * Parse a YAML subset into a mapping.
 *
 * Supported:
 * - `key: scalar`
 * - `key: [a, b]`
 * - nested block mappings (any depth)
 * - block lists of scalars (`- a`)
 * - block lists of mappings (`- key: value`)
 *
 * Tabs are rejected: YAML forbids them for indentation and mixing them with
 * spaces produces errors that are hard to read back.
 */
export function parseYaml(source: string): YamlMapping {
  if (/\t/.test(source.split('\n').map(line => line.match(/^[ \t]+/)?.[0] ?? '').join(''))) {
    throw new YamlError('Tabs are not allowed for indentation; use spaces')
  }
  const lines = toLines(source)
  if (!lines.length) {
    return {}
  }
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent)
  if (next !== lines.length) {
    throw new YamlError(`Unexpected content`, lines[next]!.number)
  }
  if (Array.isArray(value)) {
    throw new YamlError('The frontmatter root must be a mapping, not a list', lines[0]!.number)
  }
  if (value === null || typeof value !== 'object') {
    throw new YamlError('The frontmatter root must be a mapping', lines[0]!.number)
  }
  return value as YamlMapping
}

function parseBlock(lines: Line[], start: number, indent: number): [YamlValue, number] {
  const first = lines[start]!
  if (first.indent !== indent) {
    throw new YamlError(`Inconsistent indentation (expected ${indent}, found ${first.indent})`, first.number)
  }
  return first.text === '-' || first.text.startsWith('- ')
    ? parseList(lines, start, indent)
    : parseMapping(lines, start, indent)
}

function parseMapping(lines: Line[], start: number, indent: number): [YamlMapping, number] {
  const result: YamlMapping = {}
  let index = start
  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) {
      break
    }
    if (line.indent > indent) {
      throw new YamlError(`Unexpected extra indentation`, line.number)
    }
    if (line.text === '-' || line.text.startsWith('- ')) {
      break
    }
    const entry = splitKey(line.text)
    if (!entry) {
      throw new YamlError(`Expected "key: value", found "${line.text}"`, line.number)
    }
    if (Object.hasOwn(result, entry.key)) {
      throw new YamlError(`Duplicate key "${entry.key}"`, line.number)
    }
    if (entry.rest !== '') {
      result[entry.key] = parseScalar(entry.rest, line.number)
      index++
      continue
    }
    // No value on this line: a nested block or an empty value.
    const next = lines[index + 1]
    if (!next || next.indent <= indent) {
      result[entry.key] = null
      index++
      continue
    }
    const [child, after] = parseBlock(lines, index + 1, next.indent)
    result[entry.key] = child
    index = after
  }
  return [result, index]
}

function parseList(lines: Line[], start: number, indent: number): [YamlValue[], number] {
  const result: YamlValue[] = []
  let index = start
  while (index < lines.length) {
    const line = lines[index]!
    if (line.indent < indent) {
      break
    }
    if (line.indent > indent) {
      throw new YamlError('Unexpected extra indentation in list', line.number)
    }
    if (line.text !== '-' && !line.text.startsWith('- ')) {
      break
    }
    const body = line.text === '-'
      ? ''
      : line.text.slice(2).trim()
    if (body === '') {
      // `-` alone introduces a nested block on the following lines.
      const next = lines[index + 1]
      if (!next || next.indent <= indent) {
        result.push(null)
        index++
        continue
      }
      const [child, after] = parseBlock(lines, index + 1, next.indent)
      result.push(child)
      index = after
      continue
    }
    // `- key: value` opens a mapping item whose remaining keys sit at the
    // same column as `key`, i.e. list indent + the width of "- ".
    if (splitKey(body)) {
      const itemIndent = line.indent + 2
      // Index 0 is this line's content without the "- " marker; the rest are
      // the following lines as-is. A consumed count of N therefore maps back
      // to real index + N.
      const view: Line[] = [
        { indent: itemIndent, text: body, number: line.number },
        ...lines.slice(index + 1)
      ]
      const [mapping, consumed] = parseMapping(view, 0, itemIndent)
      result.push(mapping)
      index += consumed
      continue
    }
    result.push(parseScalar(body, line.number))
    index++
  }
  return [result, index]
}
