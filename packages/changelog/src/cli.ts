#!/usr/bin/env node

import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { cac } from 'cac'
import { collectCommits, renderChangelog } from './index'

const cli = cac('ci-kit-changelog')

cli
  .command('[out]', 'Generate grouped release notes from git history')
  .option('--from <tag>', 'Previous tag (exclusive)')
  .option('--to <tag>', 'Target tag (inclusive, defaults to HEAD)')
  .option('--max <n>', 'Max items per section', { default: 10 })
  .action((out: string | undefined, options: { from?: string, to?: string, max?: number }) => {
    const commits = collectCommits({ from: options.from, to: options.to })
    const markdown = renderChangelog(commits, { maxPerSection: Number(options.max ?? 10) })
    if (out) {
      writeFileSync(out, `${markdown}\n`, 'utf8')
      process.stdout.write(`Wrote ${out} (${commits.length} commits scanned)\n`)
    }
    else {
      process.stdout.write(`${markdown}\n`)
    }
  })

cli.help()
cli.version('0.0.1')
cli.parse()
