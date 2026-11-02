import { readFileSync } from 'node:fs'

import process from 'node:process'

export interface EnvEntry {
  key: string
  value: string
}

const ENTRY_RE = /^\s*([A-Z_]\w*)\s*=(.*)$/i

export function parseEnv(content: string): EnvEntry[] {
  const entries: EnvEntry[] = []
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(ENTRY_RE)
    if (!match) {
      continue
    }
    const [, key, raw = ''] = match
    entries.push({ key: key!, value: unquote(raw.trim()) })
  }
  return entries
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === '\'') && value.endsWith(quote)) {
      return value.slice(1, -1)
    }
  }
  return value
}

export function readEnvFile(path: string): EnvEntry[] {
  return parseEnv(readFileSync(path, 'utf8'))
}

export function applyEnv(entries: EnvEntry[], target: NodeJS.ProcessEnv = process.env): void {
  for (const { key, value } of entries) {
    target[key] = value
  }
}

/**
 * Values must never be exported with `source`, because shell parsing strips
 * quotes and turns JSON values into invalid JSON. Emit explicit exports instead.
 */
export function toShellExports(entries: EnvEntry[]): string {
  return entries
    .map(({ key, value }) => `export ${key}=${shellQuote(value)}`)
    .join('\n')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function maskValue(value: string): string {
  if (value.length <= 8) {
    return '*'.repeat(value.length)
  }
  return `${value.slice(0, 4)}${'*'.repeat(value.length - 8)}${value.slice(-4)}`
}

export function redact(entries: EnvEntry[], keys: string[] = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD']): EnvEntry[] {
  return entries.map(({ key, value }) => ({
    key,
    value: keys.some(fragment => key.toUpperCase().includes(fragment)) ? maskValue(value) : value
  }))
}
