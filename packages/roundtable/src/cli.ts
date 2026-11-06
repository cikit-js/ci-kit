#!/usr/bin/env node

import process from 'node:process'
import { cac } from 'cac'
import pkg from '../package.json'
import { defaultOutDir, loadRoundtable, RoundtableConfigError, runRoundtable } from './index'

const cli = cac('ci-kit-roundtable')

/** One log-safe line for failures; exit code 2 marks config or usage errors. */
function reportError(error: unknown): never {
  const message = error instanceof RoundtableConfigError
    ? `config: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)
  process.stderr.write(`ci-kit-roundtable: ${message}\n`)
  process.exit(2)
}

cli
  .command('check', 'Validate table.md and seats without calling a model')
  .option('--config <dir>', 'Roundtable directory', { default: '.ci-kit/roundtable' })
  .action(async (options: Record<string, string | undefined>) => {
    try {
      const loaded = await loadRoundtable({ configDir: options.config ?? '.ci-kit/roundtable' })
      const phases = loaded.phases.map(phase => `${phase.id}(${phase.seats.join(', ')})`).join(' → ')
      process.stdout.write(`roundtable: ok · ${loaded.seats.length} seats · ${loaded.phases.length} phases\n`)
      process.stdout.write(`  ${phases}\n`)
      process.stdout.write(`  title: ${loaded.table.title}\n`)
    }
    catch (error) {
      reportError(error)
    }
  })

cli
  .command('run', 'Run one meeting')
  .option('--config <dir>', 'Roundtable directory', { default: '.ci-kit/roundtable' })
  .option('--out <dir>', 'Directory for run folders', {
    default: defaultOutDir()
  })
  .option('--topic <text>', 'Optional topic override; seats propose their own by default')
  .option('--context <text>', 'Material for the seats, repeatable')
  .action(async (options: Record<string, string | string[] | undefined>) => {
    const rawContext = options.context
    const context = rawContext === undefined
      ? []
      : Array.isArray(rawContext)
        ? rawContext
        : [rawContext]
    try {
      const result = await runRoundtable({
        configDir: String(options.config ?? '.ci-kit/roundtable'),
        outDir: options.out === undefined
          ? undefined
          : String(options.out),
        topic: options.topic === undefined
          ? undefined
          : String(options.topic),
        context,
        onProgress: line => process.stderr.write(`${line}\n`)
      })
      const total = result.budgetTotal === undefined
        ? 'unlimited'
        : String(result.budgetTotal)
      const summary = `roundtable: ${result.status} · ${result.record.attempts} attempt · ${result.used}/${total} calls · ${result.runDir}`
      if (result.status === 'passed') {
        process.stdout.write(`${summary}\n`)
      }
      else {
        process.stderr.write(`${summary}\n`)
      }
      process.exitCode = result.status === 'passed'
        ? 0
        : 1
    }
    catch (error) {
      reportError(error)
    }
  })

cli
  .command('init [dir]', 'Write an example roundtable you can edit')
  .option('--force', 'Overwrite existing files')
  .action(async (dir: string | undefined, options: Record<string, boolean | undefined>) => {
    try {
      const { writeExample } = await import('./example')
      const written = await writeExample(dir ?? '.ci-kit/roundtable', options.force === true)
      process.stdout.write(`roundtable: wrote ${written.length} files\n`)
      for (const path of written) {
        process.stdout.write(`  ${path}\n`)
      }
    }
    catch (error) {
      reportError(error)
    }
  })

cli.help()
cli.version(pkg.version)
cli.parse()
