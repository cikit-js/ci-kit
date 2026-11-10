export type Fallback = 'skip' | 'retry' | 'abort'

export interface SeatIdentity {
  name: string
  avatar?: string
  title?: string
  background?: string
}

export interface SeatPersona {
  stance?: string
  personality: string[]
  style?: string
  speech?: string
  values?: string
  quirks?: string
  avoid?: string
}

export interface SeatPowers {
  canVeto: boolean
  weight: number
  maxTokens: number
  tools: string[]
  maxToolCalls: number
  fallback: Fallback
}

export interface Seat {
  id: string
  role: string
  enabled: boolean
  target?: string
  identity: SeatIdentity
  persona: SeatPersona
  seat: SeatPowers
  body: string
  source: string
}

export class SeatError extends Error {
  constructor(readonly label: string, message: string) {
    super(`${label}: ${message}`)
    this.name = 'SeatError'
  }
}

export const SEAT_DEFAULTS = {
  enabled: true,
  canVeto: false,
  weight: 1,
  maxTokens: 1000,
  tools: [] as string[],
  maxToolCalls: 4,
  fallback: 'skip'
} as const
