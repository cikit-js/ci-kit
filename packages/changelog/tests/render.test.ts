import { describe, expect, it } from 'vitest'
import { parseSubject, renderChangelog } from '../src/index'

const commit = (subject: string) => ({ hash: 'deadbeef', subject, body: '' })

describe('parseSubject', () => {
  it('parses type, scope and breaking marker', () => {
    expect(parseSubject('feat(login): add sms login')).toMatchObject({ type: 'feat', description: 'add sms login' })
    expect(parseSubject('fix!: drop legacy token')).toMatchObject({ type: 'fix', breaking: true })
  })

  it('rejects messages without a conventional prefix', () => {
    expect(parseSubject('update something')).toBeNull()
    expect(parseSubject('Feat: wrong case')).toBeNull()
  })
})

describe('renderChangelog', () => {
  it('groups kept types and drops noise', () => {
    const markdown = renderChangelog([
      commit('feat: add weekly ranking'),
      commit('fix: repair upload retry'),
      commit('ci: tweak pipeline'),
      commit('docs: update readme'),
      commit('chore: bump version')
    ])
    expect(markdown).toContain('### 新功能')
    expect(markdown).toContain('- add weekly ranking')
    expect(markdown).toContain('### 修复')
    expect(markdown).not.toContain('tweak pipeline')
    expect(markdown).not.toContain('update readme')
  })

  it('marks breaking changes', () => {
    expect(renderChangelog([
      commit('refactor(auth)!: unify session')
    ])).toContain('（不兼容）')
  })

  it('falls back to a notice when nothing is kept', () => {
    expect(renderChangelog([
      commit('ci: internal only')
    ])).toContain('本次版本主要为内部维护')
  })

  it('truncates long sections', () => {
    const commits = Array.from({ length: 12 }, (_, index) => commit(`feat: item ${index}`))
    expect(renderChangelog(commits, { maxPerSection: 10 })).toContain('以及另外 2 条')
  })
})
