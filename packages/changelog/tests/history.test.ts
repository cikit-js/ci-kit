import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectReleaseHistory, renderReleaseContext } from '../src/index'

const directories: string[] = []

async function git(cwd: string, args: string[]): Promise<void> {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

async function repository(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ci-kit-history-'))
  directories.push(dir)
  await git(dir, ['init', '--quiet'])
  await git(dir, ['config', 'user.name', 'Test Author'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await git(dir, ['config', 'commit.gpgSign', 'false'])
  await git(dir, ['config', 'tag.gpgSign', 'false'])
  await git(dir, ['config', 'core.editor', 'true'])
  await writeFile(join(dir, 'README.md'), 'first\n', 'utf8')
  await git(dir, ['add', 'README.md'])
  await git(dir, [
    'commit',
    '--quiet',
    '-m',
    'chore: initial'
  ])
  await git(dir, ['tag', 'v0.1.0'])
  await writeFile(join(dir, 'README.md'), 'second\n', 'utf8')
  await writeFile(join(dir, 'src.ts'), 'export const value = 1\n', 'utf8')
  await git(dir, ['add', 'README.md', 'src.ts'])
  await git(dir, [
    'commit',
    '--quiet',
    '-m',
    'feat: add source',
    '-m',
    'The body explains the change.'
  ])
  await git(dir, ['tag', 'v0.2.0'])
  return dir
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('collectReleaseHistory', () => {
  it('keeps commit bodies and changed file paths', async () => {
    const dir = await repository()
    const history = collectReleaseHistory({ cwd: dir, from: 'v0.1.0', to: 'v0.2.0' })
    expect(history.commits).toHaveLength(1)
    expect(history.commits[0]).toMatchObject({
      subject: 'feat: add source',
      body: 'The body explains the change.',
      author: 'Test Author',
      merge: false
    })
    expect(history.commits[0]!.files).toEqual([
      { status: 'M', path: 'README.md' },
      { status: 'A', path: 'src.ts' }
    ])
    expect(history.files).toEqual(history.commits[0]!.files)
  })

  it('renders all release material for the roundtable', async () => {
    const dir = await repository()
    const history = collectReleaseHistory({ cwd: dir, from: 'v0.1.0', to: 'v0.2.0' })
    const rendered = renderReleaseContext(history)
    expect(rendered).toContain('v0.1.0 → v0.2.0')
    expect(rendered).toContain('The body explains the change.')
    expect(rendered).toContain('- M README.md')
    expect(rendered).toContain('- A src.ts')
  })
})
