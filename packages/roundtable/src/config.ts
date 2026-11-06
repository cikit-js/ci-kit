import type { Seat } from './seat'
import type { Phase, Table } from './table'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { readFrontmatter } from './frontmatter'
import { parseSeat, SeatError } from './seat'
import { parseTable, resolvePhases, TableError } from './table'

export class RoundtableConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RoundtableConfigError'
  }
}

export interface LoadedRoundtable {
  table: Table
  seats: Seat[]
  /** Seats after `enabled` filtering, keyed by id. */
  byId: Map<string, Seat>
  /** Phases with their participant lists resolved. */
  phases: Phase[]
  configDir: string
  /** Content fingerprint over table, seats and the roundtable schema. */
  fingerprint: string
}

const SEAT_DIR = 'seats'

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

/** Markdown files under `dir`, sorted so seat order is stable across platforms. */
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
    .sort((a, b) => a.localeCompare(b))
    .map(name => join(dir, name))
}

function digest(parts: string[]): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    // Length-prefix each part so a file ending and the next beginning cannot
    // collide into the same stream.
    hash.update(`${part.length}:`)
    hash.update(part)
  }
  return `sha256:${hash.digest('hex')}`
}

/**
 * Read and validate a roundtable directory without calling any model.
 *
 * Everything a meeting needs to be well defined is checked here: unknown
 * fields, missing required fields, duplicate ids, phase references and the
 * table/seat membership intersection. A meeting that starts is a meeting that
 * can finish.
 */
export async function loadRoundtable(
  options: { configDir: string, schema?: number }
): Promise<LoadedRoundtable> {
  const configDir = resolve(options.configDir)
  const info = await stat(configDir).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new RoundtableConfigError(`Roundtable directory not found: ${configDir}`)
  }

  const tablePath = join(configDir, 'table.md')
  const tableSource = await readIfPresent(tablePath)
  if (tableSource === null) {
    throw new RoundtableConfigError(`Missing table.md in ${configDir}`)
  }

  let table: Table
  try {
    table = parseTable(readFrontmatter(tableSource, 'table.md'), basename(configDir))
  }
  catch (error) {
    if (error instanceof TableError) {
      throw new RoundtableConfigError(error.message)
    }
    throw error
  }

  const files = await seatFiles(join(configDir, SEAT_DIR))
  if (!files.length) {
    throw new RoundtableConfigError(`No seat files in ${join(configDir, SEAT_DIR)}`)
  }

  const seats: Seat[] = []
  const rawSeatSources: string[] = []
  for (const file of files) {
    const source = (await readIfPresent(file))!
    rawSeatSources.push(source)
    try {
      seats.push(parseSeat(readFrontmatter(source, basename(file)), basename(file)))
    }
    catch (error) {
      if (error instanceof SeatError) {
        throw new RoundtableConfigError(error.message)
      }
      throw error
    }
  }

  const seen = new Map<string, string>()
  for (const seat of seats) {
    const existing = seen.get(seat.id)
    if (existing) {
      throw new RoundtableConfigError(`Duplicate seat id "${seat.id}" in ${existing} and ${seat.source}`)
    }
    seen.set(seat.id, seat.source)
  }

  const enabled = seats.filter(seat => seat.enabled)
  if (!enabled.length) {
    throw new RoundtableConfigError('Every seat is disabled; a roundtable needs at least one enabled seat')
  }

  let phases: Phase[]
  try {
    phases = resolvePhases(table, seats, table.phases.map(phase => phase.id))
  }
  catch (error) {
    if (error instanceof TableError) {
      throw new RoundtableConfigError(error.message)
    }
    throw error
  }

  const emptyPhase = phases.find(phase => !phase.seats.length)
  if (emptyPhase) {
    throw new RoundtableConfigError(`Phase "${emptyPhase.id}" has no participating seats`)
  }

  return {
    table,
    seats,
    byId: new Map(enabled.map(seat => [seat.id, seat])),
    phases,
    configDir,
    fingerprint: digest([
      String(options.schema ?? 1),
      tableSource,
      ...rawSeatSources
    ])
  }
}

/** Convenience for the CLI: validate and report, never call a model. */
export async function checkRoundtable(options: {
  configDir: string
  env?: NodeJS.ProcessEnv
}): Promise<LoadedRoundtable> {
  return loadRoundtable({ configDir: options.configDir, schema: 1 })
}

/** Resolved default output directory. */
export function defaultOutDir(cwd: string = process.cwd()): string {
  return join(cwd, 'roundtable-out')
}
