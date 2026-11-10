import type { RoundtableStatus, RoundtableTool, TextCaller } from './engine'
import type { RoundtableRecord } from './record'

export interface RoundtableOptions {
  configDir: string
  topic?: string
  brief?: string
  context?: string | string[]
  outDir?: string
  env?: NodeJS.ProcessEnv
  tools?: Record<string, RoundtableTool>
  onProgress?: (line: string) => void
  callText?: TextCaller
  now?: () => number
}

export interface RoundtableResult {
  status: Exclude<RoundtableStatus, 'running'>
  recordPath: string
  runDir: string
  record: RoundtableRecord
  used: number
}
