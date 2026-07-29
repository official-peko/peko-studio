// Adapter for Claude Code's --output-format stream-json protocol. Each stdout
// line is one JSON event; this normalizes those (and the wrapper's own meta
// events) into a small set the chat panel renders, and builds the JSON lines
// sent back on stdin (user messages and permission responses). Isolating the
// protocol here lets a different agent CLI be supported by rewriting this file.

export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'default'

// A normalized item the panel appends to the transcript.
export type AgentItem =
  | { kind: 'system'; model?: string; sessionId?: string; tools?: string[] }
  | { kind: 'text'; text: string }
  // toolId is the agent's own id for the call, kept distinct from the numeric
  // id the panel assigns each transcript entry. Naming both `id` let the entry
  // id overwrite this one, which lost the only key tying a result to its call.
  | { kind: 'tool'; toolId: string; name: string; summary: string; input: unknown }
  | { kind: 'tool_result'; toolUseId: string; text: string; isError: boolean }
  | { kind: 'result'; text: string; costUsd?: number; error: boolean }
  | { kind: 'permission'; requestId: string; tool: string; summary: string; input: unknown; approvalId?: string }
  | { kind: 'log'; text: string }
  | { kind: 'stderr'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'exit'; code: number }
  // Partial-message streaming: a new assistant text block begins, grows by
  // deltas, then ends. The final (whole) assistant text event is ignored in
  // favor of these so the text appears token by token.
  | { kind: 'stream_start' }
  | { kind: 'stream_text'; text: string }
  | { kind: 'stream_end' }

// A short, human label for a tool call from its name and input.
export function toolSummary(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>
  const file = (inp.file_path ?? inp.path ?? inp.notebook_path) as string | undefined
  const rel = file ? file.split('/').pop() : undefined
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `Edit ${rel ?? 'file'}`
    case 'Write':
      return `Write ${rel ?? 'file'}`
    case 'Read':
      return `Read ${rel ?? 'file'}`
    case 'Bash':
      return `Run: ${String(inp.command ?? '').slice(0, 80)}`
    case 'Glob':
      return `Find ${String(inp.pattern ?? '')}`
    case 'Grep':
      return `Search ${String(inp.pattern ?? '')}`
    case 'WebFetch':
      return `Fetch ${String(inp.url ?? '')}`
    case 'TodoWrite':
      return 'Update task list'
    default:
      return name
  }
}

// Pull the text out of a tool_result content field, which may be a string or an
// array of content blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'string' ? b : ((b as Record<string, unknown>).text as string) ?? ''))
      .join('')
  }
  return ''
}

// Normalize one raw event (a Claude Code event, or a wrapper meta event with a
// `t` field) into zero or more transcript items.
export function normalize(raw: unknown): AgentItem[] {
  const e = (raw ?? {}) as Record<string, unknown>

  // Wrapper meta events carry `t`; agent events carry `type`.
  if (typeof e.t === 'string') {
    switch (e.t) {
      case 'log':
        return [{ kind: 'log', text: String(e.text ?? '') }]
      case 'stderr':
        return [{ kind: 'stderr', text: String(e.text ?? '') }]
      case 'error':
        return [{ kind: 'error', text: String(e.message ?? e.text ?? 'error') }]
      case 'exit':
        return [{ kind: 'exit', code: Number(e.code ?? 0) }]
      case 'approval': {
        // A gated action from the approval MCP server, awaiting the user.
        const tool = String(e.tool_name ?? 'tool')
        const id = String(e.id ?? '')
        return [
          {
            kind: 'permission',
            requestId: id,
            approvalId: id,
            tool,
            input: e.input,
            summary: toolSummary(tool, e.input),
          },
        ]
      }
      default:
        return []
    }
  }

  const type = String(e.type ?? '')

  // Partial streaming deltas (Anthropic SSE wrapped in stream_event).
  if (type === 'stream_event') {
    const ev = (e.event ?? {}) as Record<string, unknown>
    const et = String(ev.type ?? '')
    if (et === 'message_start') return [{ kind: 'stream_start' }]
    if (et === 'content_block_delta') {
      const delta = (ev.delta ?? {}) as Record<string, unknown>
      if (delta.type === 'text_delta') return [{ kind: 'stream_text', text: String(delta.text ?? '') }]
    }
    if (et === 'message_stop') return [{ kind: 'stream_end' }]
    return []
  }

  if (type === 'system') {
    return [
      {
        kind: 'system',
        model: e.model as string | undefined,
        sessionId: e.session_id as string | undefined,
        tools: e.tools as string[] | undefined,
      },
    ]
  }

  if (type === 'assistant') {
    const msg = (e.message ?? {}) as Record<string, unknown>
    const content = (msg.content ?? []) as Record<string, unknown>[]
    const items: AgentItem[] = []
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        items.push({ kind: 'text', text: String(block.text) })
      } else if (block.type === 'tool_use') {
        const name = String(block.name ?? 'tool')
        items.push({
          kind: 'tool',
          toolId: String(block.id ?? ''),
          name,
          input: block.input,
          summary: toolSummary(name, block.input),
        })
      }
    }
    return items
  }

  if (type === 'user') {
    const msg = (e.message ?? {}) as Record<string, unknown>
    const content = (msg.content ?? []) as Record<string, unknown>[]
    const items: AgentItem[] = []
    for (const block of content) {
      if (block.type === 'tool_result') {
        items.push({
          kind: 'tool_result',
          toolUseId: String(block.tool_use_id ?? ''),
          text: resultText(block.content),
          isError: Boolean(block.is_error),
        })
      }
    }
    return items
  }

  if (type === 'result') {
    return [
      {
        kind: 'result',
        text: String(e.result ?? ''),
        costUsd: e.total_cost_usd as number | undefined,
        error: e.is_error === true || String(e.subtype ?? 'success') !== 'success',
      },
    ]
  }

  // Permission request over the control protocol. The exact envelope may vary by
  // Claude Code version, so both the top-level and nested request are inspected.
  if (type === 'control_request') {
    const req = (e.request ?? {}) as Record<string, unknown>
    if (String(req.subtype ?? '') === 'can_use_tool') {
      const tool = String(req.tool_name ?? req.tool ?? 'tool')
      return [
        {
          kind: 'permission',
          requestId: String(e.request_id ?? req.request_id ?? ''),
          tool,
          input: req.input,
          summary: toolSummary(tool, req.input),
        },
      ]
    }
    return []
  }

  return []
}

// A user text message line for the agent's stdin.
export function userMessageLine(text: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })
}

// A permission decision line for the agent's stdin, answering a can_use_tool
// control request.
export function permissionResponseLine(requestId: string, allow: boolean): string {
  return JSON.stringify({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: { behavior: allow ? 'allow' : 'deny' },
    },
  })
}
