import type { JsonProperty, JsonSchema } from './types'

export const REPLY_TOOL = 'submit_reply'

function matches(value: unknown, schema: JsonProperty): boolean {
  if (schema.anyOf && !schema.anyOf.some(option => matches(value, option))) {
    return false
  }
  if (schema.enum && (typeof value !== 'string' || !schema.enum.includes(value))) {
    return false
  }
  switch (schema.type) {
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false
      }
      const fields = schema.properties ?? {}
      return (schema.required ?? []).every(key => Object.hasOwn(value, key))
        && Object.entries(value).every(([key, item]) => Object.hasOwn(fields, key)
          ? matches(item, fields[key]!)
          : schema.additionalProperties !== false)
    }
    case 'array':
      return Array.isArray(value) && (!schema.items || value.every(item => matches(item, schema.items!)))
    case 'integer':
      return Number.isInteger(value)
    case 'null':
      return value === null
    case undefined:
      return true
    case 'string':
      return typeof value === 'string'
    case 'number':
      return Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
  }
}

export function parseSchemaReply(input: string, schema: JsonSchema): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    return matches(value, schema)
      ? value
      : undefined
  }
  catch {
    return undefined
  }
}
