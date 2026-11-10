import type { RoundtableResult } from './api-types'
import type { LoadedRoundtable } from './config'
import type { Statement } from './prompt'
import type { AttemptState, RecordVerdict, RunState } from './record'
import { join } from 'node:path'
import { RoundtableConfigError } from './config'
import { discuss, finalVotes, outputFrom } from './engine'
import { buildRecord, renderRecordMarkdown, writeJson, writeText } from './record'
import { judgeMeeting, readVerdict, vetoReason } from './verdict'

export interface RunnerContext {
  loaded: LoadedRoundtable
  state: RunState
  runDir: string
  options: import('./api-types').RoundtableOptions
  persist: () => Promise<void>
  writeArtifact: (relativePath: string, content: string) => Promise<number>
  startedAt: number
  now: () => number
  stamp: () => string
}
/** Turn the finished pool into the meeting's verdict. */
export function judgeAttempt(loaded: LoadedRoundtable, statements: Statement[]): RecordVerdict {
  const seats = loaded.seats.filter(seat => seat.enabled)
  // A meeting that declares output fields is judged by whether the room settled
  // them: its seats talk rather than ballot, so an empty ballot would read as a
  // rejection of a meeting that actually delivered.
  if (loaded.table.outputFields) {
    const output = outputFrom(statements, loaded.table.outputFields)
    if (output && Object.keys(output).length === Object.keys(loaded.table.outputFields).length) {
      return { passed: true, vetoed: [], score: 1 }
    }
  }
  const votes = finalVotes(seats, statements)
  const judgement = judgeMeeting(seats, votes, loaded.table)
  return {
    passed: judgement.passed,
    vetoed: judgement.vetoed,
    score: judgement.score
  }
}

/** The reason a statement states, from its JSON when it has one. */
function statedReason(statement: Statement): string {
  const parsed = readVerdict(statement.structured)
  const reason = vetoReason(parsed, parsed.verdict !== undefined
    ? ''
    : statement.content)
  if (reason) {
    return reason
  }
  // Nothing readable in a structured field: the raw text is still what the seat
  // said, and quoting it beats telling the next round "否决" with no detail.
  return parsed.verdict !== undefined
    ? statement.content.trim().slice(0, 200)
    : ''
}

/** Veto reasons from the last attempt, worded for the next one to read. */
function rejectionNotes(loaded: LoadedRoundtable, attempt: AttemptState | undefined): string[] {
  if (!attempt?.verdict) {
    return []
  }
  const notes: string[] = []
  const seen = new Set<string>()
  for (const seatId of [...attempt.verdict.vetoed]) {
    if (seen.has(seatId)) {
      continue
    }
    seen.add(seatId)
    const seat = loaded.byId.get(seatId)
    const label = seat
      ? `${seat.identity.name}（${seat.role}）`
      : seatId
    const statement = [...attempt.statements].reverse().find(item => item.seat === seatId && item.status === 'completed')
    notes.push(`${label}：${statement
      ? statedReason(statement) || '否决'
      : '否决'}`)
  }
  for (const statement of attempt.statements) {
    if (statement.status !== 'invalid-veto') {
      continue
    }
    const seat = loaded.byId.get(statement.seat)
    const label = seat
      ? `${seat.identity.name}（${seat.role}）`
      : statement.seat
    notes.push(`${label}：${statedReason(statement) || '未写理由'}（否决未写理由，未计入）`)
  }
  return notes
}
export async function writeOutputs(context: RunnerContext): Promise<RoundtableResult> {
  const { loaded, state, runDir } = context
  const record = buildRecord(state, loaded.table.title)
  const recordPath = join(runDir, 'record.json')
  await writeJson(join(runDir, 'state.json'), state)
  await writeJson(recordPath, record)
  await writeText(join(runDir, 'record.md'), renderRecordMarkdown(record, loaded.byId))
  return {
    status: record.status,
    recordPath,
    runDir,
    record,
    used: countCalls(state)
  }
}

function countCalls(state: RunState): number {
  return state.attempts.reduce((sum, attempt) => sum + attempt.statements.length, 0)
}

/**
 * Run attempts until the meeting passes, aborts, or runs out of attempts.
 *
 * `state` is mutated in place and persisted after every landed statement, which
 * is what makes a crash resumable: the pool on disk is the pool on the table.
 */
export async function runLoop(context: RunnerContext, resumeFrom?: { pool: Statement[], startedAt: number }): Promise<RoundtableResult> {
  const { loaded, state, options } = context
  const table = loaded.table

  for (;;) {
    const attemptNumber = state.attempt
    const attemptStarted = resumeFrom?.startedAt ?? context.now()
    const startedAtIso = context.stamp()

    state.status = 'running'
    state.startedAt = state.startedAt || startedAtIso
    // A resumed attempt keeps its original clock, so the remaining time is what
    // is left, not a fresh `durationMs`.
    const attempt: AttemptState = {
      attempt: attemptNumber,
      startedAt: startedAtIso,
      statements: resumeFrom?.pool ?? []
    }
    state.attempts = state.attempts.filter(item => item.attempt !== attemptNumber)
    state.attempts.push(attempt)
    state.pool = attempt.statements

    // A fresh round carries the previous round's reasons; a resumed round reuses
    // what it was opened with, so the seats that speak after the crash still know
    // why the table met again.
    const notes = rejectionNotes(loaded, state.attempts.find(item => item.attempt === attemptNumber - 1))
    if (resumeFrom) {
      state.notes = state.notes ?? []
    }
    else {
      state.notes = notes
    }
    await context.persist()

    options.onProgress?.(`roundtable: 第 ${attemptNumber} 轮讨论开始`)

    let abortedBy: string | undefined
    try {
      const result = await discuss({
        loaded,
        topic: state.topic,
        brief: state.brief,
        context: state.context,
        env: options.env,
        priorPool: resumeFrom?.pool?.length
          ? [...resumeFrom.pool]
          : undefined,
        revisionNotes: state.notes?.length ? state.notes : undefined,
        startedAt: attemptStarted,
        attempt: attemptNumber,
        callText: options.callText,
        tools: options.tools,
        now: context.now,
        writeArtifact: context.writeArtifact,
        persist: context.persist,
        events: {
          onStatement: (statement) => {
            options.onProgress?.(`  ${statement.name} · ${statement.status}`)
          }
        }
      })
      // `discuss` already returns only what this run produced; the resumed pool
      // it was given is not part of `result.statements`. Slicing again here
      // would drop the first new line of every resumed discussion.
      attempt.statements.push(...result.statements)
      state.pool = attempt.statements
      // Kept on the state, not only in the statements: the record is written from
      // here, and the output is what a caller running this meeting wants.
      if (result.output) {
        state.output = result.output
      }
      state.usage.input += result.usage.input
      state.usage.output += result.usage.output
      abortedBy = result.abortedBy?.seat
      if (result.abortedBy) {
        state.error = `席位 ${result.abortedBy.seat} 失败并要求中止：${result.abortedBy.error}`
      }
    }
    catch (error) {
      if (error instanceof RoundtableConfigError) {
        throw error
      }
      state.status = 'failed'
      state.error = error instanceof Error
        ? error.message
        : String(error)
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    attempt.finishedAt = context.stamp()
    attempt.verdict = judgeAttempt(loaded, attempt.statements)
    attempt.aborted = abortedBy !== undefined
    await context.persist()

    resumeFrom = undefined

    if (attempt.aborted) {
      state.status = 'aborted'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    if (attempt.verdict.passed) {
      state.status = 'passed'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    // No statement and no vote from anyone: discussing further cannot change
    // that, so the meeting is over rather than retried `maxAttempts` times.
    const spoke = attempt.statements.some(statement => statement.status === 'completed')
    if (!spoke) {
      state.status = 'rejected'
      state.error = '没有任何席位完成发言'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    if (attemptNumber >= table.maxAttempts) {
      state.status = 'rejected'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    if (table.onVeto === 'abort') {
      state.status = 'aborted'
      state.error = '规则要求被否决即中止（onVeto: abort）'
      state.finishedAt = context.stamp()
      return writeOutputs(context)
    }

    // `re-propose` and `revise` both open another discussion; the difference is
    // which veto reasons it may carry in, recorded in the attempt history.
    state.attempt = attemptNumber + 1
    options.onProgress?.(`roundtable: 第 ${attemptNumber} 轮未通过，进入第 ${attemptNumber + 1} 轮`)
  }
}
