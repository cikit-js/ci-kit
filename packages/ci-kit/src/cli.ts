#!/usr/bin/env node

import process from 'node:process'
import { cac } from 'cac'
import pkg from '../package.json'

const cli = cac('ci-kit')

cli
  .command('changelog', 'Generate release notes from git history')
  .option('--from <tag>', 'Previous tag')
  .option('--to <tag>', 'Target tag', { default: 'HEAD' })
  .option('--out <path>', 'Write result to file')
  .action(async (options: Record<string, string | undefined>) => {
    const { collectCommits, renderChangelog } = await import('@cikit-js/changelog')
    const markdown = renderChangelog(collectCommits({ from: options.from, to: options.to }))
    await output(markdown, options.out)
  })

cli
  .command('release-next', 'Compute the next beta or production tag')
  .option('--tags <list>', 'Comma separated existing tags', { default: '' })
  .option('--version <version>', 'Current version, for example 1.0.5')
  .option('--channel <channel>', 'beta or production', { default: 'beta' })
  .option('--bump <kind>', 'patch, minor or major', { default: 'patch' })
  .action(async (options: Record<string, string | undefined>) => {
    const { bumpVersion, formatProductionTag, nextBetaTag, parseTag } = await import('@cikit-js/release')
    const tags = (options.tags ?? '').split(',').map(tag => tag.trim()).filter(Boolean)
    const version = options.version
    if (!version) {
      throw new Error('--version is required')
    }
    if (options.channel === 'production') {
      process.stdout.write(`${formatProductionTag(bumpVersion(version, (options.bump ?? 'patch') as 'patch' | 'minor' | 'major'))}\n`)
      return
    }
    const betaVersion = tags
      .map(parseTag)
      .find(tag => tag?.channel === 'production')
      ?.version ?? version
    process.stdout.write(`${nextBetaTag(tags, betaVersion)}\n`)
  })

cli
  .command('ai-text', 'Generate text with the configured AI provider')
  .option('--prompt <text>', 'Inline prompt')
  .option('--prompt-file <path>', 'Prompt file')
  .option('--out <path>', 'Output path')
  .action(async (options: Record<string, string | undefined>) => {
    const { readFileSync } = await import('node:fs')
    const { text } = await import('@cikit-js/ai')
    const prompt = options.promptFile
      ? readFileSync(options.promptFile, 'utf8')
      : options.prompt
    if (!prompt) {
      throw new Error('Provide --prompt or --prompt-file')
    }
    const result = await text({ prompt })
    await output(result.value, options.out)
  })

cli.help()
cli.version(pkg.version)
cli.parse()

async function output(content: string, path?: string): Promise<void> {
  if (!path) {
    process.stdout.write(`${content}\n`)
    return
  }
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, `${content}\n`, 'utf8')
  process.stdout.write(`Wrote ${path}\n`)
}
