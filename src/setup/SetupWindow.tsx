import { useState } from 'react'
import { peko } from '@peko/client'
import { PekoMark } from '../editor/FileIcon'
import { SetupScreen } from './SetupScreen'
import { PackageManager } from '../ide/PackageManager'
import { UninstallDialog } from './UninstallDialog'

// The Setup window: a standalone app instance (spawned like the launcher) that
// hosts the Peko install/maintenance actions, reachable from both the editor menu
// and the project launcher. `initialView` opens straight to one action.
type View = 'menu' | 'update' | 'resetup' | 'packages' | 'uninstall'

function normalizeView(v: string): View {
  return v === 'update' || v === 'resetup' || v === 'packages' || v === 'uninstall' ? v : 'menu'
}

// Close this window.
function closeWindow() {
  if (window.__PEKO__?.popup) peko.windows.close()
  else peko.window.close()
}

const ACTIONS: { view: View; title: string; desc: string; danger?: boolean }[] = [
  {
    view: 'update',
    title: 'Update Peko CLI',
    desc: 'Install or update the compiler, standard library, and toolchains from the latest GitHub release.',
  },
  {
    view: 'resetup',
    title: 'Re-setup SDK',
    desc: 'Force a clean re-download of the SDK to repair a broken or partial install.',
  },
  {
    view: 'packages',
    title: 'Global Packages',
    desc: 'Manage packages installed globally, shared across every project.',
  },
  {
    view: 'uninstall',
    title: 'Uninstall Peko',
    desc: 'Remove the entire Peko installation (~/.Peko). Your projects are untouched.',
    danger: true,
  },
]

export function SetupWindow({ initialView = 'menu' }: { initialView?: string }) {
  const [view, setView] = useState<View>(() => normalizeView(initialView))
  const back = () => setView('menu')

  // Each action fills the window; closing returns to the menu, from which the
  // window itself is dismissed.
  if (view === 'update')
    return <SetupScreen mode="update" pekoPresent onClose={back} onDone={back} />
  if (view === 'resetup')
    return <SetupScreen mode="resetup" pekoPresent onClose={back} onDone={back} />
  if (view === 'packages') return <PackageManager global onClose={back} />
  if (view === 'uninstall') return <UninstallDialog onClose={back} />

  return (
    <div className="setup-window">
      <div className="setup-window-bar" data-peko-drag>
        <span className="setup-window-glyph">
          <PekoMark />
        </span>
        <span className="setup-window-title">Peko Setup</span>
        <button
          type="button"
          className="setup-window-x"
          data-peko-no-drag
          onClick={closeWindow}
          aria-label="Close"
        >
          &times;
        </button>
      </div>
      <div className="setup-window-grid">
        {ACTIONS.map((a) => (
          <button
            key={a.view}
            type="button"
            className={`setup-action${a.danger ? ' danger' : ''}`}
            onClick={() => setView(a.view)}
          >
            <span className="setup-action-title">{a.title}</span>
            <span className="setup-action-desc">{a.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
