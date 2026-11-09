import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STORE = 'ci-kit-roundtable'
const INITX_VERSION = '0.4.3'
const CORE_VERSION = '0.4.3'
const MANAGER_VERSION = '0.6.0'
const ENV_VERSION = '0.1.3'

function run(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env,
      stdio: 'inherit'
    })
    child.once('error', () => reject(new Error('无法启动 env bootstrap 子进程')))
    child.once('exit', (code, signal) => {
      if (code === 0 && !signal) {
        resolveRun()
        return
      }
      reject(new Error('env bootstrap 子进程执行失败'))
    })
  })
}

function requiredToken(): void {
  if (!process.env.INITX_ENV_TOKEN) {
    throw new Error('缺少 GitHub Actions Secret：INITX_ENV_TOKEN')
  }
}

async function main(): Promise<void> {
  requiredToken()
  const originalHome = process.env.HOME
  const originalProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), 'ci-kit-env-'))
  const prefix = join(home, 'runtime')
  const dotenv = join(ROOT, '.env')
  const npm = process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm'

  try {
    process.env.HOME = home
    process.env.USERPROFILE = home
    await rm(dotenv, { force: true })
    await run(npm, [
      'install',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      `initx@${INITX_VERSION}`,
      `@initx-plugin/core@${CORE_VERSION}`
    ])

    const require = createRequire(join(prefix, 'package.json'))
    const core = await import(pathToFileURL(require.resolve('@initx-plugin/core')).href)
    await core.pluginSystem.install('@initx-plugin/manager', MANAGER_VERSION)
    await core.pluginSystem.install('@initx-plugin/env', ENV_VERSION)
    const plugins = await core.pluginSystem.list() as Array<{ name: string, packageInfo?: { version?: string } }>
    const envPlugin = plugins.find(plugin => plugin.name === '@initx-plugin/env')
    if (envPlugin?.packageInfo?.version !== ENV_VERSION) {
      throw new Error('env 插件版本校验失败')
    }

    const initx = join(prefix, 'node_modules', 'initx', 'bin', 'initx.mjs')
    await run(process.execPath, [
      initx,
      'env',
      'pull',
      STORE,
      '--config',
      join(ROOT, '.initx-env.json'),
      '--to',
      dotenv
    ])
    if (!existsSync(dotenv)) {
      throw new Error('env 插件没有生成 .env')
    }
    console.log(`已拉取 env store：${STORE}`)
  }
  finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    }
    else {
      process.env.HOME = originalHome
    }
    if (originalProfile === undefined) {
      delete process.env.USERPROFILE
    }
    else {
      process.env.USERPROFILE = originalProfile
    }
    await rm(home, { recursive: true, force: true })
  }
}

try {
  await main()
}
catch (error) {
  const message = error instanceof Error
    ? error.message
    : 'env bootstrap 失败'
  console.error(message)
  process.exitCode = 1
}
