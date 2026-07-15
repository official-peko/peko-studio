import { useEffect, useRef, useState } from 'react'
import { peko } from '@peko/client'
import { PekoMark } from '../editor/FileIcon'

// One newline-delimited progress event from `peko setup --json`.
type SetupEvent = {
  type: string
  message?: string
  component?: string
  downloaded?: number
  total?: number | null
  percent?: number | null
}

/// The first-run setup screen. Shown when the peko toolchain is missing or
/// unhealthy. It streams `peko setup --json` and reloads the shell when the
/// install finishes. When peko itself is absent it shows install instructions,
/// since the in-app installer needs the peko binary to run.
export function SetupScreen({
  pekoPresent,
  onDone,
  mode = 'setup',
  onClose,
  latest,
}: {
  pekoPresent: boolean
  onDone: () => void
  // 'setup' is the first-run install; 'update' is an in-IDE update overlay;
  // 'resetup' forces a clean re-download of the SDK/toolchains (peko setup --force).
  mode?: 'setup' | 'update' | 'resetup'
  // Dismiss handler. First-run closes the window; an overlay hides itself.
  onClose?: () => void
  latest?: string | null
}) {
  const resetup = mode === 'resetup'
  const updating = mode !== 'setup'
  const close = onClose ?? (() => peko.window.close())
  const [running, setRunning] = useState(false)
  const [installWindows, setInstallWindows] = useState(false)
  const [acceptLicense, setAcceptLicense] = useState(false)
  const [phase, setPhase] = useState('')
  const [progress, setProgress] = useState<{ component: string; percent: number } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onEvent = (raw: unknown) => {
      // The bridge delivers the event payload already parsed into an object.
      if (!raw || typeof raw !== 'object') return
      const ev = raw as SetupEvent
      if (ev.type === 'download') {
        const component = ev.component ?? 'files'
        if (typeof ev.percent === 'number') {
          setProgress({ component, percent: ev.percent })
        }
        // Keep the phase line alive during long downloads so it never sits on a
        // stale "Working..." while bytes are still moving.
        setPhase(`Downloading ${component}`)
        return
      }
      if (ev.type === 'stderr') {
        if (ev.message) {
          setLog((l) => [...l, ev.message as string])
          setPhase(ev.message as string)
        }
        return
      }
      if (ev.type === 'error') {
        if (ev.message) {
          setLog((l) => [...l, ev.message as string])
          setError(ev.message)
        }
        return
      }
      // status / info / sdk / toolchains / packages / setup / finished all
      // carry a human message describing the current phase.
      if (ev.message) {
        setPhase(ev.message)
        setLog((l) => [...l, ev.message as string])
        setProgress(null)
      }
    }
    const onFinish = (raw: unknown) => {
      const code = (raw as { code?: number } | null)?.code ?? 1
      setRunning(false)
      if (code === 0) {
        setDone(true)
        setPhase('Setup complete')
        // Reload so the shell re-checks the toolchain and boots the editor.
        window.setTimeout(() => onDone(), 800)
      } else {
        setError((e) => e ?? `Setup failed (exit code ${code}).`)
      }
    }
    const unsubEvent = peko.on('ide.setup:event', onEvent)
    const unsubDone = peko.on('ide.setup:done', onFinish)
    return () => {
      unsubEvent?.()
      unsubDone?.()
    }
  }, [onDone])

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [log])

  const start = () => {
    setError(null)
    setLog([])
    setDone(false)
    setProgress(null)
    setRunning(true)
    void peko.invoke('ide.setup.run', {
      windows: installWindows && acceptLicense,
      force: resetup,
    })
  }

  const canInstall = !running && !done && (!installWindows || acceptLicense)

  return (
    <div className="setup-shell">
      <div className="setup-drag" data-peko-drag />
      <button className="setup-close" onClick={close} aria-label="Close" title="Close">
        &times;
      </button>
      <div className="setup-card">
        <div className="setup-brand">
          <span className="setup-mark">
            <PekoMark />
          </span>
          <div>
            <h1>{resetup ? 'Re-setup the Peko SDK' : updating ? 'Update Peko' : 'Welcome to Peko Studio'}</h1>
            <p className="setup-sub">
              {resetup
                ? 'Re-download and reinstall the compiler, standard library, and platform toolchains from the latest GitHub release, even if they are already current. Use this to repair a broken or partial install.'
                : updating
                  ? `A new Peko release${latest ? ` (${latest})` : ''} is available. This updates the compiler, the standard library, and the platform toolchains; unchanged components are skipped.`
                  : pekoPresent
                    ? 'The Peko toolchain needs to be installed before you can build. This downloads the compiler, the standard library, and the platform toolchains.'
                    : 'Peko is not installed yet. This downloads the Peko CLI and the full toolchain, then sets up your environment.'}
            </p>
          </div>
        </div>

        <div className="setup-options">
              <label className="setup-check">
                <input
                  type="checkbox"
                  checked={installWindows}
                  disabled={running}
                  onChange={(e) => setInstallWindows(e.target.checked)}
                />
                <span>
                  Install the Windows cross-compile toolchain (MSVC CRT and Windows SDK, about 1 GB)
                </span>
              </label>
              {installWindows && (
                <label className="setup-check setup-license">
                  <input
                    type="checkbox"
                    checked={acceptLicense}
                    disabled={running}
                    onChange={(e) => setAcceptLicense(e.target.checked)}
                  />
                  <span>
                    I accept the{' '}
                    <a href="https://go.microsoft.com/fwlink/?LinkId=2086102" target="_blank" rel="noreferrer">
                      Microsoft license
                    </a>{' '}
                    for the Windows toolchain.
                  </span>
                </label>
              )}
            </div>

            {(running || done || error) && (
              <div className="setup-status">
                <div className="setup-phase">
                  {done ? 'Done' : error ? 'Error' : phase || 'Working...'}
                </div>
                {progress && (
                  <div className="setup-progress">
                    <div className="setup-bar">
                      <div className="setup-bar-fill" style={{ width: `${progress.percent}%` }} />
                    </div>
                    <div className="setup-progress-label">
                      {progress.component} {progress.percent}%
                    </div>
                  </div>
                )}
                <div className="setup-log" ref={logRef}>
                  {log.map((line, i) => (
                    <div key={i} className="setup-log-line">
                      {line}
                    </div>
                  ))}
                </div>
                {error && <div className="setup-error">{error}</div>}
              </div>
            )}

        <div className="setup-actions">
          <button className="setup-install" onClick={start} disabled={!canInstall}>
            {resetup
              ? running
                ? 'Re-installing...'
                : done
                  ? 'Finishing...'
                  : error
                    ? 'Retry'
                    : 'Re-setup'
              : updating
              ? running
                ? 'Updating...'
                : done
                  ? 'Finishing...'
                  : error
                    ? 'Retry'
                    : 'Update'
              : running
                ? 'Installing...'
                : done
                  ? 'Finishing...'
                  : error
                    ? 'Retry'
                    : 'Install'}
          </button>
        </div>
      </div>
    </div>
  )
}
