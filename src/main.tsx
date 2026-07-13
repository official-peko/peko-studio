import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { peko } from '@peko/client'
import './index.css'
import App from './App'
import { Launcher } from './ide/Launcher'
import { SetupScreen } from './setup/SetupScreen'
import { isLauncherWindow } from './ide/workspace'

// The first window resolves in two stages. First the toolchain is checked: an
// unhealthy or missing install shows the setup screen ahead of everything else,
// so the environment is installed before a project can be opened. Once the
// toolchain is healthy the window resolves to the launcher (no project set) or
// the editor. A /launcher pop-up opened from a running editor skips the check,
// since a running editor already implies a healthy install.
function Root() {
  const routeLauncher = window.location.pathname.replace(/\/+$/, '') === '/launcher'
  const [setup, setSetup] = useState<{ needed: boolean; pekoPresent: boolean } | null>(
    routeLauncher ? { needed: false, pekoPresent: true } : null,
  )
  const [mode, setMode] = useState<'loading' | 'launcher' | 'editor'>(
    routeLauncher ? 'launcher' : 'loading',
  )

  // Check the toolchain before anything else. No bridge (browser dev) or an
  // error leaves the app in place with a healthy assumption.
  useEffect(() => {
    if (routeLauncher) return
    let cancelled = false
    void (async () => {
      try {
        const status = (await peko.invoke('ide.setup.status', {})) as {
          healthy?: boolean
          pekoPresent?: boolean
        }
        if (cancelled) return
        setSetup({ needed: !status.healthy, pekoPresent: status.pekoPresent !== false })
      } catch {
        if (!cancelled) setSetup({ needed: false, pekoPresent: true })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [routeLauncher])

  // Resolve launcher vs editor only once the toolchain is known and healthy, so
  // the project selector never appears ahead of a needed install.
  useEffect(() => {
    if (routeLauncher || mode !== 'loading') return
    if (!setup || setup.needed) return
    let cancelled = false
    void isLauncherWindow().then((launcher) => {
      if (!cancelled) setMode(launcher ? 'launcher' : 'editor')
    })
    return () => {
      cancelled = true
    }
  }, [setup, routeLauncher, mode])

  if (setup?.needed) {
    return <SetupScreen pekoPresent={setup.pekoPresent} onDone={() => window.location.reload()} />
  }
  if (!setup || mode === 'loading') return <div className="launcher-splash" />
  return mode === 'launcher' ? <Launcher /> : <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
