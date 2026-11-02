#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { cac } from 'cac'
import pkg from '../package.json'
import { image, text } from './index'

const cli = cac('ci-kit-ai')

function readPrompt(prompt?: string, promptFile?: string, vars: Record<string, string> = {}): string {
  let content = prompt ?? ''
  if (promptFile) {
    content = readFileSync(promptFile, 'utf8')
  }
  if (!content) {
    throw new Error('Provide --prompt or --prompt-file')
  }
  return content.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) => vars[name] ?? '')
}

cli
  .command('text', 'Generate text with the configured provider')
  .option('--prompt <text>', 'Inline prompt')
  .option('--prompt-file <path>', 'Read prompt from file (supports {{var}})')
  .option('--system <text>', 'System message')
  .option('--var <k=v>', 'Template variable, repeatable')
  .option('--out <path>', 'Write result to file')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .action(async (options: Record<string, string | undefined>) => {
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(options)) {
      if (key.startsWith('var') && typeof value === 'string') {
        const [k, v = ''] = value.split('=')
        vars[k!] = v
      }
    }
    const result = await text({
      prompt: readPrompt(options.prompt, options.promptFile, vars),
      system: options.system,
      timeoutMs: options.timeout
        ? Number(options.timeout)
        : undefined
    })
    if (options.out) {
      writeFileSync(options.out, `${result.value}\n`, 'utf8')
      process.stdout.write(`Wrote ${options.out} via ${result.provider} (${result.model})\n`)
    }
    else {
      process.stdout.write(`${result.value}\n`)
    }
  })

cli
  .command('image', 'Generate an image with the configured provider')
  .option('--prompt <text>', 'Image prompt')
  .option('--prompt-file <path>', 'Read prompt from file')
  .option('--size <wxh>', 'Image size', { default: '1280x720' })
  .option('--out <path>', 'Output PNG path')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .action(async (options: Record<string, string | undefined>) => {
    const result = await image({
      prompt: readPrompt(options.prompt, options.promptFile),
      size: options.size,
      timeoutMs: options.timeout
        ? Number(options.timeout)
        : undefined
    })
    const out = options.out ?? 'impression.png'
    writeFileSync(out, result.value)
    process.stdout.write(`Wrote ${out} (${result.value.length} bytes) via ${result.provider} (${result.model})\n`)
  })

cli.help()
cli.version(pkg.version)
cli.parse()
