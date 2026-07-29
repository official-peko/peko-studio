import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { peko } from '@peko/client'
import { Highlight } from './highlight'
import { DeployView } from './DeployPanel'
import { SigningView } from './SigningPanel'
import { PLATFORM_LABEL, needsAttention } from './signingShared'
import type {
  ConsoleLine,
  Diagnostic,
  LogLine,
  PageInfo,
  PageResource,
  PanelTab,
  PlatformSigning,
  ResourceBody,
  RunState,
  TraceEntry,
} from './types'

/// Pretty-print a JSON body for the bridge and page views, leaving anything
/// that is not JSON untouched.
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

// A monotonic id source for streamed lines (stable React keys).
let nextId = 1

/// The build/run panel: a run bar (build/run/stop, target, release) over a tab
/// strip (Problems, Output, Console, Bridge, Signing). It drives the native
/// layer over the bridge (ide.build / ide.run.* / ide.signing.*) and renders
/// the streamed events. The native handlers are added alongside the dev-loop
/// port; until then the controls issue their calls and the views stay empty.
export function BuildRunPanel({
  platforms,
  hostPlatform,
  collapsed,
  root,
  diagnostics,
  onOpenFile,
}: {
  platforms: string[]
  hostPlatform: string
  collapsed: boolean
  // The project root, to resolve relative paths in build output.
  root?: string
  // The current project-wide diagnostics from the language server.
  diagnostics: Diagnostic[]
  onOpenFile: (path: string, line: number, column: number) => void
}) {
  const [tab, setTab] = useState<PanelTab>('problems')
  // Deploy output and outcome live here, not in DeployView: a deploy runs for
  // minutes and switching tabs must not discard its log.
  const [deployOutput, setDeployOutput] = useState<LogLine[]>([])
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{
    ok: boolean
    kind?: string
    state?: string
    url?: string | null
    error?: string
  } | null>(null)
  const [runState, setRunState] = useState<RunState>('idle')
  const [target, setTarget] = useState(
    () => (platforms.includes(hostPlatform) ? hostPlatform : platforms[0]) ?? hostPlatform,
  )
  const [release, setRelease] = useState(false)

  const [output, setOutput] = useState<LogLine[]>([])
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([])
  const [history, setHistory] = useState<string[]>([])
  const [completions, setCompletions] = useState<{ base: string; names: string[] }>({
    base: '',
    names: [],
  })
  const [traces, setTraces] = useState<TraceEntry[]>([])
  const [bridgeState, setBridgeState] = useState<string>('')
  const [signing, setSigning] = useState<PlatformSigning[]>([])
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null)
  const [route, setRoute] = useState<string>('')
  const [resource, setResource] = useState<ResourceBody | null>(null)

  // Keep the target valid as the manifest platforms load in.
  useEffect(() => {
    if (platforms.length && !platforms.includes(target)) {
      setTarget(platforms.includes(hostPlatform) ? hostPlatform : platforms[0])
    }
  }, [platforms, hostPlatform, target])

  const appendOutput = (stream: LogLine['stream'], text: string) =>
    setOutput((prev) => [...prev.slice(-4000), { id: nextId++, stream, text }])

  // Subscribe to the native layer's build/run event streams. Each event is
  // dispatched by its `t` tag into the matching view.
  useEffect(() => {
    const handle = (raw: unknown) => {
      const e = raw as { t?: string; [k: string]: unknown }
      switch (e.t) {
        case 'status':
          if (typeof e.state === 'string') setRunState(e.state as RunState)
          if (e.state === 'idle') setBridgeState('')
          if (typeof e.text === 'string') appendOutput('stdout', String(e.text))
          break
        case 'output': {
          const line = String(e.text ?? '')
          // The app tags its bridge lifecycle lines; surface the latest as the
          // Bridge tab's health so a mint/connect failure is visible there, not
          // just buried in the output log.
          const marker = line.indexOf('[peko-bridge]')
          if (marker !== -1) setBridgeState(line.slice(marker + '[peko-bridge]'.length).trim())
          appendOutput((e.stream as LogLine['stream']) ?? 'stdout', line)
          break
        }
        case 'console': {
          const level = (e.level as ConsoleLine['level']) ?? 'log'
          const text = String(e.text ?? '')
          // A bare `undefined` return value (e.g. from a console.log statement)
          // is noise; drop it. Real values and errors still show.
          if (level === 'result' && text.trim() === 'undefined') break
          setConsoleLines((prev) => [...prev.slice(-4000), { id: nextId++, level, text }])
          break
        }
        case 'trace':
          setTraces((prev) => [
            ...prev.slice(-2000),
            {
              id: nextId++,
              dir: (e.dir as TraceEntry['dir']) ?? 'event',
              label: String(e.label ?? ''),
              data: String(e.data ?? ''),
            },
          ])
          break
        case 'complete':
          setCompletions({
            base: String(e.base ?? ''),
            names: Array.isArray(e.names) ? (e.names as string[]) : [],
          })
          break
        case 'route':
          if (typeof e.path === 'string') setRoute(e.path)
          break
        case 'page':
          if (e.info && typeof e.info === 'object') setPageInfo(e.info as PageInfo)
          break
        case 'resource':
          if (e.resource && typeof e.resource === 'object') setResource(e.resource as ResourceBody)
          break
        default:
          break
      }
    }
    // The deploy stream is handled separately: its lines belong to the Deploy
    // tab's own log, and the CLI's `result` event carries the outcome the panel
    // reports rather than the panel inferring it from the last line.
    const handleDeploy = (raw: unknown) => {
      const e = raw as { t?: string; [k: string]: unknown }
      if (e.t === 'status') {
        if (e.state === 'deploying') setDeploying(true)
        if (e.state === 'idle') setDeploying(false)
        return
      }
      if (e.t !== 'output') return
      const text = String(e.text ?? '')
      const stream = (e.stream as LogLine['stream']) ?? 'stdout'
      // The CLI emits one JSON object per line on stdout in --json mode. Events
      // become log text; the terminal `result` sets the outcome. Anything that
      // is not JSON is a tool writing directly to the stream, shown as-is.
      let shown = text
      try {
        const event = JSON.parse(text) as Record<string, unknown>
        if (event.type === 'result') {
          setDeployResult(event as never)
          setDeploying(false)
          return
        }
        shown =
          typeof event.message === 'string'
            ? `${String(event.type ?? 'info')}: ${event.message}`
            : text
      } catch {
        // Not JSON — raw tool output.
      }
      setDeployOutput((prev) => [...prev.slice(-4000), { id: nextId++, stream, text: shown }])
    }

    const unsubDeploy = peko.on('ide.deploy:event', handleDeploy)
    const unsubRun = peko.on('ide.run:event', handle)
    const unsubBuild = peko.on('ide.build:event', handle)
    return () => {
      unsubRun?.()
      unsubBuild?.()
      unsubDeploy?.()
    }
  }, [])

  const invokeSafe = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<boolean> => {
    try {
      await peko.invoke(method, params)
      return true
    } catch (err) {
      appendOutput('stderr', `${method} failed (${String(err)})`)
      return false
    }
  }

  const doBuild = async () => {
    setTab('output')
    setRunState('building')
    appendOutput('stdout', `Building ${PLATFORM_LABEL[target] ?? target}${release ? ' (release)' : ''}...`)
    // Reset the bar if the build could not even be started; otherwise the
    // streamed status events (building -> idle) drive it.
    const ok = await invokeSafe('ide.build', { platform: target, mode: release ? 'release' : 'debug' })
    if (!ok) setRunState('idle')
  }
  const doRun = async () => {
    setTab('output')
    setRunState('running')
    appendOutput('stdout', `Running dev loop${release ? ' (release)' : ''}...`)
    const ok = await invokeSafe('ide.run.start', { mode: release ? 'release' : 'debug' })
    if (!ok) setRunState('idle')
  }
  const doRestart = () => {
    appendOutput('stdout', 'Restarting the app window...')
    void invokeSafe('ide.run.restart', {})
  }
  const doStop = () => {
    setRunState('stopping')
    void invokeSafe('ide.run.stop', {})
  }

  const errorCount = useMemo(
    () => diagnostics.filter((d) => d.severity === 'error').length,
    [diagnostics],
  )
  const warnCount = useMemo(
    () => diagnostics.filter((d) => d.severity === 'warning').length,
    [diagnostics],
  )

  if (collapsed) return null

  const isRunning = runState === 'running' || runState === 'stopping'
  const isBusy = runState === 'building' || runState === 'stopping'

  return (
    <div className="brpanel">
      <div className="brpanel-runbar">
        <div className="brpanel-actions">
          <button className="br-btn primary" disabled={isBusy || isRunning} onClick={doBuild}>
            {runState === 'building' ? 'Building...' : 'Build'}
          </button>
          {isRunning ? (
            <button className="br-btn" disabled={runState === 'stopping'} onClick={doRestart}>
              Restart
            </button>
          ) : (
            <button className="br-btn run" disabled={isBusy} onClick={doRun}>
              Run
            </button>
          )}
          <button className="br-btn" disabled={!isRunning || runState === 'stopping'} onClick={doStop}>
            Stop
          </button>
        </div>

        <div className="brpanel-config">
          <label className="br-field">
            <span className="br-field-label">Target</span>
            <select
              className="br-select"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              {(platforms.length ? platforms : [hostPlatform]).map((p) => (
                <option key={p} value={p}>
                  {PLATFORM_LABEL[p] ?? p}
                </option>
              ))}
            </select>
          </label>
          <label className="br-check">
            <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
            <span>release</span>
          </label>
        </div>

        <button
          className="br-btn subtle"
          title="Wipe the incremental build cache"
          disabled={isBusy || isRunning}
          onClick={() => {
            setTab('output')
            appendOutput('stdout', 'Cleaning incremental build cache...')
            void invokeSafe('ide.clean', {})
          }}
        >
          Clean
        </button>
        <button
          className="br-btn subtle"
          title="Open the build output folder"
          onClick={() =>
            void invokeSafe('ide.open_build_folder', { mode: release ? 'release' : 'debug' })
          }
        >
          Open build folder
        </button>

        <div className="brpanel-state">
          <span className={`br-dot ${runState}`} />
          <span className="br-state-text">{runState}</span>
        </div>
      </div>

      <div className="brpanel-tabs" role="tablist">
        <PanelTabButton id="problems" tab={tab} onSelect={setTab} badge={errorCount + warnCount || undefined}>
          Problems
        </PanelTabButton>
        <PanelTabButton id="output" tab={tab} onSelect={setTab}>
          Output
        </PanelTabButton>
        <PanelTabButton id="console" tab={tab} onSelect={setTab}>
          Console
        </PanelTabButton>
        <PanelTabButton id="bridge" tab={tab} onSelect={setTab} badge={traces.length || undefined}>
          Bridge
        </PanelTabButton>
        <PanelTabButton id="page" tab={tab} onSelect={setTab}>
          Page
        </PanelTabButton>
        <PanelTabButton
          id="signing"
          tab={tab}
          onSelect={setTab}
          // A count of platforms that cannot ship without keys and do not have
          // them, so the strip says there is something to fix without opening
          // the tab. Optional and unsigned platforms are excluded: they are a
          // choice, not a problem.
          badge={signing.filter((s) => needsAttention(s.state)).length || undefined}
        >
          Signing
        </PanelTabButton>
        <PanelTabButton id="deploy" tab={tab} onSelect={setTab}>
          Deploy
        </PanelTabButton>
      </div>

      <div className="brpanel-body">
        {tab === 'deploy' && (
          <DeployView
            platforms={platforms}
            output={deployOutput}
            deploying={deploying}
            result={deployResult}
            onClear={() => {
              setDeployOutput([])
              setDeployResult(null)
            }}
            onStart={(kind) => {
              setDeployOutput([])
              setDeployResult(null)
              setDeploying(true)
              setTab('deploy')
              void invokeSafe('ide.deploy.start', { kind })
            }}
            onStop={() => void invokeSafe('ide.deploy.stop', {})}
          />
        )}
        {tab === 'problems' && <ProblemsView diagnostics={diagnostics} onOpenFile={onOpenFile} />}
        {tab === 'output' && (
          <OutputView lines={output} root={root} onOpenFile={onOpenFile} onClear={() => setOutput([])} />
        )}
        {tab === 'console' && (
          <ConsoleView
            lines={consoleLines}
            history={history}
            completions={completions}
            onClear={() => setConsoleLines([])}
            onEval={(code) => {
              setHistory((h) => [...h.slice(-300), code])
              void invokeSafe('ide.run.eval', { code })
            }}
            onComplete={(base) => void invokeSafe('ide.run.complete', { code: base })}
          />
        )}
        {tab === 'bridge' && (
          <BridgeView traces={traces} status={bridgeState} onClear={() => setTraces([])} />
        )}
        {tab === 'page' && (
          <PageView
            info={pageInfo}
            route={route}
            running={isRunning}
            resource={resource}
            refresh={() => void invokeSafe('ide.run.page', {})}
            navigate={(to) => {
              // Route pekoui apps (via the navigate event) and react-router apps
              // (via history + popstate) alike.
              const js = JSON.stringify(to)
              void invokeSafe('ide.run.eval', {
                code: `(function(t){try{history.pushState({},'',t)}catch(e){}try{if(window.__peko_deeplink)window.__peko_deeplink(t)}catch(e){}try{dispatchEvent(new PopStateEvent('popstate'))}catch(e){}})(${js})`,
              })
            }}
            reload={() => void invokeSafe('ide.run.eval', { code: 'location.reload()' })}
            loadResource={(url) => {
              setResource(null)
              void invokeSafe('ide.run.resource', { url })
            }}
          />
        )}
        {tab === 'signing' && (
          <SigningView
            platforms={platforms}
            signing={signing}
            refresh={async () => {
              try {
                // force: the host caches the verification, and a `peko keys`
                // run in a terminal leaves that cache looking valid.
                const res = (await peko.invoke('ide.signing.status', {
                  force: 'true',
                })) as { reports?: PlatformSigning[] }
                setSigning(res.reports ?? [])
              } catch {
                setSigning([])
              }
            }}
          />
        )}
      </div>
    </div>
  )
}

function PanelTabButton({
  id,
  tab,
  onSelect,
  badge,
  children,
}: {
  id: PanelTab
  tab: PanelTab
  onSelect: (t: PanelTab) => void
  badge?: number
  children: React.ReactNode
}) {
  return (
    <button
      role="tab"
      className={`brpanel-tab ${tab === id ? 'active' : ''}`}
      onClick={() => onSelect(id)}
    >
      {children}
      {badge !== undefined && <span className="brpanel-badge">{badge}</span>}
    </button>
  )
}

function ProblemsView({
  diagnostics,
  onOpenFile,
}: {
  diagnostics: Diagnostic[]
  onOpenFile: (path: string, line: number, column: number) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number; d: Diagnostic } | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {})

  if (diagnostics.length === 0) {
    return <div className="brpanel-empty">No problems have been detected.</div>
  }
  return (
    <div className="problems-list">
      {diagnostics.map((d, i) => (
        <button
          key={`${d.file}:${d.line}:${d.column}:${i}`}
          className={`problem-row ${d.severity}`}
          onClick={() => onOpenFile(d.file, d.line, d.column)}
          onContextMenu={(e) => {
            e.preventDefault()
            setMenu({ x: e.clientX, y: e.clientY, d })
          }}
        >
          <span className={`problem-icon ${d.severity}`} />
          <span className="problem-msg">{d.message}</span>
          <span className="problem-loc">
            {d.file.split('/').pop()}:{d.line}:{d.column}
          </span>
        </button>
      ))}

      {menu &&
        createPortal(
          <div
            className="ctx-menu"
            style={{ left: menu.x, top: menu.y }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                onOpenFile(menu.d.file, menu.d.line, menu.d.column)
                setMenu(null)
              }}
            >
              Go to Problem
            </button>
            <div className="ctx-sep" />
            <button className="ctx-item" onClick={() => { copy(menu.d.message); setMenu(null) }}>
              Copy Message
            </button>
            <button
              className="ctx-item"
              onClick={() => { copy(`${menu.d.file}:${menu.d.line}:${menu.d.column}`); setMenu(null) }}
            >
              Copy Location
            </button>
            <button className="ctx-item" onClick={() => { copy(menu.d.file); setMenu(null) }}>
              Copy File Path
            </button>
            <div className="ctx-sep" />
            <button
              className="ctx-item"
              onClick={() => {
                copy(`${menu.d.severity}: ${menu.d.message} (${menu.d.file}:${menu.d.line}:${menu.d.column})`)
                setMenu(null)
              }}
            >
              Copy Full Diagnostic
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

// Matches a source location in build output: a path ending in a known source
// extension, then :line and an optional :column.
const LOCATION_RE =
  /((?:[~./]?[\w+-]+\/)*[\w+.-]+\.(?:peko|c|m|mm|h|ts|tsx|js|jsx|rs)):(\d+)(?::(\d+))?/g

// Resolve a matched path to an absolute one openable in the editor.
function resolveOutputPath(path: string, root?: string): string | null {
  if (path.startsWith('/')) return path
  if (path.startsWith('~')) return null
  if (!root) return null
  return `${root}/${path.replace(/^\.\//, '')}`
}

// Split an output line into text and clickable source-location links.
function renderOutputLine(
  text: string,
  root: string | undefined,
  onOpenFile: (path: string, line: number, column: number) => void,
): ReactNode {
  const parts: ReactNode[] = []
  let last = 0
  let key = 0
  LOCATION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LOCATION_RE.exec(text)) !== null) {
    const [full, path, lineStr, colStr] = match
    const abs = resolveOutputPath(path, root)
    if (!abs) continue
    if (match.index > last) parts.push(text.slice(last, match.index))
    const line = Number(lineStr)
    const column = colStr ? Number(colStr) : 1
    parts.push(
      <span
        key={key++}
        className="log-loc"
        onClick={() => onOpenFile(abs, line, column)}
        title={`Open ${abs}:${line}`}
      >
        {full}
      </span>,
    )
    last = match.index + full.length
  }
  if (parts.length === 0) return text
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function OutputView({
  lines,
  root,
  onOpenFile,
  onClear,
}: {
  lines: LogLine[]
  root?: string
  onOpenFile: (path: string, line: number, column: number) => void
  onClear: () => void
}) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView()
  }, [lines])
  return (
    <div className="log-view">
      <div className="log-toolbar">
        <button className="log-clear" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="log-scroll">
        {lines.map((l) => (
          <div key={l.id} className={`log-line ${l.stream}`}>
            {renderOutputLine(l.text, root, onOpenFile)}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  )
}

// Split a console input into the part before the completion point (head), the
// base expression to evaluate for property names, and the partial identifier
// being typed (prefix). `foo.bar.ba` -> {head:"foo.bar.", base:"foo.bar",
// prefix:"ba"}; a bare `doc` -> {head:"", base:"", prefix:"doc"} (globals).
function splitCompletion(input: string): { head: string; base: string; prefix: string } {
  const dot = /^(.*\.)([A-Za-z_$][\w$]*)?$/.exec(input)
  if (dot) {
    const head = dot[1]
    return { head, base: head.slice(0, -1), prefix: dot[2] ?? '' }
  }
  const id = /[A-Za-z_$][\w$]*$/.exec(input)
  const prefix = id ? id[0] : ''
  return { head: input.slice(0, input.length - prefix.length), base: '', prefix }
}

function ConsoleView({
  lines,
  history,
  completions,
  onClear,
  onEval,
  onComplete,
}: {
  lines: ConsoleLine[]
  history: string[]
  completions: { base: string; names: string[] }
  onClear: () => void
  onEval: (code: string) => void
  onComplete: (base: string) => void
}) {
  const [input, setInput] = useState('')
  // Index into history while navigating with the arrow keys; -1 means editing a
  // fresh line.
  const [histIdx, setHistIdx] = useState(-1)
  const [sel, setSel] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const requestedBase = useRef<string | null>(null)
  useEffect(() => {
    endRef.current?.scrollIntoView()
  }, [lines])

  const { head, base, prefix } = splitCompletion(input)
  // Ask the page for names on this base when it changes (not on every
  // keystroke, since the prefix filters client-side).
  useEffect(() => {
    if (input.length === 0) {
      requestedBase.current = null
      return
    }
    if (requestedBase.current !== base) {
      requestedBase.current = base
      onComplete(base)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, input.length])

  const matches =
    dismissed || input.length === 0 || completions.base !== base
      ? []
      : completions.names.filter((n) => n.startsWith(prefix) && n !== prefix).slice(0, 500)
  const open = matches.length > 0
  const selected = Math.min(sel, matches.length - 1)

  const accept = (name: string) => {
    setInput(head + name)
    setDismissed(true)
    requestedBase.current = null
  }
  const submit = () => {
    const code = normalizeQuotes(input.trim())
    if (!code) return
    onEval(code)
    setInput('')
    setHistIdx(-1)
    setDismissed(true)
  }
  const recall = (dir: -1 | 1) => {
    if (history.length === 0) return
    // -1 goes older (up), +1 goes newer (down).
    let idx = histIdx === -1 ? history.length : histIdx
    idx += dir
    if (idx >= history.length) {
      setHistIdx(-1)
      setInput('')
      return
    }
    if (idx < 0) idx = 0
    setHistIdx(idx)
    setInput(history[idx])
    setDismissed(true)
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSel((s) => (s + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSel((s) => (s - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        accept(matches[selected] ?? matches[0])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(true)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
        return
      }
    } else {
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        recall(-1)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        recall(1)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
        return
      }
    }
  }

  return (
    <div className="log-view">
      <div className="log-toolbar">
        <button className="log-clear" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="log-scroll">
        {lines.map((l) => (
          <div key={l.id} className={`console-line ${l.level}`}>
            <Highlight code={l.text} pretty />
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="console-input">
        <span className="console-prompt">›</span>
        <div className="console-editor">
          <pre className="console-hl-layer" aria-hidden="true">
            <Highlight code={input} />
          </pre>
          <input
            value={input}
            placeholder="evaluate JavaScript in the running app"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => {
              setInput(e.target.value)
              setHistIdx(-1)
              setSel(0)
              setDismissed(false)
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        {open && (
          <ul className="console-complete">
            {matches.map((name, i) => (
              <li
                key={name}
                className={i === selected ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault()
                  accept(name)
                }}
              >
                {name}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="page-meta-row">
      <span className="page-meta-k">{label}</span>
      <span className="page-meta-v" title={value}>
        {value}
      </span>
    </div>
  )
}

const RES_ORDER: PageResource['type'][] = ['document', 'script', 'style', 'image', 'json', 'font', 'other']

function langForResource(url: string, mime: string): 'js' | 'css' | 'html' | 'json' | 'text' {
  const u = url.split('?')[0].toLowerCase()
  if (/\.(css|scss|sass|less)$/.test(u) || mime.includes('css')) return 'css'
  if (/\.(html?|xml|svg)$/.test(u) || mime.includes('html')) return 'html'
  if (/\.json$/.test(u) || mime.includes('json')) return 'json'
  if (/\.(m?jsx?|tsx?)$/.test(u) || mime.includes('javascript')) return 'js'
  return 'text'
}

function PageView({
  info,
  route,
  running,
  resource,
  refresh,
  navigate,
  reload,
  loadResource,
}: {
  info: PageInfo | null
  route: string
  running: boolean
  resource: ResourceBody | null
  refresh: () => void
  navigate: (to: string) => void
  reload: () => void
  loadResource: (url: string) => void
}) {
  const [dest, setDest] = useState(route || '/')
  const [selected, setSelected] = useState<PageResource | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set(['font', 'other']))
  const fetched = useRef(false)
  useEffect(() => {
    if (running && !fetched.current) {
      fetched.current = true
      refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])
  useEffect(() => {
    if (route) setDest(route)
  }, [route])

  if (!running) {
    return <div className="brpanel-empty">Run the app to inspect the page.</div>
  }
  const go = () => {
    navigate(dest)
    window.setTimeout(refresh, 200)
  }
  const openResource = (r: PageResource) => {
    setSelected(r)
    if (r.type === 'document' && info) return // shown from the snapshot html
    if (r.type !== 'image') loadResource(r.url)
  }

  const resources = info?.resources ?? []
  const grouped = new Map<string, PageResource[]>()
  for (const r of resources) {
    const arr = grouped.get(r.type) ?? []
    arr.push(r)
    grouped.set(r.type, arr)
  }
  const shortName = (url: string) => {
    try {
      const u = new URL(url)
      return (u.pathname.split('/').filter(Boolean).pop() || u.host) + (u.search ? u.search.slice(0, 20) : '')
    } catch {
      return url.split('/').pop() || url
    }
  }

  return (
    <div className="page-view">
      <div className="page-nav">
        <span className="console-prompt">↦</span>
        <input
          className="page-route-input"
          value={dest}
          placeholder="/route"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={(e) => setDest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
        <button className="br-btn" onClick={go}>Go</button>
        <button className="br-btn" onClick={() => { reload(); window.setTimeout(refresh, 400) }}>Reload</button>
        <button className="br-btn" onClick={refresh}>Refresh</button>
      </div>

      {info && (
        <div className="page-meta">
          <MetaRow label="Route" value={info.route || '/'} />
          <MetaRow label="Title" value={info.title || '(untitled)'} />
          <MetaRow label="Ready" value={info.readyState} />
          <MetaRow label="Viewport" value={`${info.width} x ${info.height}`} />
          <MetaRow label="Elements" value={String(info.elements)} />
          <MetaRow label="Resources" value={String(resources.length)} />
        </div>
      )}

      <div className="page-sources">
        <div className="page-reslist">
          {RES_ORDER.filter((t) => grouped.has(t)).map((type) => {
            const items = grouped.get(type)!
            const folded = collapsed.has(type)
            return (
              <div key={type} className="page-resgroup">
                <div
                  className="page-restype"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev)
                      if (next.has(type)) next.delete(type)
                      else next.add(type)
                      return next
                    })
                  }
                >
                  <span className="search-fold">{folded ? '▸' : '▾'}</span>
                  {type} <span className="page-restype-count">{items.length}</span>
                </div>
                {!folded &&
                  items.map((r) => (
                    <div
                      key={r.url}
                      className={`page-res ${selected?.url === r.url ? 'active' : ''}`}
                      title={r.url}
                      onClick={() => openResource(r)}
                    >
                      {shortName(r.url)}
                    </div>
                  ))}
              </div>
            )
          })}
        </div>
        <div className="page-resview">
          {!selected && <div className="brpanel-empty">Select a resource to view its source.</div>}
          {selected && selected.type === 'image' && (
            <div className="page-image">
              <img src={selected.url} alt={shortName(selected.url)} />
              <div className="page-image-url">{shortName(selected.url)}</div>
            </div>
          )}
          {selected && selected.type === 'document' && info && (
            <pre className="page-source">
              <Highlight code={info.html} lang="html" pretty />
            </pre>
          )}
          {selected && selected.type !== 'image' && selected.type !== 'document' && (
            resource && resource.url === selected.url ? (
              resource.error ? (
                <div className="brpanel-empty">Could not load: {resource.error}</div>
              ) : (
                <pre className="page-source">
                  <Highlight code={resource.text} lang={langForResource(selected.url, resource.mime)} pretty />
                </pre>
              )
            ) : (
              <div className="brpanel-empty">Loading {shortName(selected.url)}...</div>
            )
          )}
        </div>
      </div>
    </div>
  )
}

function BridgeView({
  traces,
  status,
  onClear,
}: {
  traces: TraceEntry[]
  status: string
  onClear: () => void
}) {
  // The bridge's live health, from the app's [peko-bridge] lifecycle lines.
  const health = status ? <div className="trace-status">bridge: {status}</div> : null
  if (traces.length === 0) {
    return (
      <div className="log-view">
        {health}
        <div className="brpanel-empty">
          No bridge traffic yet. Use the running app to see its native calls.
        </div>
      </div>
    )
  }
  return (
    <div className="log-view">
      {health}
      <div className="log-toolbar">
        <button className="log-clear" onClick={onClear}>
          Clear
        </button>
      </div>
      <div className="log-scroll">
        {traces.map((t) => (
          <details key={t.id} className={`trace-row ${t.dir}`}>
            <summary>
              <span className={`trace-dir ${t.dir}`}>{t.dir}</span>
              <span className="trace-label">{t.label}</span>
            </summary>
            <pre className="trace-data">{prettyJson(t.data)}</pre>
          </details>
        ))}
      </div>
    </div>
  )
}

// macOS text substitution turns straight quotes typed into a web input into
// curly quotes, which are a syntax error in JavaScript. Fold the curly forms
// back to straight quotes before evaluating.
function normalizeQuotes(text: string): string {
  return text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")
}

// The platforms whose applications are code-signed. Others (Linux) declare no
// signing material.
