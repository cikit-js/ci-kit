import { describe, expect, it } from 'vitest'
import { buildNumber, bumpVersion, nextBetaTag, nextBuildNumber, parseTag } from '../src/index'

describe('parseTag', () => {
  it('reads channel and beta index', () => {
    expect(parseTag('v1.0.5')).toMatchObject({ channel: 'production', version: '1.0.5' })
    expect(parseTag('v1.0.5-beta.3')).toMatchObject({ channel: 'beta', version: '1.0.5', beta: 3 })
  })

  it('returns null for unknown shapes', () => {
    expect(parseTag('v1.0')).toBeNull()
    expect(parseTag('1.0.5')).toBeNull()
  })
})

describe('nextBetaTag', () => {
  it('starts at 1 when the version has no beta yet', () => {
    expect(nextBetaTag(['v1.0.4-beta.2', 'v1.0.4'], '1.0.5')).toBe('v1.0.5-beta.1')
  })

  it('increments the highest beta of the same version', () => {
    expect(nextBetaTag(['v1.0.5-beta.1', 'v1.0.5-beta.7', 'v1.0.4-beta.9'], '1.0.5')).toBe('v1.0.5-beta.8')
  })
})

describe('bumpVersion', () => {
  it('bumps patch, minor and major', () => {
    expect(bumpVersion('1.0.5', 'patch')).toBe('1.0.6')
    expect(bumpVersion('1.0.5', 'minor')).toBe('1.1.0')
    expect(bumpVersion('1.0.5', 'major')).toBe('2.0.0')
  })

  it('rejects malformed versions', () => {
    expect(() => bumpVersion('1.0', 'patch')).toThrow()
  })
})

describe('buildNumber', () => {
  it('formats and rolls over by date', () => {
    const date = new Date(2026, 10, 2)
    expect(buildNumber(date, 1)).toBe('2026110201')
    expect(nextBuildNumber('2026110201', date)).toBe('2026110202')
    expect(nextBuildNumber('2026110109', date)).toBe('2026110201')
  })
})
