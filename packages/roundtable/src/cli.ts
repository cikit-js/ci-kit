#!/usr/bin/env node

import process from 'node:process'
import { cac } from 'cac'
import pkg from '../package.json'

const cli = cac('ci-kit-roundtable')

cli
  .command('check', 'Validate table.md and seats without calling a model')
  .option('--config <dir>', 'Roundtable directory', { default: '.ci-kit/roundtable' })
  .action(async (options: Record<string, string | undefined>) => {
    const { checkRoundtable } = await import('./index')
    await checkRoundtable({ configDir: options.config ?? '.ci-kit/roundtable' })
  })

cli
  .command('run', 'Run one meeting')
  .option('--config <dir>', 'Roundtable directory', { default: '.ci-kit/roundtable' })
  .option('--out <dir>', 'Directory for run folders', { default: 'roundtable-out' })
  .option('--topic <text>', 'Optional topic override; seats propose their own by default')
  .action(async (options: Record<string, string | undefined>) => {
    const { runRoundtable } = await import('./index')
    const result = await runRoundtable({
      configDir: options.config ?? '.ci-kit/roundtable',
      outDir: options.out,
      topic: options.topic
    })
    process.stdout.write(`roundtable: ${result.status} · ${result.recordPath}\n`)
    process.exitCode = result.status === 'passed'
      ? 0
      : 1
  })

cli.help()
cli.version(pkg.version)
cli.parse()
