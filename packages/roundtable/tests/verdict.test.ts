import type { Seat } from '../src/seat'
import type { Phase, Table } from '../src/table'
import { describe, expect, it } from 'vitest'
import { judgePhase, readVerdict } from '../src/verdict'

function seat(id: string, options: { canVeto?: boolean, weight?: number } = {}): Seat {
  return {
    id,
    role: id,
    enabled: true,
    identity: { name: id },
    persona: { personality: [] },
    seat: {
      phase: [],
      sees: 'all',
      canPropose: false,
      canVeto: options.canVeto ?? false,
      lead: false,
      weight: options.weight ?? 1,
      priority: 99,
      fallback: 'skip',
      output: 'text'
    },
    body: '',
    source: `${id}.md`
  }
}

function phase(vetoable: boolean): Phase {
  return {
    id: 'review',
    seats: [],
    vetoable,
    requires: [],
    mode: 'serial'
  }
}

function table(threshold = 0.5): Table {
  return {
    title: 't',
    budget: {},
    onVeto: 're-propose',
    maxAttempts: 3,
    threshold,
    phases: [],
    special: { propose: 'propose', converge: 'converge' }
  }
}

describe('judgePhase', () => {
  it('passes when the weighted pass ratio reaches the threshold', () => {
    const seats = [
      seat('a'),
      seat('b'),
      seat('c')
    ]
    const result = judgePhase(phase(false), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      { seatId: 'b', weight: 1, vote: 'pass' },
      { seatId: 'c', weight: 1, vote: 'reject' }
    ], table(0.5))
    expect(result.passed).toBe(true)
    expect(result.score).toBeCloseTo(2 / 3)
    expect(result.rejected).toEqual(['c'])
  })

  it('fails when the ratio falls below the threshold', () => {
    const seats = [
      seat('a'),
      seat('b'),
      seat('c')
    ]
    const result = judgePhase(phase(false), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      { seatId: 'b', weight: 1, vote: 'reject' },
      { seatId: 'c', weight: 1, vote: 'reject' }
    ], table(0.5))
    expect(result.passed).toBe(false)
  })

  it('lets weight decide a split vote', () => {
    const seats = [
      seat('heavy', { weight: 3 }),
      seat('light', { weight: 1 })
    ]
    const result = judgePhase(phase(false), seats, [
      { seatId: 'heavy', weight: 3, vote: 'pass' },
      { seatId: 'light', weight: 1, vote: 'reject' }
    ], table(0.5))
    expect(result.passed).toBe(true)
    expect(result.score).toBeCloseTo(0.75)
  })

  it('lets a single veto block a unanimous pass', () => {
    const seats = [
      seat('a'),
      seat('b'),
      seat('vetoer', { canVeto: true })
    ]
    const result = judgePhase(phase(true), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      { seatId: 'b', weight: 1, vote: 'pass' },
      {
        seatId: 'vetoer',
        weight: 1,
        vote: 'reject',
        veto: true,
        hasReason: true
      }
    ], table(0.5))
    expect(result.passed).toBe(false)
    expect(result.vetoed).toEqual(['vetoer'])
  })

  it('ignores a veto that carries no reason', () => {
    const seats = [
      seat('a'),
      seat('vetoer', { canVeto: true })
    ]
    const result = judgePhase(phase(true), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      {
        seatId: 'vetoer',
        weight: 1,
        vote: 'reject',
        veto: true,
        hasReason: false
      }
    ], table(0.5))
    expect(result.vetoed).toEqual([])
    expect(result.invalidVetoes).toEqual(['vetoer'])
    // The rejection still counts as a vote, so 1/2 passes at threshold 0.5.
    expect(result.passed).toBe(true)
  })

  it('does not let a veto fire in a phase that is not vetoable', () => {
    const seats = [
      seat('a'),
      seat('vetoer', { canVeto: true })
    ]
    const result = judgePhase(phase(false), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      {
        seatId: 'vetoer',
        weight: 1,
        vote: 'reject',
        veto: true,
        hasReason: true
      }
    ], table(0.5))
    expect(result.vetoed).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('does not let a seat without veto power block', () => {
    const seats = [
      seat('a'),
      seat('b')
    ]
    const result = judgePhase(phase(true), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      {
        seatId: 'b',
        weight: 1,
        vote: 'reject',
        veto: true,
        hasReason: true
      }
    ], table(0.5))
    expect(result.vetoed).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('excludes failed seats from the denominator', () => {
    const seats = [
      seat('a'),
      seat('b')
    ]
    const result = judgePhase(phase(false), seats, [
      { seatId: 'a', weight: 1, vote: 'pass' },
      { seatId: 'b', weight: 1 }
    ], table(0.5))
    expect(result.score).toBe(1)
    expect(result.passed).toBe(true)
  })

  it('does not pass a phase where nobody voted', () => {
    const seats = [
      seat('a')
    ]
    const result = judgePhase(phase(false), seats, [
      { seatId: 'a', weight: 1 }
    ], table(0.5))
    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
  })
})

describe('readVerdict', () => {
  it('reads a structured verdict', () => {
    const verdict = readVerdict({
      verdict: 'reject',
      score: 40,
      issues: ['缺证'],
      reason: '原文不支持'
    })
    expect(verdict.verdict).toBe('reject')
    expect(verdict.score).toBe(40)
    expect(verdict.issues).toEqual(['缺证'])
    expect(verdict.reason).toBe('原文不支持')
  })

  it('tolerates a non-object payload', () => {
    expect(readVerdict(undefined)).toEqual({})
    expect(readVerdict('通过')).toEqual({})
    expect(readVerdict([1, 2])).toEqual({})
  })

  it('drops blank strings from lists and empty reasons', () => {
    const verdict = readVerdict({
      issues: ['', '  ', '真问题'],
      reason: '   '
    })
    expect(verdict.issues).toEqual(['真问题'])
    expect(verdict.reason).toBeUndefined()
  })

  it('ignores an unknown verdict value', () => {
    expect(readVerdict({ verdict: 'maybe' }).verdict).toBeUndefined()
  })
})
