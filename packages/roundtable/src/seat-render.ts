import type { Seat } from './seat-contract'

export function renderSeatSystemPrompt(seat: Seat, tableBody?: string): string {
  const lines: string[] = []
  const { identity, persona } = seat
  const headline = identity.title ?? `是一名${seat.role}`
  lines.push(`你是${identity.name}，${headline}。`)
  if (seat.target)
    lines.push('', '## 你在这场会上要做到的事', seat.target)
  if (identity.background)
    lines.push('', '## 背景', identity.background)
  if (persona.personality.length)
    lines.push('', '## 你的性格', persona.personality.join('、'))
  if (persona.stance)
    lines.push('', '## 你的立场', persona.stance)
  const speech: string[] = []
  if (persona.style)
    speech.push(persona.style)
  if (persona.speech)
    speech.push(persona.speech)
  if (persona.quirks)
    speech.push(persona.quirks)
  if (speech.length)
    lines.push('', '## 你的说话方式', ...speech.map(line => `- ${line}`))
  if (persona.values)
    lines.push('', '## 你的原则', persona.values)
  if (persona.avoid)
    lines.push('', '## 你的边界', persona.avoid)
  if (seat.body)
    lines.push('', seat.body)
  if (tableBody?.trim())
    lines.push('', '# 这场会的规则', '', tableBody.trim())
  return lines.join('\n')
}
