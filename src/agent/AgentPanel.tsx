// The AI agent chat panel: a thin wrapper over an agent CLI (Claude Code, or one
// of the other CLIs in providers.ts). It spawns the CLI as a session, renders its
// assistant text, tool calls, and results, decides every action the agent asks
// permission for, and offers slash commands and @file autocomplete in the
// composer. The heavy lifting (the agent loop, editing files, talking to the
// model, auth) is the CLI's; this panel drives it and shows the conversation.
// Edits the agent makes to files show up live through the editor's file watcher.
//
// Permission policy lives here rather than in the CLI. The host runs the CLI in
// its "manual" mode, where every gated action is handed back for a decision, so
// the mode picked in the header applies to the very next action — including a
// switch to Allow everything part-way through a long run. "Always allow" rules
// add to that for the rest of the session.
//
// Conversations are organized into threads. One agent process runs at a time,
// for the active thread. Switching threads stops that process; the next message
// in a thread resumes its session by id. Threads persist per workspace.
import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  agentStatus,
  agentStart,
  agentStop,
  agentInput,
  agentSend,
  agentApprove,
  onAgentEvent,
  threadsGet,
  threadsSet,
  type AgentStatus,
} from './agent'
import {
  userMessageLine,
  permissionResponseLine,
  interruptLine,
  type AgentItem,
  type PermissionMode,
} from './protocol'
import { PROVIDERS, providerById, normalizeFor, type ProviderId } from './providers'
import { installAgentPlugin } from './plugin'
import { projectSources } from '../ide/workspace'

// A transcript entry: a normalized agent item or a user message, with a stable
// id. A tool entry absorbs its own result, so a call and what it returned stay
// one row instead of drifting apart in a busy transcript.
type Entry = ({ kind: 'user'; text: string } | AgentItem) & {
  id: number
  resolved?: 'allow' | 'deny'
  result?: { text: string; isError: boolean }
}

// One conversation. transcript is the rendered entry list; sessionId is the
// CLI's session for the thread, used to resume it after the process has stopped.
interface Thread {
  id: string
  title: string
  sessionId?: string
  createdAt: number
  transcript: Entry[]
}

const NEW_TITLE = 'New chat'
const EMPTY: Entry[] = []
// Tools that change files, auto-approved from the "Auto-accept edits" mode up.
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
// Tools that only look at the project. Approving each one individually is noise
// with no decision in it, so they are allowed in every mode that acts.
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'TodoWrite']

let entryCounter = 0
const nextId = () => ++entryCounter
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
const newThread = (): Thread => ({ id: genId(), title: NEW_TITLE, createdAt: Date.now(), transcript: [] })

// Render assistant markdown to sanitized HTML (code blocks, lists, emphasis,
// links). Uses the same marked + DOMPurify pipeline as the file preview.
function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string),
    [text],
  )
  return <div className="agent-markdown" dangerouslySetInnerHTML={{ __html: html }} />
}

// The most relevant piece of a tool's input to show on a permission card: the
// command for Bash, the target path for file tools, otherwise nothing.
function permissionDetail(tool: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>
  if (tool === 'Bash' && typeof inp.command === 'string') return inp.command
  const file = (inp.file_path ?? inp.path ?? inp.notebook_path) as string | undefined
  if (file) return file
  if (typeof inp.url === 'string') return inp.url
  if (typeof inp.pattern === 'string') return inp.pattern
  return ''
}

// The rule an "Always allow" click creates, and how to describe it. A Bash rule
// covers the program rather than the exact command line — approving `npm test`
// and then being asked again for `npm run build` is the kind of prompt that
// trains people to stop reading them.
function allowRule(tool: string, input: unknown): { key: string; label: string } {
  if (tool === 'Bash') {
    const command = String(((input ?? {}) as Record<string, unknown>).command ?? '').trim()
    // The first bare word is the program: skip env assignments and `sudo`.
    const word = command.split(/\s+/).find((w) => !w.includes('=') && w !== 'sudo') ?? ''
    if (word) return { key: `Bash:${word}`, label: `Always allow ${word}` }
  }
  return { key: tool, label: `Always allow ${tool}` }
}

// Wrapper-level slash commands offered in the composer. They drive the session,
// not the model.
const COMMANDS = [
  { name: '/clear', desc: 'Clear this thread and start fresh' },
  { name: '/new', desc: 'Start a new chat thread' },
  { name: '/stop', desc: 'End the current session' },
  { name: '/allowed', desc: 'List and forget the always-allow rules' },
  { name: '/help', desc: 'Show what this panel can do' },
]

// Permission policy, chosen in the header and applied to each action as it is
// asked for. The ladder runs from least to most permissive: every mode allows
// what the one before it allows.
const MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask before changes', hint: 'Reading is automatic; edits and commands ask' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'Edits apply on their own; commands still ask' },
  { value: 'bypassPermissions', label: 'Allow everything', hint: 'Nothing asks. Use in projects you trust' },
  { value: 'plan', label: 'Plan only', hint: 'Works out an approach without touching anything' },
]

// Only Claude Code hands back individual actions for a decision. The other CLIs
// enforce their own policy for a whole run, so their mode list is narrower.
function modesFor(provider: ProviderId) {
  const allowed = providerById(provider).modes
  return MODES.filter((m) => allowed.includes(m.value))
}

/// Whether an action can be approved without asking, under `mode` and the rules
/// the user has added this session. Returns null when it has to be asked.
function autoAllow(mode: PermissionMode, tool: string, input: unknown, rules: Set<string>): string | null {
  if (mode === 'bypassPermissions') return 'Allow everything'
  if (READ_TOOLS.includes(tool)) return 'read-only'
  if (mode === 'acceptEdits' && EDIT_TOOLS.includes(tool)) return 'Auto-accept edits'
  if (rules.has(allowRule(tool, input).key)) return 'always allowed'
  return null
}

export function AgentPanel({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string>()
  const [mode, setMode] = useState<PermissionMode>('ask')
  const [provider, setProvider] = useState<ProviderId>('claude')
  const [modelChoice, setModelChoice] = useState('')
  const [rules, setRules] = useState<Set<string>>(new Set())
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeId, setActiveId] = useState('')
  const [threadMenu, setThreadMenu] = useState(false)
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [menu, setMenu] = useState<{ kind: 'cmd' | 'file'; token: string; items: { value: string; label: string; desc?: string }[] } | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingId = useRef<number | null>(null)
  // Whether the transcript is scrolled to (near) the bottom. New content only
  // auto-scrolls when it is, so reading earlier output is not interrupted.
  const stickBottom = useRef(true)
  const activeIdRef = useRef('')
  const loadedRef = useRef(false)
  // The event handler is mounted once, so everything it consults — the policy,
  // the rules, the adapter to dispatch through — has to be reachable by ref
  // rather than by closure capture.
  const modeRef = useRef(mode)
  const rulesRef = useRef(rules)
  const providerRef = useRef(provider)
  // An interrupted turn ends with the CLI's generic execution error. The user
  // asked for that, so it is reported as a stop rather than as a failure.
  const interruptedRef = useRef(false)
  useEffect(() => {
    modeRef.current = mode
  }, [mode])
  useEffect(() => {
    rulesRef.current = rules
  }, [rules])
  useEffect(() => {
    providerRef.current = provider
  }, [provider])

  const active = threads.find((t) => t.id === activeId) ?? null
  const transcript = active?.transcript ?? EMPTY
  const providerInfo = providerById(provider)

  // Keep a ref of the active thread id so the event handler (mounted once) always
  // writes into whichever thread is current.
  useEffect(() => {
    activeIdRef.current = activeId
    // A freshly shown thread starts pinned to its newest content.
    stickBottom.current = true
  }, [activeId])

  // Update the active thread's transcript in place.
  const patchTranscript = (fn: (entries: Entry[]) => Entry[]) =>
    setThreads((prev) => prev.map((t) => (t.id === activeIdRef.current ? { ...t, transcript: fn(t.transcript) } : t)))

  const append = (item: AgentItem | { kind: 'user'; text: string }) =>
    patchTranscript((prev) => [...prev, { ...item, id: nextId() } as Entry])

  // Load persisted threads and the @mention file list; check CLI availability;
  // install the Peko development skill for the agent.
  useEffect(() => {
    void installAgentPlugin()
    void agentStatus().then(setStatus)
    void projectSources().then(setFiles)
    void (async () => {
      const stored = await threadsGet()
      if (stored.length > 0) {
        // Re-key entry ids into this session's counter so React keys stay unique.
        const restored: Thread[] = stored.map((s) => ({
          id: String(s.id),
          title: String(s.title || NEW_TITLE),
          sessionId: s.sessionId,
          createdAt: Number(s.createdAt) || Date.now(),
          transcript: (Array.isArray(s.transcript) ? (s.transcript as Entry[]) : []).map((e) => ({
            ...e,
            id: nextId(),
          })),
        }))
        setThreads(restored)
        setActiveId(restored[0].id)
      } else {
        const t = newThread()
        setThreads([t])
        setActiveId(t.id)
      }
      loadedRef.current = true
    })()
  }, [])

  // Persist threads (debounced) once the initial load has settled.
  useEffect(() => {
    if (!loadedRef.current) return
    const handle = setTimeout(() => {
      void threadsSet(
        threads.map((t) => ({
          id: t.id,
          title: t.title,
          sessionId: t.sessionId,
          createdAt: t.createdAt,
          transcript: t.transcript,
        })),
      )
    }, 600)
    return () => clearTimeout(handle)
  }, [threads])

  // Stream agent events into the active thread. For a provider that streams,
  // assistant text arrives token by token via stream_start/stream_text/stream_end
  // into one growing entry and the whole-message echo is dropped; for one that
  // does not, the whole message is the only text there is. The session id is
  // captured for resuming the thread later.
  useEffect(() => {
    const off = onAgentEvent((raw) => {
      for (const item of normalizeFor(providerRef.current, raw)) {
        switch (item.kind) {
          case 'system':
            if (item.model) setModel(item.model)
            if (item.sessionId) {
              const sid = item.sessionId
              setThreads((prev) =>
                prev.map((t) => (t.id === activeIdRef.current && t.sessionId !== sid ? { ...t, sessionId: sid } : t)),
              )
            }
            break
          case 'stream_start': {
            const id = nextId()
            streamingId.current = id
            patchTranscript((prev) => [...prev, { id, kind: 'text', text: '' } as Entry])
            break
          }
          case 'stream_text': {
            const id = streamingId.current
            if (id != null) {
              patchTranscript((prev) =>
                prev.map((e) => (e.id === id && e.kind === 'text' ? { ...e, text: e.text + item.text } : e)),
              )
            }
            break
          }
          case 'stream_end': {
            const id = streamingId.current
            streamingId.current = null
            // Drop an empty streaming entry (a tool-only assistant message).
            if (id != null) {
              patchTranscript((prev) => prev.filter((e) => !(e.id === id && e.kind === 'text' && e.text === '')))
            }
            break
          }
          case 'text':
            // A streaming provider has already shown this text as it arrived.
            // Every other provider has nothing else to show, so dropping it
            // unconditionally is what left those CLIs looking mute.
            if (!providerById(providerRef.current).streams && item.text.trim()) append(item)
            break
          case 'tool_result':
            // Fold the result into the call it belongs to, and fall back to a row
            // of its own when the call is not in the transcript.
            patchTranscript((prev) => {
              const at = prev.findIndex((e) => e.kind === 'tool' && e.toolId === item.toolUseId)
              if (at < 0) return [...prev, { ...item, id: nextId() } as Entry]
              const next = prev.slice()
              next[at] = { ...next[at], result: { text: item.text, isError: item.isError } }
              return next
            })
            break
          case 'permission': {
            if (autoAllow(modeRef.current, item.tool, item.input, rulesRef.current)) {
              // Nothing to decide: the tool row already says what happened, so
              // approving silently keeps the transcript about the work.
              void respond(item, true)
            } else {
              append(item)
            }
            break
          }
          case 'result':
            setBusy(false)
            if (interruptedRef.current) {
              interruptedRef.current = false
              append({ kind: 'log', text: 'Stopped.' })
            } else {
              append(item)
            }
            break
          case 'error':
            setBusy(false)
            append(item)
            break
          case 'exit':
            setRunning(false)
            setBusy(false)
            // A one-shot provider exits at the end of every turn, so an exit is
            // only worth reporting when it ends a persistent session or when it
            // failed. Otherwise each message would leave a "session ended" note.
            if (providerById(providerRef.current).session === 'persistent' || item.code !== 0) {
              append(item)
            }
            break
          default:
            append(item)
        }
      }
    })
    return off
  }, [])

  // Follow new content only when already at the bottom.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [transcript])

  // Track whether the view is pinned to the bottom as the user scrolls.
  const onTranscriptScroll = () => {
    const el = scrollRef.current
    if (el) stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  // End the running session and clear per-session UI state. The thread keeps its
  // session id, so the next message resumes the conversation.
  const stopSession = async () => {
    await agentStop()
    setRunning(false)
    setBusy(false)
    streamingId.current = null
    interruptedRef.current = false
    setModel(undefined)
  }

  // Stop the turn in flight without ending the session, so the context survives
  // and the next message continues where this left off. A one-shot provider has
  // no session between turns, so there the turn and the process are the same.
  const interrupt = async () => {
    if (providerInfo.session === 'persistent' && running) {
      interruptedRef.current = true
      await agentInput(interruptLine())
      setBusy(false)
      // An action waiting on a decision holds the turn open, so the interrupt
      // would sit behind it. Denying the pending ones lets the turn unwind.
      for (const entry of transcript) {
        if (entry.kind === 'permission' && !entry.resolved) {
          void decide(entry, false)
        }
      }
      return
    }
    await stopSession()
  }

  // The model and the provider are fixed when the CLI is launched, so changing
  // either ends the session. The thread keeps its id and the next message
  // resumes it, which is why this does not clear the transcript.
  const restartForSetting = async () => {
    if (running) await stopSession()
  }

  // Clear the active thread's history and drop its session.
  const clearActive = async () => {
    await stopSession()
    setThreads((prev) =>
      prev.map((t) => (t.id === activeIdRef.current ? { ...t, transcript: [], sessionId: undefined, title: NEW_TITLE } : t)),
    )
  }

  const createThread = async () => {
    await stopSession()
    const t = newThread()
    setThreads((prev) => [t, ...prev])
    setActiveId(t.id)
    setThreadMenu(false)
  }

  const switchThread = async (id: string) => {
    setThreadMenu(false)
    if (id === activeId) return
    await stopSession()
    setActiveId(id)
  }

  const deleteThread = async (id: string) => {
    const remaining = threads.filter((t) => t.id !== id)
    if (id === activeId) await stopSession()
    if (remaining.length === 0) {
      const t = newThread()
      setThreads([t])
      setActiveId(t.id)
    } else {
      setThreads(remaining)
      if (id === activeId) setActiveId(remaining[0].id)
    }
  }

  const send = async () => {
    const text = input.trim()
    if (!text) return
    setMenu(null)
    if (text === '/clear') {
      setInput('')
      await clearActive()
      return
    }
    if (text === '/new') {
      setInput('')
      await createThread()
      return
    }
    if (text === '/stop') {
      setInput('')
      await stopSession()
      append({ kind: 'log', text: 'Session ended.' })
      return
    }
    if (text === '/allowed') {
      setInput('')
      const list = [...rules]
      setRules(new Set())
      append({
        kind: 'log',
        text: list.length
          ? `Forgot ${list.length} always-allow rule${list.length > 1 ? 's' : ''}: ${list.join(', ')}.`
          : 'No always-allow rules are set.',
      })
      return
    }
    if (text === '/help') {
      setInput('')
      append({
        kind: 'log',
        text: 'Type a request and the agent works in this project. Reference files with @, switch or start threads at the top, drive the session with /clear, /new, /stop, /allowed. The permission mode in the header applies to the next action, so you can loosen or tighten it mid-run.',
      })
      return
    }
    if (!running) {
      const ok = await agentStart(mode, active?.sessionId ?? '', provider, modelChoice)
      setRunning(ok)
      if (!ok) {
        append({ kind: 'error', text: `Could not start ${providerInfo.label}.` })
        return
      }
    }
    // Sending a message follows the reply from the bottom.
    stickBottom.current = true
    // Name a fresh thread after its first request.
    setThreads((prev) =>
      prev.map((t) => (t.id === activeIdRef.current && t.title === NEW_TITLE ? { ...t, title: text.slice(0, 40) } : t)),
    )
    append({ kind: 'user', text })
    setBusy(true)
    setInput('')
    // A persistent session takes the message on stdin. A one-shot provider has
    // no process between turns, so the message spawns one, carrying the session
    // id from the previous turn to continue the thread.
    if (providerInfo.session === 'persistent') {
      await agentInput(userMessageLine(text))
    } else {
      const ok = await agentSend(text, mode, active?.sessionId ?? '', modelChoice)
      if (!ok) {
        setBusy(false)
        append({ kind: 'error', text: `Could not run ${providerInfo.label}.` })
      }
    }
  }

  // Answer one permission request. Decisions from the approval bridge go back
  // through the file relay; a control-protocol request goes back on the agent's
  // stdin. Both carry the reason for a denial, which the agent reads as the
  // result of the action it asked for.
  const respond = async (
    request: { requestId: string; approvalId?: string },
    allow: boolean,
    message = '',
  ) => {
    if (request.approvalId) await agentApprove(request.approvalId, allow, message)
    else await agentInput(permissionResponseLine(request.requestId, allow, message))
  }

  // Answer a request the user was shown. `always` adds a rule first, so the rest
  // of the session stops asking about actions of the same kind. `reason` is the
  // user's own words on a denial, which the agent reads and can act on instead
  // of simply stopping.
  const decide = async (entry: Entry, allow: boolean, always = false, reason = '') => {
    if (entry.kind !== 'permission') return
    if (always) {
      const rule = allowRule(entry.tool, entry.input)
      setRules((prev) => new Set(prev).add(rule.key))
    }
    await respond(entry, allow, reason)
    patchTranscript((prev) => prev.map((e) => (e.id === entry.id ? { ...e, resolved: allow ? 'allow' : 'deny' } : e)))
  }

  // Autocomplete: a slash command at the start, or an @file token anywhere.
  const updateMenu = (value: string, caret: number) => {
    const before = value.slice(0, caret)
    const slash = /^\/(\w*)$/.exec(before)
    if (slash) {
      const q = slash[1]
      setMenu({
        kind: 'cmd',
        token: slash[0],
        items: COMMANDS.filter((c) => c.name.slice(1).startsWith(q)).map((c) => ({
          value: c.name + ' ',
          label: c.name,
          desc: c.desc,
        })),
      })
      return
    }
    const at = /@([\w./-]*)$/.exec(before)
    if (at) {
      const q = at[1].toLowerCase()
      const rel = (f: string) => (f.startsWith(root + '/') ? f.slice(root.length + 1) : f)
      const matches = files
        .map(rel)
        .filter((f) => f.toLowerCase().includes(q))
        .slice(0, 8)
      setMenu({ kind: 'file', token: at[0], items: matches.map((f) => ({ value: '@' + f + ' ', label: f })) })
      return
    }
    setMenu(null)
  }

  const applyMenu = (value: string) => {
    if (!menu) return
    const el = inputRef.current
    const caret = el?.selectionStart ?? input.length
    const before = input.slice(0, caret)
    const start = before.length - menu.token.length
    const next = input.slice(0, start) + value + input.slice(caret)
    setInput(next)
    setMenu(null)
    requestAnimationFrame(() => {
      el?.focus()
      const pos = start + value.length
      el?.setSelectionRange(pos, pos)
    })
  }

  const modeInfo = useMemo(() => MODES.find((m) => m.value === mode), [mode])

  // Offer only CLIs the host found installed. An older host that reports no
  // provider list is treated as Claude-only, which is what it supported.
  const installed = useMemo(() => {
    const list = status?.providers
    if (!list) return status?.available ? PROVIDERS.filter((p) => p.id === 'claude') : []
    return PROVIDERS.filter((p) => list.some((s) => s.id === p.id && s.available))
  }, [status])

  // Keep the selection on something that exists.
  useEffect(() => {
    if (installed.length > 0 && !installed.some((p) => p.id === provider)) {
      const next = installed[0]
      setProvider(next.id)
      setModelChoice('')
      if (!next.modes.includes(mode)) setMode(next.modes[0] as PermissionMode)
    }
  }, [installed, provider, mode])

  if (status && installed.length === 0) {
    return (
      <div className="agent-panel">
        <div className="agent-empty">
          <p>No agent CLI was found.</p>
          <p className="agent-empty-hint">
            Install one and make sure it is on your PATH, then reopen this panel.
          </p>
          <ul className="agent-empty-list">
            {PROVIDERS.map((p) => (
              <li key={p.id}>
                {p.label}: <code>{p.install}</code>
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void agentStatus().then(setStatus)}>
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <button
          type="button"
          className="agent-thread-current"
          title="Switch thread"
          onClick={() => setThreadMenu((o) => !o)}
        >
          <span className="agent-thread-title">{active?.title || NEW_TITLE}</span>
          <span className="agent-thread-caret">{threadMenu ? '▴' : '▾'}</span>
        </button>
        <button type="button" className="agent-thread-new" title="New chat" onClick={() => void createThread()}>
          +
        </button>
        {threadMenu && (
          <div className="agent-thread-menu">
            {threads.map((t) => (
              <div key={t.id} className={`agent-thread-row${t.id === activeId ? ' active' : ''}`}>
                <button type="button" className="agent-thread-pick" onClick={() => void switchThread(t.id)}>
                  {t.title || NEW_TITLE}
                </button>
                {threads.length > 1 && (
                  <button
                    type="button"
                    className="agent-thread-del"
                    title="Delete thread"
                    onClick={() => void deleteThread(t.id)}
                  >
                    {'×'}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="agent-controls">
        {installed.length > 1 && (
          <select
            className="agent-mode"
            value={provider}
            title="Agent CLI"
            onChange={(e) => {
              const next = providerById(e.target.value)
              setProvider(next.id)
              setModelChoice('')
              if (!next.modes.includes(mode)) setMode(next.modes[0] as PermissionMode)
              void restartForSetting()
            }}
          >
            {installed.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        )}
        {providerInfo.models.length > 1 && (
          <select
            className="agent-mode"
            value={modelChoice}
            title="Model"
            onChange={(e) => {
              setModelChoice(e.target.value)
              void restartForSetting()
            }}
          >
            {providerInfo.models.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        )}
        <select
          className="agent-mode"
          value={mode}
          title={modeInfo?.hint}
          onChange={(e) => setMode(e.target.value as PermissionMode)}
        >
          {modesFor(provider).map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <span className="agent-head-spacer" />
        {rules.size > 0 && (
          <button
            type="button"
            className="agent-rules"
            title={`Always allowed: ${[...rules].join(', ')}. Click to forget.`}
            onClick={() => setRules(new Set())}
          >
            {rules.size} allowed
          </button>
        )}
        {model && <span className="agent-model">{model}</span>}
      </div>

      <div className="agent-transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
        {transcript.length === 0 && (
          <div className="agent-hello">
            Ask the agent to build, refactor, or explain. It works directly in{' '}
            <b>{root.split('/').pop()}</b>. Use <b>@</b> to reference files and <b>/</b> for commands.
            <div className="agent-hello-mode">{modeInfo?.hint}.</div>
          </div>
        )}
        {transcript.map((e) => (
          <TranscriptRow key={e.id} entry={e} onDecide={decide} onOpenFile={onOpenFile} root={root} />
        ))}
        {busy && (
          <div className="agent-thinking">
            <span className="agent-thinking-dot" />
            Working
          </div>
        )}
      </div>

      <div className="agent-composer">
        {menu && menu.items.length > 0 && (
          <div className="agent-menu">
            {menu.items.map((it) => (
              <button
                key={it.value}
                type="button"
                className="agent-menu-item"
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  applyMenu(it.value)
                }}
              >
                <span className="agent-menu-label">{it.label}</span>
                {it.desc && <span className="agent-menu-desc">{it.desc}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          className="agent-input"
          value={input}
          rows={3}
          placeholder="Ask the agent... (@ for files, / for commands)"
          onChange={(e) => {
            setInput(e.target.value)
            updateMenu(e.target.value, e.target.selectionStart ?? e.target.value.length)
          }}
          onKeyDown={(e) => {
            if (menu && menu.items.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
              e.preventDefault()
              applyMenu(menu.items[0].value)
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') setMenu(null)
          }}
        />
        <div className="agent-composer-actions">
          <span className={`agent-dot ${running ? 'on' : 'off'}`} />
          <span className="agent-status-text">{running ? 'Connected' : 'Idle'}</span>
          <span className="agent-head-spacer" />
          {busy ? (
            <button type="button" className="agent-send stop" title="Stop this turn" onClick={() => void interrupt()}>
              Stop
            </button>
          ) : (
            <button type="button" className="agent-send" disabled={!input.trim()} onClick={() => void send()}>
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// One tool call, with whatever it returned folded underneath. Long output is
// clamped: a Read of a whole file would otherwise bury the conversation.
function ToolRow({ entry, onOpenFile, root }: { entry: Extract<Entry, { kind: 'tool' }>; onOpenFile: (path: string) => void; root: string }) {
  const [open, setOpen] = useState(false)
  const file = ((entry.input ?? {}) as Record<string, unknown>).file_path as string | undefined
  const result = entry.result
  const long = (result?.text.length ?? 0) > 240 || (result?.text.match(/\n/g)?.length ?? 0) > 3
  return (
    <div className={`agent-tool${result?.isError ? ' error' : ''}`}>
      <div className="agent-tool-head">
        <span className="agent-tool-name">{entry.name}</span>
        {file ? (
          <button
            type="button"
            className="agent-tool-link"
            onClick={() => onOpenFile(file.startsWith('/') ? file : `${root}/${file}`)}
          >
            {entry.summary}
          </button>
        ) : (
          <span className="agent-tool-summary">{entry.summary}</span>
        )}
        {result && <span className={`agent-tool-mark${result.isError ? ' error' : ''}`}>{result.isError ? '✗' : '✓'}</span>}
      </div>
      {result && result.text.trim() && (
        <div className={`agent-tool-result${result.isError ? ' error' : ''}${open ? ' open' : ''}`}>
          {open || !long ? result.text : result.text.slice(0, 240).trimEnd() + '…'}
          {long && (
            <button type="button" className="agent-tool-more" onClick={() => setOpen((o) => !o)}>
              {open ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// One action waiting on the user. Allow and Deny are the answer; "Always allow"
// is the same answer plus a standing rule; and a denial can carry a redirection,
// which the agent reads as the result of what it tried to do — so saying no can
// steer the work rather than only stopping it.
function PermissionCard({
  entry,
  onDecide,
}: {
  entry: Extract<Entry, { kind: 'permission' }>
  onDecide: (entry: Entry, allow: boolean, always?: boolean, reason?: string) => void
}) {
  const [reason, setReason] = useState('')
  const detail = permissionDetail(entry.tool, entry.input)
  const rule = allowRule(entry.tool, entry.input)
  return (
    <div className={`agent-permission${entry.resolved ? ' resolved' : ''}`}>
      <div className="agent-permission-body">
        <b className="agent-permission-tool">{entry.tool}</b>
        <div className="agent-permission-summary">{entry.summary}</div>
        {detail && detail !== entry.summary && <pre className="agent-permission-detail">{detail}</pre>}
      </div>
      {entry.resolved ? (
        <div className={`agent-permission-done ${entry.resolved}`}>
          {entry.resolved === 'allow' ? 'Allowed' : 'Denied'}
        </div>
      ) : (
        <>
          <input
            className="agent-permission-reason"
            value={reason}
            placeholder="Optional: what to do instead"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onDecide(entry, false, false, reason.trim())
              }
            }}
          />
          <div className="agent-permission-actions">
            <button type="button" className="agent-deny" onClick={() => onDecide(entry, false, false, reason.trim())}>
              Deny
            </button>
            <button
              type="button"
              className="agent-allow-always"
              title={`Stop asking about this for the rest of the session (${rule.key})`}
              onClick={() => onDecide(entry, true, true)}
            >
              {rule.label}
            </button>
            <button type="button" className="agent-allow" onClick={() => onDecide(entry, true)}>
              Allow
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function TranscriptRow({
  entry,
  onDecide,
  onOpenFile,
  root,
}: {
  entry: Entry
  onDecide: (entry: Entry, allow: boolean, always?: boolean, reason?: string) => void
  onOpenFile: (path: string) => void
  root: string
}) {
  switch (entry.kind) {
    case 'user':
      return <div className="agent-msg user">{entry.text}</div>
    case 'text':
      return (
        <div className="agent-msg assistant">
          <Markdown text={entry.text} />
        </div>
      )
    case 'tool':
      return <ToolRow entry={entry} onOpenFile={onOpenFile} root={root} />
    case 'tool_result':
      return (
        <div className={`agent-tool-result loose${entry.isError ? ' error' : ''}`}>
          {entry.isError ? '✗ ' : '✓ '}
          {entry.text.slice(0, 400) || (entry.isError ? 'failed' : 'done')}
        </div>
      )
    case 'result':
      return entry.error ? (
        <div className="agent-result error">
          Ended with an error.
          {entry.text && <span className="agent-result-detail"> {entry.text}</span>}
        </div>
      ) : (
        <div className="agent-result">
          Done.
          {entry.costUsd != null && <span className="agent-cost"> ${entry.costUsd.toFixed(3)}</span>}
        </div>
      )
    case 'permission':
      return <PermissionCard entry={entry} onDecide={onDecide} />

    case 'log':
      return <div className="agent-log">{entry.text}</div>
    case 'stderr':
      return <div className="agent-log stderr">{entry.text}</div>
    case 'error':
      return <div className="agent-log error">{entry.text}</div>
    case 'exit':
      return (
        <div className={`agent-log${entry.code === 0 ? '' : ' error'}`}>
          {entry.code === 0 ? 'Session ended.' : `Session ended (exit ${entry.code}).`}
        </div>
      )
    default:
      return null
  }
}
