import type { YamlMapping } from './yaml'
import { parseYaml, YamlError } from './yaml'

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FrontmatterError'
  }
}

export interface Document {
  /** Parsed frontmatter; an empty object when the file has none. */
  data: YamlMapping
  /** Everything after the closing `---`, trimmed at both ends. */
  body: string
  hasFrontmatter: boolean
}

const DELIMITER = /^---[ \t]*$/

/**
 * Split a Markdown document into frontmatter data and body.
 *
 * A file may also omit the delimiters entirely: when the first line already
 * looks like `key: value`, the leading block up to the first blank line is read
 * as frontmatter and the rest becomes the body. That keeps small seat files
 * readable without forcing `---` on a three-line config, while a file whose
 * first line is prose stays prose.
 */
export function readFrontmatter(source: string, label: string): Document {
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')

  if (!DELIMITER.test(lines[0] ?? '')) {
    const firstLine = lines[0] ?? ''
    // Prose or an empty file: everything is body.
    if (!/^[A-Z_][\w-]*\s*:(?:\s|$)/i.test(firstLine)) {
      return {
        data: {},
        body: normalized.trim(),
        hasFrontmatter: false
      }
    }
    // Implicit frontmatter runs until a blank line, so a body may still follow.
    let end = lines.length
    for (let index = 0; index < lines.length; index++) {
      if (lines[index]!.trim() === '') {
        end = index
        break
      }
    }
    const yamlText = lines.slice(0, end).join('\n')
    let data: YamlMapping
    try {
      data = parseYaml(yamlText)
    }
    catch (error) {
      const detail = error instanceof YamlError
        ? error.message
        : String(error)
      throw new FrontmatterError(`${label}: ${detail}`)
    }
    return {
      data,
      body: lines.slice(end + 1).join('\n').trim(),
      hasFrontmatter: false
    }
  }

  let close = -1
  for (let index = 1; index < lines.length; index++) {
    if (DELIMITER.test(lines[index]!)) {
      close = index
      break
    }
  }
  if (close === -1) {
    throw new FrontmatterError(`${label}: frontmatter opened with --- but never closed`)
  }

  const yamlText = lines.slice(1, close).join('\n')
  let data: YamlMapping
  try {
    data = parseYaml(yamlText)
  }
  catch (error) {
    const detail = error instanceof YamlError
      ? error.message
      : String(error)
    throw new FrontmatterError(`${label}: ${detail}`)
  }

  return {
    data,
    body: lines.slice(close + 1).join('\n').trim(),
    hasFrontmatter: true
  }
}
