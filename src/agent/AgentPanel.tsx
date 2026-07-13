// The AI agent chat panel: a thin wrapper over an agent CLI (Claude Code). It
// spawns the CLI as a streaming session, renders its assistant text, tool calls,
// and results, prompts for permission when the agent asks, and offers slash
// commands and @file autocomplete in the composer. The heavy lifting (the agent
// loop, editing files, talking to the model, auth) is the CLI's; this panel just
// drives it and shows the conversation. Edits the agent makes to files show up
// live through the editor's existing file watcher.
//
// Conversations are organized into threads. One agent process runs at a time,
// for the active thread. Switching threads stops that process; the next message
// in a thread resumes its Claude session by id. Threads persist per workspace.
import { useEffect, useMemo, useRef, useState } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import {
  agentStatus,
  agentStart,
  agentStop,
  agentInput,
  agentApprove,
  onAgentEvent,
  threadsGet,
  threadsSet,
  type AgentStatus,
} from './agent'
import {
  normalize,
  userMessageLine,
  permissionResponseLine,
  type AgentItem,
  type PermissionMode,
} from './protocol'
import { installAgentPlugin } from './plugin'
import { projectSources } from '../ide/workspace'

// A transcript entry: a normalized agent item or a user message, with a stable
// id and, for permission prompts, the decision once made.
type Entry = ({ kind: 'user'; text: string } | AgentItem) & {
  id: number
  resolved?: 'allow' | 'deny'
}

// One conversation. transcript is the rendered entry list; sessionId is Claude's
// session for the thread, used to resume it after the process has stopped.
interface Thread {
  id: string
  title: string
  sessionId?: string
  createdAt: number
  transcript: Entry[]
}

const NEW_TITLE = 'New chat'
const EMPTY: Entry[] = []
// Tools that change files, auto-approved in acceptEdits mode.
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

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

// Wrapper-level slash commands offered in the composer. They drive the session,
// not the model.
const COMMANDS = [
  { name: '/clear', desc: 'Clear this thread and start fresh' },
  { name: '/new', desc: 'Start a new chat thread' },
  { name: '/stop', desc: 'Stop the current session' },
  { name: '/help', desc: 'Show what this panel can do' },
]

// Permission policy, chosen in the header (applies to the next session). In
// "ask" mode every gated action prompts inline through the approval bridge.
// acceptEdits auto-accepts file edits and prompts for the rest. bypass allows
// everything, and plan only produces a plan without acting.
const MODES: { value: PermissionMode; label: string }[] = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'acceptEdits', label: 'Auto-accept edits' },
  { value: 'bypassPermissions', label: 'Allow all' },
  { value: 'plan', label: 'Plan only' },
]

export function AgentPanel({ root, onOpenFile }: { root: string; onOpenFile: (path: string) => void }) {
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [model, setModel] = useState<string>()
  const [mode, setMode] = useState<PermissionMode>('ask')
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
  // The event handler is mounted once; this keeps the current mode reachable
  // inside it for the auto-approve policy.
  const modeRef = useRef(mode)
  useEffect(() => {
    modeRef.current = mode
  }, [mode])

  const active = threads.find((t) => t.id === activeId) ?? null
  const transcript = active?.transcript ?? EMPTY

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

  // Stream agent events into the active thread. Text arrives token by token via
  // stream_start/stream_text/stream_end into one growing entry; the whole-message
  // 'text' echo is dropped to avoid duplication. The session id is captured for
  // resuming the thread later.
  useEffect(() => {
    const off = onAgentEvent((raw) => {
      for (const item of normalize(raw)) {
        switch (item.kind) {
          case 'system':
            if (item.model) setModel(item.model)
            if (item.sessionId) {
              const sid = item.sessionId
              setThreads((prev) => prev.map((t) => (t.id === activeIdRef.current ? { ...t, sessionId: sid } : t)))
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
            break
          case 'permission': {
            // In acceptEdits mode the panel approves edit tools without asking
            // and still prompts for everything else.
            const isEdit = EDIT_TOOLS.includes(item.tool)
            if (modeRef.current === 'acceptEdits' && isEdit && item.approvalId) {
              const id = nextId()
              patchTranscript((prev) => [...prev, { ...item, id, resolved: 'allow' } as Entry])
              void agentApprove(item.approvalId, true)
            } else {
              append(item)
            }
            break
          }
          case 'result':
            setBusy(false)
            append(item)
            break
          case 'exit':
            setRunning(false)
            setBusy(false)
            append(item)
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

  // Stop the running session and clear per-session UI state.
  const stopSession = async () => {
    await agentStop()
    setRunning(false)
    setBusy(false)
    streamingId.current = null
    setModel(undefined)
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
      append({ kind: 'log', text: 'Session stopped.' })
      return
    }
    if (text === '/help') {
      setInput('')
      append({
        kind: 'log',
        text: 'Type a request and the agent works in this project. Reference files with @, switch or start threads at the top, drive the session with /clear, /new, /stop. Approve or deny file edits and commands inline.',
      })
      return
    }
    if (!running) {
      const ok = await agentStart(mode, active?.sessionId ?? '')
      setRunning(ok)
      if (!ok) {
        append({ kind: 'error', text: 'Could not start the agent.' })
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
    await agentInput(userMessageLine(text))
  }

  const decide = async (entryId: number, requestId: string, allow: boolean, approvalId?: string) => {
    // Approval-bridge decisions go to the file relay; control-protocol requests
    // go back on the agent's stdin.
    if (approvalId) await agentApprove(approvalId, allow)
    else await agentInput(permissionResponseLine(requestId, allow))
    patchTranscript((prev) => prev.map((e) => (e.id === entryId ? { ...e, resolved: allow ? 'allow' : 'deny' } : e)))
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

  const modeLabel = useMemo(() => MODES.find((m) => m.value === mode)?.label, [mode])

  if (status && !status.available) {
    return (
      <div className="agent-panel">
        <div className="agent-empty">
          <p>Claude Code was not found.</p>
          <p className="agent-empty-hint">
            Install it and make sure <code>claude</code> is on your PATH, then reopen this panel.
          </p>
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
        <span className="agent-title">Assistant</span>
        {model && <span className="agent-model">{model}</span>}
        <span className="agent-head-spacer" />
        <select
          className="agent-mode"
          value={mode}
          title="Permission mode (applies to the next session)"
          onChange={(e) => setMode(e.target.value as PermissionMode)}
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div className="agent-threadbar">
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

      <div className="agent-transcript" ref={scrollRef} onScroll={onTranscriptScroll}>
        {transcript.length === 0 && (
          <div className="agent-hello">
            Ask the assistant to build, refactor, or explain. It works directly in{' '}
            {root.split('/').pop()}. Use <b>@</b> to reference files. Permission mode: <b>{modeLabel}</b>.
          </div>
        )}
        {transcript.map((e) => (
          <TranscriptRow key={e.id} entry={e} onDecide={decide} onOpenFile={onOpenFile} root={root} />
        ))}
        {busy && <div className="agent-thinking">Working...</div>}
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
          placeholder="Ask the assistant... (@ for files, / for commands)"
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
            <button type="button" className="agent-send stop" onClick={() => void stopSession()}>
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

function TranscriptRow({
  entry,
  onDecide,
  onOpenFile,
  root,
}: {
  entry: Entry
  onDecide: (entryId: number, requestId: string, allow: boolean, approvalId?: string) => void
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
    case 'tool': {
      const file = ((entry.input ?? {}) as Record<string, unknown>).file_path as string | undefined
      return (
        <div className="agent-tool">
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
        </div>
      )
    }
    case 'tool_result':
      return (
        <div className={`agent-tool-result${entry.isError ? ' error' : ''}`}>
          {entry.isError ? '✗ ' : '✓ '}
          {entry.text.slice(0, 400) || (entry.isError ? 'failed' : 'done')}
        </div>
      )
    case 'result':
      return (
        <div className="agent-result">
          {entry.error ? 'Ended with an error.' : 'Done.'}
          {entry.costUsd != null && <span className="agent-cost"> ${entry.costUsd.toFixed(3)}</span>}
        </div>
      )
    case 'permission': {
      const detail = permissionDetail(entry.tool, entry.input)
      return (
        <div className="agent-permission">
          <div className="agent-permission-body">
            <b>Permission requested</b>
            <div className="agent-permission-summary">{entry.summary}</div>
            {detail && <pre className="agent-permission-detail">{detail}</pre>}
          </div>
          {entry.resolved ? (
            <div className={`agent-permission-done ${entry.resolved}`}>
              {entry.resolved === 'allow' ? 'Allowed' : 'Denied'}
            </div>
          ) : (
            <div className="agent-permission-actions">
              <button
                type="button"
                className="agent-deny"
                onClick={() => onDecide(entry.id, entry.requestId, false, entry.approvalId)}
              >
                Deny
              </button>
              <button
                type="button"
                className="agent-allow"
                onClick={() => onDecide(entry.id, entry.requestId, true, entry.approvalId)}
              >
                Allow
              </button>
            </div>
          )}
        </div>
      )
    }
    case 'log':
      return <div className="agent-log">{entry.text}</div>
    case 'stderr':
      return <div className="agent-log stderr">{entry.text}</div>
    case 'error':
      return <div className="agent-log error">{entry.text}</div>
    case 'exit':
      return <div className="agent-log">Session ended (exit {entry.code}).</div>
    default:
      return null
  }
}
