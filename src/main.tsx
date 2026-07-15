import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { peko } from '@peko/client'
import './index.css'
import App from './App'
import { Launcher } from './ide/Launcher'
import { SetupScreen } from './setup/SetupScreen'
import { SetupWindow } from './setup/SetupWindow'

type WindowKind =
  | { kind: 'launcher' }
  | { kind: 'editor' }
  | { kind: 'setup'; view: string }

// The window kind comes from the native side (ide.entry): a Setup window is a
// fresh app instance spawned with PEKO_IDE_SETUP, like the launcher is spawned
// with no project. A Setup window renders immediately — it exists to install or
// repair the toolchain, so it is not gated on a healthy install. The launcher
// and editor are gated: an unhealthy or missing install shows the first-run
// setup screen ahead of them. A /launcher pop-up skips the check outright.
function Root() {
  const routeLauncher = window.location.pathname.replace(/\/+$/, '') === '/launcher'
  const [win, setWin] = useState<WindowKind | null>(routeLauncher ? { kind: 'launcher' } : null)
  const [toolchain, setToolchain] = useState<{ needed: boolean; pekoPresent: boolean } | null>(
    routeLauncher ? { needed: false, pekoPresent: true } : null,
  )

  // Resolve which kind of window this is.
  useEffect(() => {
    if (routeLauncher) return
    let cancelled = false
    void (async () => {
      try {
        const entry = (await peko.invoke('ide.entry', {})) as { launcher?: boolean; setup?: string }
        if (cancelled) return
        if (typeof entry.setup === 'string') setWin({ kind: 'setup', view: entry.setup })
        else setWin({ kind: entry.launcher ? 'launcher' : 'editor' })
      } catch {
        if (!cancelled) setWin({ kind: 'editor' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [routeLauncher])

  // Gate the launcher/editor on a healthy toolchain (a Setup window skips this).
  useEffect(() => {
    if (routeLauncher || !win || win.kind === 'setup') return
    let cancelled = false
    void (async () => {
      try {
        const status = (await peko.invoke('ide.setup.status', {})) as {
          healthy?: boolean
          pekoPresent?: boolean
        }
        if (cancelled) return
        setToolchain({ needed: !status.healthy, pekoPresent: status.pekoPresent !== false })
      } catch {
        if (!cancelled) setToolchain({ needed: false, pekoPresent: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [routeLauncher, win])

  if (win?.kind === 'setup') return <SetupWindow initialView={win.view} />
  if (toolchain?.needed) {
    return <SetupScreen pekoPresent={toolchain.pekoPresent} onDone={() => window.location.reload()} />
  }
  if (!win || !toolchain) return <div className="launcher-splash" />
  return win.kind === 'launcher' ? <Launcher /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
