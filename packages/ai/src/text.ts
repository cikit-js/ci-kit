import type { ChatResponse } from './transport'
import type { AiResult, TextOptions, ToolExecution } from './types'
import process from 'node:process'
import { requestJson } from '@ci-kit/http'
import { AiError } from './errors'
import { resolveTextProvider } from './providers'
import { apiKeyOf, supportsJsonMode, supportsJsonSchema, supportsToolCalling, trimSlash, wrapError } from './transport'

export async function text(options: TextOptions): Promise<AiResult<string>> {
  const env = options.env ?? process.env
  const provider = resolveTextProvider(env)
  // A schema is a stronger way of saying "JSON", so it implies it.
  const wantJson = options.json === true || options.schema !== undefined

  if (wantJson && !supportsJsonMode(provider)) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: `Provider ${provider.id} does not support JSON output; remove json or schema, or change provider`
    })
  }

  const tools = options.tools && options.tools.length
    ? [...options.tools]
    : []
  if (tools.length && !supportsToolCalling(provider)) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: `Provider ${provider.id} does not support tool calling; remove tools or change provider`
    })
  }
  if (tools.length && !options.executeTool) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: 'Tool calling requires an executeTool handler'
    })
  }
  const maxToolCalls = options.maxToolCalls ?? 8
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 1) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: 'maxToolCalls must be a positive integer'
    })
  }
  const maxToolResultChars = options.maxToolResultChars ?? 12_000
  if (!Number.isInteger(maxToolResultChars) || maxToolResultChars < 100) {
    throw new AiError({
      kind: 'config',
      provider: provider.id,
      model: provider.model,
      message: 'maxToolResultChars must be an integer of at least 100'
    })
  }

  const key = apiKeyOf(env, provider.apiKeyEnv, provider.id)
  const messages: Array<Record<string, unknown>> = [
    ...(options.system
      ? [
          { role: 'system', content: options.system }
        ]
      : []),
    { role: 'user', content: options.prompt }
  ]

  const model = env.AI_TEXT_MODEL || provider.model
  const executions: ToolExecution[] = []
  let toolCallCount = 0
  let inputTokens = 0
  let outputTokens = 0

  for (;;) {
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: false
    }
    if (options.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens
    }
    if (options.temperature !== undefined) {
      body.temperature = options.temperature
    }
    if (options.reasoningEffort !== undefined) {
      // Sent as the OpenAI-compatible field: DashScope and the other
      // compatible-mode providers read it, and a provider that does not know it
      // ignores it rather than failing the call.
      body.reasoning_effort = options.reasoningEffort
    }
    if (wantJson) {
      body.response_format = options.schema && supportsJsonSchema(provider)
        // A named schema is enforced by the provider, so the model is not free to
        // invent field names; the parser downstream still treats it as untrusted.
        ? {
            type: 'json_schema',
            json_schema: { name: 'reply', strict: true, schema: options.schema }
          }
        : { type: 'json_object' }
    }
    if (tools.length) {
      body.tools = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          ...(tool.description
            ? { description: tool.description }
            : {}),
          parameters: tool.parameters
        }
      }))
      body.tool_choice = 'auto'
    }

    let data: ChatResponse
    try {
      data = await requestJson<ChatResponse>(`${trimSlash(provider.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      }, { timeoutMs: options.timeoutMs, retries: options.retries })
    }
    catch (error) {
      throw wrapError(error, provider, 'text')
    }

    inputTokens += Number(data.usage?.prompt_tokens) || 0
    outputTokens += Number(data.usage?.completion_tokens) || 0
    const choice = data.choices?.[0]
    const requested = choice?.message?.tool_calls ?? []
    if (requested.length) {
      if (!options.executeTool) {
        throw new AiError({
          kind: 'config',
          provider: provider.id,
          model: provider.model,
          message: 'Provider returned a tool call without an executeTool handler'
        })
      }
      if (toolCallCount + requested.length > maxToolCalls) {
        throw new AiError({
          kind: 'output',
          provider: provider.id,
          model: provider.model,
          message: `Tool call limit exceeded (${maxToolCalls})`
        })
      }
      const assistantCalls = requested.map((call, index) => ({
        id: call.id || `tool-call-${toolCallCount + index + 1}`,
        type: 'function',
        function: {
          name: call.function?.name || '',
          arguments: call.function?.arguments || '{}'
        }
      }))
      messages.push({
        role: 'assistant',
        content: choice?.message?.content ?? null,
        tool_calls: assistantCalls
      })
      for (const call of assistantCalls) {
        toolCallCount++
        const started = Date.now()
        const name = call.function.name
        const spec = tools.find(tool => tool.name === name)
        let args: unknown
        let result: unknown
        let errorText: string | undefined
        try {
          if (!spec)
            throw new Error(`Unknown tool ${name}`)
          args = JSON.parse(call.function.arguments)
          result = await options.executeTool({ id: call.id, name, arguments: args })
        }
        catch (error) {
          errorText = error instanceof Error
            ? error.message
            : 'Tool execution failed'
          result = { error: errorText }
        }
        let content: string
        try {
          content = JSON.stringify(result ?? null)
        }
        catch {
          result = { error: 'Tool result was not serializable' }
          content = JSON.stringify({ error: 'Tool result was not serializable' })
        }
        const execution: ToolExecution = {
          id: call.id,
          name,
          arguments: args ?? call.function.arguments,
          ...(errorText
            ? { error: errorText }
            : { result }),
          durationMs: Date.now() - started
        }
        executions.push(execution)
        if (content.length > maxToolResultChars) {
          content = `${content.slice(0, maxToolResultChars)}\n[tool result truncated]`
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content })
      }
      continue
    }

    const value = choice?.message?.content?.trim()
    if (!value) {
      throw new AiError({
        kind: 'output',
        provider: provider.id,
        model: provider.model,
        message: 'Empty text response from provider'
      })
    }

    // A truncated response is still a string; callers must be able to tell.
    const finishReason = choice?.finish_reason
    if (finishReason && finishReason !== 'stop') {
      throw new AiError({
        kind: 'output',
        provider: provider.id,
        model: provider.model,
        retryable: finishReason === 'length',
        message: `Text generation ended with finish_reason=${finishReason}; the content is incomplete`
      })
    }

    return {
      value,
      provider: provider.id,
      model,
      usage: inputTokens || outputTokens
        ? { input: inputTokens, output: outputTokens }
        : undefined,
      finishReason,
      ...(executions.length
        ? { toolCalls: executions }
        : {})
    }
  }
}
