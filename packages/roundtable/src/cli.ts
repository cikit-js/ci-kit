#!/usr/bin/env node

import type { RoundtableResult } from './index'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'
import { cac } from 'cac'
import pkg from '../package.json'
import { writeExample } from './example'
import { defaultOutDir, loadRoundtable, resumeRoundtable, RoundtableConfigError, runRoundtable } from './index'

const DEFAULT_CONFIG = '.ci-kit/roundtable'
const EXIT_CONFIG = 2
const EXIT_REJECTED = 1
const EXIT_PASSED = 0

const cli = cac('ci-kit-roundtable')

/** Usage errors are configuration errors: nothing could start. */
class UsageError extends RoundtableConfigError {}

/**
 * One log-safe line for anything that stopped the command before a result
 * existed. Business failure never lands here; it is a status, not a throw.
 */
function fail(error: unknown): never {
  const message = error instanceof Error
    ? error.message
    : String(error)
  const prefix = error instanceof RoundtableConfigError
    ? 'config'
    : 'error'
  process.stderr.write(`ci-kit-roundtable: ${prefix}: ${message}\n`)
  process.exitCode = EXIT_CONFIG
  return undefined as never
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return Array.isArray(value)
    ? value
    : [value]
}

/**
 * A single-valued flag. cac hands back an array for a repeated flag, but
 * `--config`, `--topic`, `--brief`, `--out` and `--resume` mean one value, so the
 * last occurrence wins instead of being guessed at.
 */
function single(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value)
    ? value.at(-1)
    : value
  const trimmed = raw?.trim()
  return trimmed || undefined
}

/**
 * `cac` camel-cases flag names (`--context-file` → `contextFile`). Reading a key
 * that was never populated is silent, so a renamed flag would change the meeting
 * without anyone noticing. Every accepted key is listed per subcommand; anything
 * else that still carries a value is a usage error.
 */
function rejectUnknown(
  command: string,
  options: Record<string, unknown>,
  accepted: readonly string[]
): void {
  for (const key of Object.keys(options)) {
    if (key === '--' || accepted.includes(key)) {
      continue
    }
    throw new UsageError(`unknown option for ${command}: --${key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`)
  }
}

/** `42s` / `1m14s` / `1h02m`; whole minutes keep two-digit seconds so the shape stays one. */
function formatElapsed(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  if (seconds < 3600) {
    const minutes = Math.floor(seconds / 60)
    return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  }
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}h${String(minutes).padStart(2, '0')}m`
}

/**
 * Material flags, named exactly as `cac` reports them: `--context` arrives as
 * `context`, `--context-file` as `contextFile`. Both collapse into one ordered
 * list, so the seats see numbered items instead of a single blob.
 */
function collectContext(options: Record<string, string | string[] | undefined>): Promise<string[]> {
  return materials(options.context, options.contextFile)
}

async function materials(
  literals: string | string[] | undefined,
  files: string | string[] | undefined
): Promise<string[]> {
  const context: string[] = []

  for (const item of asList(literals)) {
    const text = item.trim()
    if (text) {
      context.push(text)
    }
  }

  for (const file of asList(files)) {
    const path = resolve(file)
    try {
      context.push(await readFile(path, 'utf8'))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new RoundtableConfigError(`--context-file not found: ${path}`)
      }
      throw new RoundtableConfigError(`--context-file unreadable: ${path} (${(error as Error).message})`)
    }
  }

  return context
}

/** Flag keys exactly as `cac` reports them, one list per subcommand. */
const RUN_FLAGS = [
  'config',
  'topic',
  'brief',
  'context',
  'contextFile',
  'out',
  'resume'
] as const
const CHECK_FLAGS = ['config'] as const
const INIT_FLAGS = ['force'] as const

function summarize(result: RoundtableResult): string {
  const { startedAt, finishedAt } = result.record
  // A terminal record always carries both ends; the guard only covers a
  // hand-edited record, where a missing end means "unknown elapsed".
  const elapsed = finishedAt
    ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    : 0
  return `roundtable: ${result.status} · ${result.used} calls · ${formatElapsed(elapsed)} · ${result.runDir}`
}

cli
  .command('run', 'Hold one meeting: all seats talk at once, then the program judges')
  .option('--config <dir>', 'Roundtable directory', { default: DEFAULT_CONFIG })
  .option('--topic <text>', 'What this meeting must answer; omit to let the seats open it')
  .option('--brief <text>', 'Why the meeting is being held')
  .option('--context <text>', 'One material for the table; repeatable')
  .option('--context-file <path>', 'Read one material from a file; repeatable')
  .option('--out <dir>', 'Directory for run folders', {
    default: defaultOutDir()
  })
  .option('--resume <run-dir>', 'Continue an interrupted run from its state.json')
  .action(async (options: Record<string, string | string[] | undefined>) => {
    try {
      rejectUnknown('run', options, RUN_FLAGS)
      // A meeting may open its own question. The rule file is in every seat's
      // system prompt, so the room can be told what to decide without the CLI
      // holding the question.
      const topic = single(options.topic)

      const configDir = single(options.config) ?? DEFAULT_CONFIG
      const brief = single(options.brief)
      const context = await collectContext(options)
      const onProgress = (line: string) => {
        process.stderr.write(`${line}\n`)
      }
      const shared = {
        configDir,
        topic,
        ...brief
          ? { brief }
          : {},
        ...context.length
          ? { context }
          : {},
        onProgress
      }

      const resumeDir = single(options.resume)
      const result = resumeDir
        ? await resumeRoundtable({ ...shared, runDir: resumeDir })
        : await runRoundtable({ ...shared, outDir: single(options.out) ?? defaultOutDir() })

      // Exactly one summary line: stdout when passed, stderr otherwise, so a
      // pipeline only sees a passing meeting as output.
      const line = summarize(result)
      if (result.status === 'passed') {
        process.stdout.write(`${line}\n`)
      }
      else {
        process.stderr.write(`${line}\n`)
      }
      process.exitCode = result.status === 'passed'
        ? EXIT_PASSED
        : EXIT_REJECTED
    }
    catch (error) {
      fail(error)
    }
  })

cli
  .command('check', 'Validate table.md and seats without paying for a call')
  .option('--config <dir>', 'Roundtable directory', { default: DEFAULT_CONFIG })
  .action(async (options: Record<string, string | string[] | undefined>) => {
    try {
      rejectUnknown('check', options, CHECK_FLAGS)
      const configDir = single(options.config) ?? DEFAULT_CONFIG
      const loaded = await loadRoundtable({ configDir })
      const { table, seats } = loaded
      const seatsText = `${seats.length} seat${seats.length === 1
        ? ''
        : 's'}`
      process.stdout.write(
        `roundtable: ok · ${seatsText} · duration ${formatElapsed(table.durationMs)} · maxPoolTokens ${table.maxPoolTokens} · threshold ${table.threshold}\n`
      )
      process.stdout.write(`  title: ${table.title}\n`)
      const listing = seats
        .map(seat => `${seat.id}(${seat.role})`)
        .join(', ')
      process.stdout.write(`  seats: ${listing}\n`)
    }
    catch (error) {
      fail(error)
    }
  })

cli
  .command('init [dir]', 'Write an example roundtable you can edit')
  .option('--force', 'Overwrite files that already exist')
  .action(async (dir: string | undefined, options: Record<string, boolean | undefined>) => {
    try {
      rejectUnknown('init', options, INIT_FLAGS)
      const target = single(dir) ?? DEFAULT_CONFIG
      const written = await writeExample(target, options.force === true)
      process.stdout.write(`roundtable: wrote ${written.length} files to ${resolve(target)}\n`)
      for (const path of written) {
        process.stdout.write(`  ${path}\n`)
      }
      process.stdout.write(`next: ci-kit-roundtable check --config ${target}\n`)
    }
    catch (error) {
      fail(error)
    }
  })

cli.help()
cli.version(pkg.version)
// cac throws on an unknown flag instead of reporting it; keep its message but
// route it through the same one-line, exit-2 contract as every other usage error.
try {
  cli.parse()
}
catch (error) {
  fail(error)
}
