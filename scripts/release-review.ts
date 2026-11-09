import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_DIR = join(ROOT, '.ci-kit', 'roundtable', 'release-review')
const OUT_DIR = join(ROOT, 'out')
const ENV_FILE = join(ROOT, '.env')
const GENERATED_START = '<!-- ci-kit:release-review tag='
const GENERATED_END = '<!-- ci-kit:release-review:end -->'

interface ReleaseHistorySummary {
  commits: unknown[]
  files: unknown[]
}

interface RoundtableResult {
  status: string
  recordPath: string
  record: unknown
}

interface GitHubRelease {
  id: number
  name: string
  body: string | null
  html_url: string
}

interface GitHubClient {
  getReleaseByTag: (tag: string) => Promise<GitHubRelease | null>
  updateRelease: (id: number, input: { name: string, body: string }) => Promise<GitHubRelease>
  createRelease: (input: Record<string, unknown>) => Promise<GitHubRelease>
}

interface Packages {
  resolvePreviousTag: (options: { cwd: string, to: string, pattern: string }) => string | null
  collectReleaseHistory: (options: { cwd: string, from?: string, to: string, includeMerges: boolean }) => ReleaseHistorySummary
  renderReleaseContext: (history: ReleaseHistorySummary) => string
  runRoundtable: (options: Record<string, unknown>) => Promise<RoundtableResult>
  githubClientFromEnv: () => GitHubClient
  readEnvFile: (path: string) => Array<{ key: string, value: string }>
  applyEnv: (entries: Array<{ key: string, value: string }>) => void
}

function packageUrl(relativePath: string): string {
  return pathToFileURL(resolve(ROOT, relativePath)).href
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) {
    return undefined
  }
  return process.argv[index + 1]
}

function releaseTag(): string {
  const tag = argumentValue('--tag') || process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME
  if (!tag?.trim()) {
    throw new Error('缺少 release tag；请使用 --tag 或 GITHUB_REF_NAME')
  }
  return tag.trim()
}

function safeTag(tag: string): string {
  return tag.replace(/[^\w.-]+/g, '-')
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function mergeGeneratedSection(existing: string | null | undefined, generated: string): string {
  const body = existing?.trim() || ''
  const start = body.indexOf(GENERATED_START)
  if (start < 0) {
    return [body, generated].filter(Boolean).join('\n\n')
  }
  const end = body.indexOf(GENERATED_END, start)
  const before = body.slice(0, start).trimEnd()
  let after = ''
  if (end >= 0) {
    after = body.slice(end + GENERATED_END.length).trimStart()
  }
  return [before, generated, after].filter(Boolean).join('\n\n')
}

function renderGeneratedSection(input: {
  tag: string
  previousTag: string | null
  history: ReleaseHistorySummary
  transcript: string
  context: string
  failure: string
}): string {
  const { tag, previousTag, history, transcript, context, failure } = input
  const range = `${previousTag ?? '仓库初始提交'} → ${tag}`
  const record = transcript
    ? transcript.replace(/^# [^\n]*\n?/, '').trim()
    : `本次圆桌没有形成记录。\n\n原因：${failure}`
  const lines = [
    `${GENERATED_START}${tag} -->`,
    `## 谋士会 · ${tag}`,
    '',
    `围绕 ${range} 交谈，共 ${history.commits.length} 个 commit、${history.files.length} 个文件变更。`,
    '',
    '### 圆桌记录',
    '',
    record,
    '',
    '<details>',
    '<summary>本次会议材料（commit 与文件路径）</summary>',
    '',
    context.trim(),
    '',
    '</details>',
    '',
    GENERATED_END
  ]
  return lines.join('\n')
}

async function loadPackages(): Promise<Packages> {
  const [changelog, roundtable, github, env] = await Promise.all([
    import(packageUrl('packages/changelog/dist/index.mjs')),
    import(packageUrl('packages/roundtable/dist/index.mjs')),
    import(packageUrl('packages/github/dist/index.mjs')),
    import(packageUrl('packages/env/dist/index.mjs'))
  ])
  return {
    resolvePreviousTag: changelog.resolvePreviousTag as Packages['resolvePreviousTag'],
    collectReleaseHistory: changelog.collectReleaseHistory as Packages['collectReleaseHistory'],
    renderReleaseContext: changelog.renderReleaseContext as Packages['renderReleaseContext'],
    runRoundtable: roundtable.runRoundtable as Packages['runRoundtable'],
    githubClientFromEnv: github.githubClientFromEnv as Packages['githubClientFromEnv'],
    readEnvFile: env.readEnvFile as Packages['readEnvFile'],
    applyEnv: env.applyEnv as Packages['applyEnv']
  }
}

async function writeArtifacts(tag: string, context: string, result: RoundtableResult | undefined, transcript: string, failure: string | undefined): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true })
  const stem = `release-review-${safeTag(tag)}`
  await writeFile(join(OUT_DIR, `${stem}.context.md`), context, 'utf8')
  await writeFile(join(OUT_DIR, `${stem}.md`), transcript || `本次圆桌未完成：${failure}`, 'utf8')
  if (result) {
    await writeFile(join(OUT_DIR, `${stem}.json`), JSON.stringify(result.record, null, 2), 'utf8')
  }
}

async function main(): Promise<void> {
  const tag = releaseTag()
  const packages = await loadPackages()
  if (existsSync(ENV_FILE)) {
    packages.applyEnv(packages.readEnvFile(ENV_FILE))
  }
  process.env.AI_TEXT_PROVIDER ||= 'minimax'
  if (process.env.AI_TEXT_PROVIDER !== 'minimax') {
    throw new Error('env store 的 AI_TEXT_PROVIDER 必须是 minimax')
  }
  if (!process.env.AI_API_KEY) {
    throw new Error('env store 缺少 AI_API_KEY')
  }

  const previousTag = packages.resolvePreviousTag({ cwd: ROOT, to: tag, pattern: 'v*' })
  const history = packages.collectReleaseHistory({
    cwd: ROOT,
    from: previousTag ?? undefined,
    to: tag,
    includeMerges: true
  })
  const context = packages.renderReleaseContext(history)
  const topic = `请围绕 ${previousTag ?? '仓库初始提交'} 到 ${tag} 的真实变化开一场谋士会`
  const brief = '这是发布时的圆桌闲聊；只接材料里的变化，每次只说一句短话。'

  let result
  let transcript = ''
  let failure
  try {
    result = await packages.runRoundtable({
      configDir: CONFIG_DIR,
      topic,
      brief,
      context,
      outDir: join(ROOT, 'roundtable-out'),
      env: process.env,
      onProgress: (line: string) => console.error(line)
    })
    transcript = await readFile(result.recordPath.replace(/record\.json$/, 'record.md'), 'utf8')
  }
  catch (error) {
    failure = errorMessage(error)
    console.error(`谋士会未完成：${failure}`)
  }

  await writeArtifacts(tag, context, result, transcript, failure)
  const section = renderGeneratedSection({
    tag,
    previousTag,
    history,
    transcript,
    context,
    failure: failure || (result
      ? `圆桌状态：${result.status}`
      : '未知错误')
  })
  const client = packages.githubClientFromEnv()
  const existing = await client.getReleaseByTag(tag)
  const body = mergeGeneratedSection(existing?.body ?? '', section)
  const release = existing
    ? await client.updateRelease(existing.id, {
        name: existing.name || tag,
        body
      })
    : await client.createRelease({
        tagName: tag,
        name: tag,
        body,
        targetCommitish: process.env.GITHUB_SHA || tag,
        previousTagName: previousTag ?? undefined
      })

  console.log(`GitHub Release 已${existing ? '更新' : '创建'}：${release.html_url}`)
  if (result) {
    console.log(`谋士会状态：${result.status}，记录：${result.recordPath}`)
  }
}

try {
  await main()
}
catch (error) {
  console.error(`release-review: ${errorMessage(error)}`)
  process.exitCode = 1
}
