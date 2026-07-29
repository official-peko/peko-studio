// The agent CLIs the panel can drive, and the adapters that turn each one's
// output into the transcript items the panel renders.
//
// Every provider is one of three protocol shapes:
//
//   stream-json  Claude Code. One long-lived process; further messages are
//                written to its stdin. Streams token deltas and supports the
//                inline approval flow.
//   jsonl        Codex and opencode. One process per turn, emitting one JSON
//                event per line; the conversation continues by passing the
//                previous session id back.
//   json         Gemini. One process per turn emitting a single JSON object at
//                the end, so there is no incremental output.
//   text         Aider, and anything else. One process per turn with plain
//                stdout; every line is shown as it arrives.
//
// Adding a provider means adding an entry here plus a branch in main.peko's
// agent_command / agent_turn_args.
//
// An adapter never silently drops a line it does not recognize. Unrecognized
// output becomes a log item carrying the raw text, so a provider whose format
// has changed degrades to showing raw output rather than an empty panel.
import { type AgentItem, normalize as normalizeClaude, toolSummary } from './protocol'

export type ProviderId = 'claude' | 'codex' | 'gemini' | 'opencode' | 'aider'

export interface Provider {
  id: ProviderId
  label: string
  /// Whether the conversation is one process (stdin) or one process per turn.
  session: 'persistent' | 'oneshot'
  /// Assistant text arrives incrementally rather than in one block.
  streams: boolean
  /// The CLI can hand individual actions back for an Allow/Deny decision.
  inlineApproval: boolean
  /// Permission modes this CLI can actually honor.
  modes: string[]
  /// Shown when the CLI is not installed.
  install: string
}

export const PROVIDERS: Provider[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    session: 'persistent',
    streams: true,
    inlineApproval: true,
    modes: ['ask', 'acceptEdits', 'bypassPermissions', 'plan'],
    install: 'npm i -g @anthropic-ai/claude-code',
  },
  {
    id: 'codex',
    label: 'Codex',
    session: 'oneshot',
    streams: false,
    inlineApproval: false,
    modes: ['acceptEdits', 'bypassPermissions', 'plan'],
    install: 'npm i -g @openai/codex',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    session: 'oneshot',
    streams: false,
    inlineApproval: false,
    modes: ['acceptEdits', 'bypassPermissions'],
    install: 'npm i -g @google/gemini-cli',
  },
  {
    id: 'opencode',
    label: 'opencode',
    session: 'oneshot',
    streams: false,
    inlineApproval: false,
    modes: ['acceptEdits', 'bypassPermissions'],
    install: 'curl -fsSL https://opencode.ai/install | bash',
  },
  {
    id: 'aider',
    label: 'Aider',
    session: 'oneshot',
    streams: false,
    inlineApproval: false,
    modes: ['acceptEdits', 'plan'],
    install: 'python -m pip install aider-install && aider-install',
  },
]

export function providerById(id: string): Provider {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/// The wrapper's own meta events, which every provider shares because the native
/// side emits them: log, stderr, error, exit, and the approval bridge.
function wrapperEvent(e: Record<string, unknown>): AgentItem[] | undefined {
  if (typeof e.t !== 'string') return undefined
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

/// Show a line the adapter has no mapping for, rather than dropping it.
function unknown(raw: unknown): AgentItem[] {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  if (!text || text === '{}') return []
  return [{ kind: 'log', text }]
}

// ---------------------------------------------------------------------------
// Codex: thread.started / turn.* / item.* with a typed item payload.
// ---------------------------------------------------------------------------

function codexItem(item: Record<string, unknown>, completed: boolean): AgentItem[] {
  const type = String(item.type ?? '')
  const id = String(item.id ?? '')
  switch (type) {
    case 'agent_message':
      // Only the completed form carries the finished text.
      return completed ? [{ kind: 'text', text: String(item.text ?? '') }] : []
    case 'reasoning':
      return completed && item.text ? [{ kind: 'log', text: String(item.text) }] : []
    case 'command_execution': {
      const command = String(item.command ?? '')
      if (!completed) return [{ kind: 'tool', toolId: id, name: 'Bash', input: item, summary: `Run: ${command.slice(0, 80)}` }]
      const output = String(item.aggregated_output ?? item.output ?? '')
      return output ? [{ kind: 'tool_result', toolUseId: id, text: output, isError: Number(item.exit_code ?? 0) !== 0 }] : []
    }
    case 'file_change': {
      if (!completed) return []
      const changes = Array.isArray(item.changes) ? (item.changes as Record<string, unknown>[]) : []
      const names = changes.map((c) => String(c.path ?? '').split('/').pop()).filter(Boolean)
      return [{ kind: 'tool', toolId: id, name: 'Edit', input: item, summary: `Edit ${names.join(', ') || 'files'}` }]
    }
    case 'mcp_tool_call':
      return completed ? [] : [{ kind: 'tool', toolId: id, name: String(item.tool ?? 'tool'), input: item, summary: `Tool ${String(item.tool ?? '')}` }]
    case 'web_search':
      return completed ? [] : [{ kind: 'tool', toolId: id, name: 'WebFetch', input: item, summary: `Search ${String(item.query ?? '')}` }]
    case 'todo_list':
      return completed ? [] : [{ kind: 'tool', toolId: id, name: 'TodoWrite', input: item, summary: 'Update task list' }]
    case 'error':
      return [{ kind: 'error', text: String(item.message ?? 'error') }]
    default:
      return completed ? unknown(item) : []
  }
}

function normalizeCodex(raw: unknown): AgentItem[] {
  const e = (raw ?? {}) as Record<string, unknown>
  const wrapped = wrapperEvent(e)
  if (wrapped) return wrapped
  const type = String(e.type ?? '')

  if (type === 'thread.started') {
    return [{ kind: 'system', sessionId: String(e.thread_id ?? '') }]
  }
  if (type === 'turn.started') return []
  if (type === 'turn.completed') {
    const usage = (e.usage ?? {}) as Record<string, unknown>
    const total = Number(usage.input_tokens ?? 0) + Number(usage.output_tokens ?? 0)
    return [{ kind: 'result', text: total ? `${total} tokens` : '', error: false }]
  }
  if (type === 'turn.failed') {
    const err = (e.error ?? {}) as Record<string, unknown>
    return [{ kind: 'result', text: String(err.message ?? 'turn failed'), error: true }]
  }
  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = (e.item ?? {}) as Record<string, unknown>
    return codexItem(item, type === 'item.completed')
  }
  if (type === 'error') {
    return [{ kind: 'error', text: String(e.message ?? 'error') }]
  }
  return unknown(e)
}

// ---------------------------------------------------------------------------
// opencode: {type, sessionID, ...}. The error envelope is confirmed; other
// event names are mapped on a best effort and fall through to raw output.
// ---------------------------------------------------------------------------

function normalizeOpencode(raw: unknown): AgentItem[] {
  const e = (raw ?? {}) as Record<string, unknown>
  const wrapped = wrapperEvent(e)
  if (wrapped) return wrapped
  const type = String(e.type ?? '')
  const items: AgentItem[] = []

  const session = e.sessionID ?? e.sessionId
  if (session) items.push({ kind: 'system', sessionId: String(session) })

  if (type === 'error') {
    const err = (e.error ?? {}) as Record<string, unknown>
    const data = (err.data ?? {}) as Record<string, unknown>
    items.push({ kind: 'error', text: String(data.message ?? err.name ?? 'error') })
    return items
  }
  if (type === 'text' || type === 'message') {
    const text = String(e.text ?? (e.part as Record<string, unknown>)?.text ?? '')
    if (text) items.push({ kind: 'text', text })
    return items
  }
  if (type === 'tool' || type === 'tool_use') {
    const name = String(e.tool ?? e.name ?? 'tool')
    items.push({ kind: 'tool', toolId: String(e.id ?? ''), name, input: e, summary: toolSummary(name, e) })
    return items
  }
  if (type === 'finish' || type === 'done' || type === 'result') {
    items.push({ kind: 'result', text: String(e.text ?? ''), error: false })
    return items
  }
  return items.concat(unknown(e))
}

// ---------------------------------------------------------------------------
// Gemini: a single object at the end of the turn, {response, stats, error}.
// ---------------------------------------------------------------------------

function normalizeGemini(raw: unknown): AgentItem[] {
  const e = (raw ?? {}) as Record<string, unknown>
  const wrapped = wrapperEvent(e)
  if (wrapped) return wrapped

  if (e.error) {
    const err = (e.error ?? {}) as Record<string, unknown>
    return [{ kind: 'error', text: String(err.message ?? 'error') }]
  }
  if (typeof e.response === 'string') {
    return [
      { kind: 'text', text: e.response },
      { kind: 'result', text: '', error: false },
    ]
  }
  // The streaming variant emits per-event objects rather than one final one.
  const type = String(e.type ?? '')
  if (type === 'message' || type === 'assistant') {
    const text = String(e.content ?? e.text ?? '')
    return text ? [{ kind: 'text', text }] : []
  }
  if (type === 'tool_use') {
    const name = String(e.name ?? 'tool')
    return [{ kind: 'tool', toolId: String(e.id ?? ''), name, input: e.args ?? e.input, summary: toolSummary(name, e.args ?? e.input) }]
  }
  if (type === 'tool_result') {
    return [{ kind: 'tool_result', toolUseId: String(e.id ?? ''), text: String(e.output ?? ''), isError: false }]
  }
  if (type === 'error') return [{ kind: 'error', text: String(e.message ?? 'error') }]
  if (type === 'result') return [{ kind: 'result', text: String(e.response ?? ''), error: false }]
  if (type === 'init') return [{ kind: 'system', sessionId: String(e.session_id ?? '') }]
  return unknown(e)
}

// ---------------------------------------------------------------------------
// Plain text: every line is assistant output.
// ---------------------------------------------------------------------------

function normalizeText(raw: unknown): AgentItem[] {
  const e = (raw ?? {}) as Record<string, unknown>
  const wrapped = wrapperEvent(e)
  if (wrapped) {
    // A text provider's real output arrives as wrapper log lines, so promote
    // those into assistant text instead of dimming them as diagnostics.
    return wrapped.map((item) => (item.kind === 'log' ? { kind: 'text', text: item.text } : item))
  }
  return unknown(e)
}

/// Turn one raw event from `provider` into transcript items.
export function normalizeFor(provider: ProviderId, raw: unknown): AgentItem[] {
  switch (provider) {
    case 'codex':
      return normalizeCodex(raw)
    case 'opencode':
      return normalizeOpencode(raw)
    case 'gemini':
      return normalizeGemini(raw)
    case 'aider':
      return normalizeText(raw)
    default:
      return normalizeClaude(raw)
  }
}
