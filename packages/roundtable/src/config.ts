import type { Seat } from './seat'
import type { Table } from './table'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { FrontmatterError, readFrontmatter } from './frontmatter'
import { parseSeat, SeatError } from './seat'
import { parseTable, TableError } from './table'

/**
 * Version of the roundtable config shape, mixed into the fingerprint.
 *
 * Declared here rather than imported from ./record: record imports this module,
 * so a back-reference would create a cycle.
 */
export const CONFIG_SCHEMA = 2

const SEAT_DIR = 'seats'
const TABLE_FILE = 'table.md'

export class RoundtableConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoundtableConfigError'
  }
}

export interface LoadedRoundtable {
  table: Table
  /** Every seat, including those with `enabled: false`. */
  seats: Seat[]
  /** Seats attending this meeting (after `enabled` filtering), keyed by id. */
  byId: Map<string, Seat>
  configDir: string
  /** Digest of table.md, every seat md and the config schema, as `sha256:<hex>`. */
  fingerprint: string
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      throw new RoundtableConfigError(`${path} exists but is not a file`)
    }
    return await readFile(path, 'utf8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/** Markdown files under `dir`, sorted by name so seat order is stable across platforms. */
async function seatFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RoundtableConfigError(`No ${SEAT_DIR}/ directory in ${dir}; a roundtable needs at least one seat`)
    }
    throw error
  }
  return entries
    .filter(name => name.endsWith('.md'))
    .sort((a, b) => (a < b
      ? -1
      : a > b
        ? 1
        : 0))
}

function digest(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    // Length-prefix each part so one file ending and the next beginning cannot
    // collide into the same byte stream.
    hash.update(`${part.length}:`)
    hash.update(part)
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * Read and validate a roundtable directory without calling any model.
 *
 * Everything a meeting needs to be well defined is checked here: unknown
 * fields, bad values, duplicate ids, missing files and an empty participant
 * list. A meeting that starts is a meeting that can finish.
 */
export async function loadRoundtable(options: { configDir: string }): Promise<LoadedRoundtable> {
  const configDir = resolve(options.configDir)
  const info = await stat(configDir).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new RoundtableConfigError(`Roundtable directory not found: ${configDir}`)
  }

  const tableSource = await readIfPresent(join(configDir, TABLE_FILE))
  if (tableSource === null) {
    throw new RoundtableConfigError(`Missing ${TABLE_FILE} in ${configDir}`)
  }

  let table: Table
  try {
    table = parseTable(readFrontmatter(tableSource, TABLE_FILE), basename(configDir))
  }
  catch (error) {
    if (error instanceof TableError || error instanceof FrontmatterError) {
      throw new RoundtableConfigError(error.message)
    }
    throw error
  }

  const names = await seatFiles(join(configDir, SEAT_DIR))
  if (!names.length) {
    throw new RoundtableConfigError(`No seat files in ${join(configDir, SEAT_DIR)}`)
  }

  const seats: Seat[] = []
  const seatSources: string[] = []
  for (const name of names) {
    const file = join(configDir, SEAT_DIR, name)
    const source = await readIfPresent(file)
    if (source === null) {
      throw new RoundtableConfigError(`Missing seat file: ${file}`)
    }
    seatSources.push(source)
    try {
      seats.push(parseSeat(readFrontmatter(source, name), name))
    }
    catch (error) {
      if (error instanceof SeatError || error instanceof FrontmatterError) {
        throw new RoundtableConfigError(error.message)
      }
      throw error
    }
  }

  const origin = new Map<string, string>()
  for (const seat of seats) {
    const existing = origin.get(seat.id)
    if (existing) {
      throw new RoundtableConfigError(`Duplicate seat id "${seat.id}" in ${existing} and ${seat.source}`)
    }
    origin.set(seat.id, seat.source)
  }

  const enabled = seats.filter(seat => seat.enabled)
  if (!enabled.length) {
    throw new RoundtableConfigError('Every seat is disabled; a roundtable needs at least one enabled seat')
  }

  return {
    table,
    seats,
    byId: new Map(enabled.map(seat => [seat.id, seat])),
    configDir,
    fingerprint: digest([
      `config-schema:${CONFIG_SCHEMA}`,
      tableSource,
      ...seatSources
    ])
  }
}

/** Convenience for the CLI: validate and report, never call a model. */
export async function checkRoundtable(options: { configDir: string }): Promise<LoadedRoundtable> {
  return loadRoundtable({ configDir: options.configDir })
}

/** Resolved default output directory. */
export function defaultOutDir(cwd: string = process.cwd()): string {
  return join(cwd, 'roundtable-out')
}
