// Typed wrappers over the native agent bridge. The host spawns the agent CLI
// (Claude Code) as a streaming session and forwards its JSON events over the
// ide.agent:event push channel; input is sent back as newline-delimited JSON.
import { peko } from '@peko/client'

/// One CLI's availability, as reported by the host probing it with --version.
export interface ProviderStatus {
  id: string
  available: boolean
  version?: string
  session?: 'persistent' | 'oneshot'
}

export interface AgentStatus {
  available: boolean
  version?: string
  providers?: ProviderStatus[]
}

/// Which agent CLIs are installed and reachable. `providers` lists every one the
/// host knows about; `available` refers to the default (Claude Code) so an older
/// panel keeps working.
export async function agentStatus(): Promise<AgentStatus> {
  try {
    const result = (await peko.invoke('ide.agent.status', {})) as AgentStatus
    return {
      available: result.available === true,
      version: result.version,
      providers: Array.isArray(result.providers) ? result.providers : undefined,
    }
  } catch {
    return { available: false }
  }
}

/// Start (or restart) the agent session in the workspace with a permission mode,
/// provider, and model. A non-empty `resume` continues a prior session by id; an
/// empty `model` leaves the choice to the CLI's own configuration. For a one-shot
/// provider this only records the choice; the first message starts the first
/// turn. Events arrive on the ide.agent:event channel.
export async function agentStart(mode = 'ask', resume = '', provider = 'claude', model = ''): Promise<boolean> {
  try {
    const result = (await peko.invoke('ide.agent.start', { mode, resume, provider, model })) as { ok?: boolean }
    return result.ok === true
  } catch {
    return false
  }
}

/// Run one turn of a one-shot provider with `text` as the prompt. `resume` is
/// the session id seen in the previous turn, which is what continues the thread.
export async function agentSend(text: string, mode: string, resume = '', model = ''): Promise<boolean> {
  try {
    const result = (await peko.invoke('ide.agent.send', { text, mode, resume, model })) as { ok?: boolean }
    return result.ok === true
  } catch {
    return false
  }
}

/// Send one newline-delimited JSON line to the agent's stdin.
export async function agentInput(line: string): Promise<void> {
  try {
    await peko.invoke('ide.agent.input', { line })
  } catch {
    // No bridge; nothing to send.
  }
}

/// Record an allow/deny decision for a pending action from the approval bridge.
/// A denial can carry the user's reason, which the agent reads as the result of
/// the action it asked for.
export async function agentApprove(id: string, allow: boolean, message = ''): Promise<void> {
  try {
    await peko.invoke('ide.agent.approve', { id, behavior: allow ? 'allow' : 'deny', message })
  } catch {
    // No bridge; nothing to record.
  }
}

/// Stop and terminate the agent session.
export async function agentStop(): Promise<void> {
  try {
    await peko.invoke('ide.agent.stop', {})
  } catch {
    // No bridge; nothing to stop.
  }
}

/// Subscribe to raw agent events (Claude Code JSON events and wrapper meta
/// events). Returns an unsubscribe function.
export function onAgentEvent(handler: (event: unknown) => void): () => void {
  return peko.on('ide.agent:event', handler)
}

/// One persisted chat thread. The transcript is the panel's own Entry list,
/// stored opaquely; sessionId is Claude's session for resuming the conversation.
export interface StoredThread {
  id: string
  title: string
  sessionId?: string
  createdAt: number
  transcript: unknown[]
}

/// Load this workspace's saved chat threads (newest first is the panel's job).
export async function threadsGet(): Promise<StoredThread[]> {
  try {
    const result = (await peko.invoke('ide.agent.threads.get', {})) as StoredThread[]
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

/// Persist this workspace's chat threads. The whole array is written at once.
export async function threadsSet(threads: StoredThread[]): Promise<void> {
  try {
    await peko.invoke('ide.agent.threads.set', { data: JSON.stringify(threads) })
  } catch {
    // No bridge; nothing to persist.
  }
}
