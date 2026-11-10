#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { cac } from 'cac'
import pkg from '../package.json'
import { AiError } from './errors'
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

function optionalNumber(value: string | undefined): number | undefined {
  return value === undefined
    ? undefined
    : Number(value)
}

/** Print a structured line for failures so CI logs stay greppable. */
function reportError(error: unknown): never {
  if (error instanceof AiError) {
    process.stderr.write(`ci-kit-ai: ${error.describe()}\n`)
  }
  else {
    process.stderr.write(`ci-kit-ai: ${error instanceof Error
      ? error.message
      : String(error)}\n`)
  }
  process.exit(1)
}

cli
  .command('text', 'Generate text with the configured provider')
  .option('--prompt <text>', 'Inline prompt')
  .option('--prompt-file <path>', 'Read prompt from file (supports {{var}})')
  .option('--system <text>', 'System message')
  .option('--var <k=v>', 'Template variable, repeatable')
  .option('--max-tokens <n>', 'Upper bound for generated tokens')
  .option('--schema-file <path>', 'JSON Schema for the reply tool')
  .option('--temperature <n>', 'Sampling temperature')
  .option('--retries <n>', 'Transport retries; use 0 for paid calls')
  .option('--out <path>', 'Write result to file')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .action(async (options: Record<string, string | boolean | undefined>) => {
    const vars: Record<string, string> = {}
    for (const [key, value] of Object.entries(options)) {
      if (key.startsWith('var') && typeof value === 'string') {
        const [k, v = ''] = value.split('=')
        vars[k!] = v
      }
    }
    try {
      const result = await text({
        prompt: readPrompt(options.prompt as string | undefined, options.promptFile as string | undefined, vars),
        system: options.system as string | undefined,
        maxTokens: optionalNumber(options.maxTokens as string | undefined),
        schema: options.schemaFile === undefined
          ? undefined
          : JSON.parse(readFileSync(options.schemaFile as string, 'utf8')),
        temperature: optionalNumber(options.temperature as string | undefined),
        retries: optionalNumber(options.retries as string | undefined),
        timeoutMs: optionalNumber(options.timeout as string | undefined)
      })
      const usage = result.usage
        ? ` tokens ${result.usage.input}/${result.usage.output}`
        : ''
      if (options.out) {
        writeFileSync(options.out as string, `${result.value}\n`, 'utf8')
        process.stdout.write(`Wrote ${options.out} via ${result.provider} (${result.model})${usage}\n`)
      }
      else {
        process.stdout.write(`${result.value}\n`)
      }
    }
    catch (error) {
      reportError(error)
    }
  })

cli
  .command('image', 'Generate an image with the configured provider')
  .option('--prompt <text>', 'Image prompt')
  .option('--prompt-file <path>', 'Read prompt from file')
  .option('--size <wxh>', 'Image size; defaults to AI_IMAGE_SIZE or the provider default')
  .option('--retries <n>', 'Transport retries; use 0 for paid calls')
  .option('--out <path>', 'Output image path')
  .option('--timeout <ms>', 'Request timeout in milliseconds')
  .action(async (options: Record<string, string | undefined>) => {
    try {
      const result = await image({
        prompt: readPrompt(options.prompt, options.promptFile),
        size: options.size,
        retries: optionalNumber(options.retries),
        timeoutMs: optionalNumber(options.timeout)
      })
      const out = options.out ?? 'impression.png'
      writeFileSync(out, result.value)
      process.stdout.write(`Wrote ${out} (${result.value.length} bytes) via ${result.provider} (${result.model})\n`)
    }
    catch (error) {
      reportError(error)
    }
  })

cli.help()
cli.version(pkg.version)
cli.parse()
