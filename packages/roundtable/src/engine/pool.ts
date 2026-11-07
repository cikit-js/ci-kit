import type { Statement } from '../prompt'

/**
 * Rough token estimate used for the pool cap, `maxPoolTokens`.
 *
 * CJK ideographs are about one token each; everything else clusters around four
 * characters per token. Counting both keeps the estimate honest for mixed text.
 */
export function estimateTokens(content: string): number {
  const cjk = (content.match(/[\u3400-\u9FFF\uF900-\uFAFF]/g) ?? []).length
  const rest = content.length - cjk
  return cjk + Math.ceil(rest / 4)
}

/**
 * Keep the newest entries that fit in `maxPoolTokens`.
 *
 * Trimming from the front is deliberate: an old statement is the one the meeting
 * has already reacted to, and the cost of forgetting is "long talks lose their
 * opening" — bounded and predictable — instead of "the meeting stops".
 */
export function trimPool(pool: Statement[], maxPoolTokens: number): { kept: Statement[], dropped: number } {
  let total = 0
  let firstKept = pool.length
  // Walk backwards so the most recent statements are always kept, even when a
  // single long one exceeds the cap on its own.
  for (let index = pool.length - 1; index >= 0; index--) {
    const cost = estimateTokens(pool[index]!.content)
    if (total + cost > maxPoolTokens && firstKept !== pool.length) {
      break
    }
    total += cost
    firstKept = index
  }
  return {
    kept: pool.slice(firstKept),
    dropped: firstKept
  }
}
