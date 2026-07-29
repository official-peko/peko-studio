import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { peko } from '@peko/client'
import { WindowControls } from './chrome/WindowControls'
import { TrafficLights } from './chrome/TrafficLights'
import { ThemePicker } from './chrome/ThemePicker'
import { AccountChip } from './chrome/AccountChip'
import { usePlatform } from './chrome/usePlatform'
import { EditorArea, type Boot } from './editor/EditorArea'
import { FileExplorer } from './editor/FileExplorer'
import { SearchPanel } from './editor/SearchPanel'
import { TabBar } from './editor/TabBar'
import { PekoMark } from './editor/FileIcon'
import { applyTheme } from './editor/themes'
import { BuildRunPanel } from './panel/BuildRunPanel'
import {
  loadEntry,
  loadManifest,
  openLauncherWindow,
  openProject,
  openSetupWindow,
  pickFolder,
  setWatchedFiles,
  gitStatus,
  getPrefs,
  setPref,
  flushPrefs,
  type GitStatus,
  type Manifest,
  type Tab,
} from './ide/workspace'
import { ProjectSettings } from './ide/ProjectSettings'
import { PackageManager } from './ide/PackageManager'
import { IconBuilder } from './ide/IconBuilder'
import { AgentPanel } from './agent/AgentPanel'
import type { FileDiagnostic } from './lsp/pekoLsp'

/// The Peko Studio shell. The sidebar spans the full window height and holds the
/// file tree; the editor column holds the tab bar with window controls, the
/// editor, and the status bar. The sidebar is drag-resizable.
export default function App() {
  const platform = usePlatform()
  const [theme, setTheme] = useState(() => localStorage.getItem('peko-theme') ?? 'peko-dark')
  const [railWidth, setRailWidth] = useState(() => Number(localStorage.getItem('peko-rail')) || 232)

  const [boot, setBoot] = useState<Boot | null>(null)
  const [railView, setRailView] = useState<'explorer' | 'search'>('explorer')
  const [reveal, setReveal] = useState<{ path: string; line: number; column: number } | null>(null)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activePath, setActivePath] = useState<string | null>(null)
  const [dirty, setDirty] = useState<Set<string>>(new Set())
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showPackages, setShowPackages] = useState(false)
  const [showIcon, setShowIcon] = useState(false)
  const [showAgent, setShowAgent] = useState(false)
  // A newer Peko CLI/SDK release, when one is available, and the update overlay.
  const [update, setUpdate] = useState<{ latest: string | null } | null>(null)

  // A request to refresh an open file's model from disk after an external write.
  const [diagnostics, setDiagnostics] = useState<FileDiagnostic[]>([])
  const [reload, setReload] = useState<{ path: string; token: number } | null>(null)
  const reloadCounter = useRef(0)
  const requestReload = (path: string) => {
    reloadCounter.current += 1
    setReload({ path, token: reloadCounter.current })
  }

  // Files (and their ancestor folders) that currently have errors or warnings,
  // so the file explorer can flag them. Errors win over warnings.
  const problemPaths = useMemo(() => {
    const map = new Map<string, 'error' | 'warning'>()
    const root = boot?.root
    const bump = (path: string, severity: 'error' | 'warning') => {
      if (map.get(path) === 'error') return
      if (severity === 'error' || !map.has(path)) map.set(path, severity)
    }
    for (const d of diagnostics) {
      if (d.severity !== 'error' && d.severity !== 'warning') continue
      bump(d.file, d.severity)
      if (!root || !d.file.startsWith(root)) continue
      let dir = d.file
      while (dir.length > root.length && dir.includes('/')) {
        dir = dir.slice(0, dir.lastIndexOf('/'))
        if (dir.length < root.length) break
        bump(dir, d.severity)
      }
    }
    return map
  }, [diagnostics, boot])

  // Source-control state for the workspace, refreshed on load, on any file
  // reload, and when the window regains focus (so external commits show).
  const [git, setGit] = useState<GitStatus>({ branch: '', entries: [] })
  useEffect(() => {
    let cancelled = false
    const refresh = () => void gitStatus().then((next) => !cancelled && setGit(next))
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [reload, dirty])

  // Changed files (and their ancestor folders, rolled up) so the explorer can
  // color them by git status.
  const gitPaths = useMemo(() => {
    const map = new Map<string, GitStatus['entries'][number]['status']>()
    const root = boot?.root
    for (const entry of git.entries) {
      map.set(entry.path, entry.status)
      if (!root || !entry.path.startsWith(root)) continue
      let dir = entry.path
      while (dir.length > root.length && dir.includes('/')) {
        dir = dir.slice(0, dir.lastIndexOf('/'))
        if (dir.length < root.length) break
        if (!map.has(dir)) map.set(dir, entry.status)
      }
    }
    return map
  }, [git, boot])

  const [panelCollapsed, setPanelCollapsed] = useState(
    () => localStorage.getItem('peko-panel-collapsed') === '1',
  )
  const [panelHeight, setPanelHeight] = useState(
    () => Number(localStorage.getItem('peko-panel-height')) || 240,
  )

  // Track which open files have unsaved edits.
  const markDirty = (path: string, isDirty: boolean) => {
    setDirty((prev) => {
      if (isDirty === prev.has(path)) return prev
      const next = new Set(prev)
      if (isDirty) next.add(path)
      else next.delete(path)
      return next
    })
  }

  // Load the workspace bootstrap and open the entry file in the first tab.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const entry = await loadEntry()
      if (cancelled) return
      if (entry) {
        setBoot({ root: entry.root || undefined, lspPort: entry.lspPort })
        openTab(entry.path)
        if (entry.root) void loadManifest(entry.root).then((m) => !cancelled && setManifest(m))
      } else {
        // No native bridge (browser dev server); the editor still renders.
        setBoot({})
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Check once for a newer Peko CLI/SDK release, to offer an in-IDE update. Runs
  // `peko setup --check` via the native bridge; silent when offline or current.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = (await peko.invoke('ide.update.check', {})) as {
          updateAvailable?: boolean
          latest?: { peko?: string | null }
        }
        if (!cancelled && res?.updateAvailable) {
          setUpdate({ latest: res.latest?.peko ?? null })
        }
      } catch {
        // Offline or no bridge; skip the update prompt.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Load the persisted theme from the native prefs store once the bridge is
  // ready. localStorage is only a fast first-paint default; it does not survive
  // restarts because the asset-server origin changes each launch.
  const themeLoaded = useRef(false)
  const layoutLoaded = useRef(false)
  useEffect(() => {
    void getPrefs().then((prefs) => {
      themeLoaded.current = true
      if (prefs.theme) setTheme(prefs.theme)
      if (prefs.rail) setRailWidth(Number(prefs.rail) || 232)
      if (prefs.panelCollapsed) setPanelCollapsed(prefs.panelCollapsed === '1')
      if (prefs.panelHeight) setPanelHeight(Number(prefs.panelHeight) || 240)
      // Set last: the state updates above re-run the persisting effects, and
      // writing there before the stored values arrive would save the defaults
      // over them.
      layoutLoaded.current = true
    })
    // A debounced write can still be pending when the window closes, so flush
    // it rather than losing the last change made before quitting.
    const onHide = () => void flushPrefs()
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [])

  useEffect(() => {
    applyTheme(theme)
    localStorage.setItem('peko-theme', theme)
    // Persist to the native store, but not for the initial value before the
    // stored theme has loaded (that would overwrite it with the default).
    if (themeLoaded.current) void setPref('theme', theme)
  }, [theme])

  // File menu actions, both of which replace this window. Project Launcher opens
  // the launcher in a new window and closes this one. Open Folder picks a project
  // folder, opens it in a new window, and closes this one - rerouting the editor
  // to the chosen project.
  useEffect(() => {
    const off = peko.on('menu', (data: unknown) => {
      const id = (data as { id?: string } | null)?.id
      if (id === 'file.launcher') {
        void openLauncherWindow().then((ok) => {
          if (ok) peko.window.close()
        })
      } else if (id === 'file.openFolder') {
        void pickFolder().then(async (path) => {
          if (!path) return
          const error = await openProject(path)
          if (!error) peko.window.close()
        })
      } else if (id === 'file.settings') {
        setShowSettings(true)
      } else if (id === 'file.packages') {
        setShowPackages(true)
      } else if (id === 'file.icon') {
        setShowIcon(true)
      } else if (id === 'setup.updateCli') {
        void openSetupWindow('update')
      } else if (id === 'setup.resetupSdk') {
        void openSetupWindow('resetup')
      } else if (id === 'setup.globalPackages') {
        void openSetupWindow('packages')
      } else if (id === 'setup.uninstall') {
        void openSetupWindow('uninstall')
      }
    })
    return off
  }, [])

  // On a platform with no native menu bar (a frameless Windows window), render an
  // HTML menu into the titlebar. It fires the same 'menu' events as the native
  // menu, so the handler above serves both; clipboard and window items run
  // inline. macOS and Linux keep their native bar and skip this.
  const winMenuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (platform.nativeMenu || !winMenuRef.current) return
    const exec = (command: string) => () => document.execCommand(command)
    const bar = peko.menu(
      [
        {
          label: 'File',
          items: [
            { label: 'New File', action: 'file.new', accelerator: 'Ctrl+N' },
            { label: 'Project Launcher...', action: 'file.launcher', accelerator: 'Ctrl+Shift+O' },
            { label: 'Open Folder...', action: 'file.openFolder', accelerator: 'Ctrl+O' },
            { separator: true },
            { label: 'Save', action: 'file.save', accelerator: 'Ctrl+S' },
            { separator: true },
            { label: 'Project Settings...', action: 'file.settings', accelerator: 'Ctrl+,' },
            { label: 'Manage Packages...', action: 'file.packages' },
            { label: 'App Icon...', action: 'file.icon' },
            { separator: true },
            { label: 'Close Window', onClick: () => peko.window.close() },
          ],
        },
        {
          label: 'Edit',
          items: [
            { label: 'Undo', onClick: exec('undo') },
            { label: 'Redo', onClick: exec('redo') },
            { separator: true },
            { label: 'Cut', onClick: exec('cut') },
            { label: 'Copy', onClick: exec('copy') },
            { label: 'Paste', onClick: exec('paste') },
            { label: 'Select All', onClick: exec('selectAll') },
            { separator: true },
            { label: 'Find', action: 'edit.find', accelerator: 'Ctrl+F' },
            { label: 'Format Document', action: 'edit.format', accelerator: 'Shift+Alt+F' },
          ],
        },
        {
          label: 'View',
          items: [
            { label: 'Toggle Dev Tools', onClick: () => setPanelCollapsed((v) => !v) },
            { label: 'Toggle Word Wrap', action: 'view.wordwrap', accelerator: 'Alt+Z' },
          ],
        },
        {
          label: 'Setup',
          items: [
            { label: 'Update Peko CLI...', action: 'setup.updateCli' },
            { label: 'Re-setup SDK...', action: 'setup.resetupSdk' },
            { label: 'Global Packages...', action: 'setup.globalPackages' },
            { separator: true },
            { label: 'Uninstall Peko...', action: 'setup.uninstall' },
          ],
        },
        {
          label: 'Help',
          items: [{ label: 'Documentation', onClick: () => window.open('https://github.com/official-peko', '_blank') }],
        },
      ],
      { mount: winMenuRef.current },
    )
    return () => bar?.remove()
  }, [platform.nativeMenu])

  // Opening the project's peko.toml shows the settings editor. "Edit Raw" sets
  // this ref so the same activation does not immediately reopen the modal.
  const suppressAutoSettings = useRef(false)
  useEffect(() => {
    if (boot?.root && activePath === `${boot.root}/peko.toml`) {
      if (suppressAutoSettings.current) {
        suppressAutoSettings.current = false
        return
      }
      setShowSettings(true)
    }
  }, [activePath, boot])

  // Keep the file watcher's set in sync with the open tabs, so external changes
  // to any open file push a live reload.
  useEffect(() => {
    setWatchedFiles(tabs.map((tab) => tab.path))
  }, [tabs])

  // The layout sizes persist the same way the theme does: localStorage is the
  // fast first-paint default, and the native store is what survives a restart.
  // setPref debounces, so a drag does not write on every frame.
  useEffect(() => {
    localStorage.setItem('peko-rail', String(railWidth))
    if (layoutLoaded.current) setPref('rail', String(railWidth))
  }, [railWidth])

  useEffect(() => {
    localStorage.setItem('peko-panel-collapsed', panelCollapsed ? '1' : '0')
    if (layoutLoaded.current) setPref('panelCollapsed', panelCollapsed ? '1' : '0')
  }, [panelCollapsed])

  useEffect(() => {
    localStorage.setItem('peko-panel-height', String(panelHeight))
    if (layoutLoaded.current) setPref('panelHeight', String(panelHeight))
  }, [panelHeight])

  // Drag the horizontal divider to resize the bottom panel (grows upward).
  const startPanelResize = (event: ReactMouseEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = panelHeight
    const onMove = (move: globalThis.MouseEvent) =>
      setPanelHeight(Math.min(600, Math.max(120, startHeight + startY - move.clientY)))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const openTab = (path: string) => {
    const name = path.split('/').pop() ?? path
    setTabs((prev) => (prev.some((tab) => tab.path === path) ? prev : [...prev, { path, name }]))
    setActivePath(path)
  }

  // Close a set of tabs at once. When the active tab is among them, activate the
  // nearest survivor.
  const closePaths = (toClose: Set<string>) => {
    if (toClose.size === 0) return
    const index = activePath ? tabs.findIndex((tab) => tab.path === activePath) : -1
    const remaining = tabs.filter((tab) => !toClose.has(tab.path))
    setTabs(remaining)
    if (activePath && toClose.has(activePath)) {
      if (remaining.length === 0) {
        setActivePath(null)
      } else {
        setActivePath(remaining[Math.min(index, remaining.length - 1)].path)
      }
    }
  }

  const closeTab = (path: string) => closePaths(new Set([path]))
  const closeOthers = (path: string) =>
    closePaths(new Set(tabs.filter((tab) => tab.path !== path).map((tab) => tab.path)))
  const closeToRight = (path: string) => {
    const index = tabs.findIndex((tab) => tab.path === path)
    closePaths(new Set(tabs.slice(index + 1).map((tab) => tab.path)))
  }
  const closeToLeft = (path: string) => {
    const index = tabs.findIndex((tab) => tab.path === path)
    closePaths(new Set(tabs.slice(0, index).map((tab) => tab.path)))
  }
  const closeAll = () => closePaths(new Set(tabs.map((tab) => tab.path)))

  // Move one tab to another's position (drag to reorder).
  const reorderTabs = (fromPath: string, toPath: string) => {
    if (fromPath === toPath) return
    setTabs((prev) => {
      const from = prev.findIndex((tab) => tab.path === fromPath)
      const to = prev.findIndex((tab) => tab.path === toPath)
      if (from < 0 || to < 0) return prev
      const next = prev.slice()
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  const startResize = (event: ReactMouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = railWidth
    const onMove = (move: globalThis.MouseEvent) =>
      setRailWidth(Math.min(440, Math.max(170, startWidth + move.clientX - startX)))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // On macOS the web UI draws its own traffic lights at the top-left; other
  // desktop platforms put their controls at the top-right.
  const macControls = platform.windowControls && platform.os === 'macos'
  const railInset = platform.nativeControls ? platform.titlebarInset || 76 : 12

  const revealLabel =
    platform.os === 'windows'
      ? 'Show in Explorer'
      : platform.os === 'linux'
        ? 'Open Containing Folder'
        : 'Reveal in Finder'

  return (
    <div className="shell">
      <nav className="rail" style={{ width: railWidth }}>
        <div className="rail-top" data-peko-drag style={{ paddingLeft: railInset }}>
          {macControls && <TrafficLights />}
          <span className="brand-mark">
            <PekoMark />
          </span>
          <span className="brand">Peko Studio</span>
        </div>
        <div className="rail-group">
          <div className="rail-tabs">
            <button
              className={railView === 'explorer' ? 'active' : ''}
              onClick={() => setRailView('explorer')}
            >
              Explorer
            </button>
            <button
              className={railView === 'search' ? 'active' : ''}
              onClick={() => setRailView('search')}
            >
              Search
            </button>
          </div>
          {railView === 'explorer' ? (
            <FileExplorer
              rootPath={boot?.root ?? ''}
              activePath={activePath}
              dirtyPaths={dirty}
              problemPaths={problemPaths}
              gitStatus={gitPaths}
              revealLabel={revealLabel}
              onOpen={openTab}
              onPathRemoved={closeTab}
            />
          ) : (
            <SearchPanel
              rootPath={boot?.root ?? ''}
              onOpen={(path, line, column) => {
                openTab(path)
                setReveal({ path, line, column })
              }}
            />
          )}
        </div>
      </nav>

      <div className="resizer" onMouseDown={startResize} />

      <div className="maincol">
        <div className="topbar" data-peko-drag>
          {!platform.nativeMenu && <div className="win-menu" ref={winMenuRef} data-peko-no-drag />}
          <TabBar
            tabs={tabs}
            activePath={activePath}
            dirtyPaths={dirty}
            onActivate={setActivePath}
            onClose={closeTab}
            onCloseOthers={closeOthers}
            onCloseToRight={closeToRight}
            onCloseToLeft={closeToLeft}
            onCloseAll={closeAll}
            onReorder={reorderTabs}
          />
          <div className="topbar-spacer" />
          {platform.windowControls && !macControls && <WindowControls />}
        </div>

        <EditorArea
          boot={boot}
          tabs={tabs}
          activePath={activePath}
          reveal={reveal}
          reload={reload}
          onDirty={markDirty}
          onRequestOpen={openTab}
          onDiagnostics={setDiagnostics}
        />

        {!panelCollapsed && (
          <>
            <div className="hresizer" onMouseDown={startPanelResize} />
            <div className="panel-dock" style={{ height: panelHeight }}>
              <BuildRunPanel
                platforms={manifest?.targetPlatforms ?? []}
                hostPlatform={platform.os}
                collapsed={false}
                root={boot?.root}
                diagnostics={diagnostics}
                onOpenFile={(path, line, column) => {
                  openTab(path)
                  setReveal({ path, line: line || 1, column: column || 1 })
                }}
              />
            </div>
          </>
        )}

        <footer className="statusbar">
          {git.branch && (
            <span className="status-branch" title="Current git branch">
              {git.branch}
            </span>
          )}
          <span className="spacer" />
          <button
            className={`status-toggle${showAgent ? ' active' : ''}`}
            title="Toggle the AI agent"
            onClick={() => setShowAgent((v) => !v)}
          >
            Agent
          </button>
          <button
            className="status-toggle"
            title={panelCollapsed ? 'Show dev tools' : 'Hide dev tools'}
            onClick={() => setPanelCollapsed((v) => !v)}
          >
            {panelCollapsed ? 'Dev Tools ▲' : 'Dev Tools ▼'}
          </button>
          <button
            className="status-toggle"
            title="Design the app icon"
            onClick={() => setShowIcon(true)}
          >
            Icon
          </button>
          <button
            className="status-toggle"
            title="Manage packages"
            onClick={() => setShowPackages(true)}
          >
            Packages
          </button>
          {update && (
            <button
              className="status-toggle status-update"
              title={`A new Peko version${update.latest ? ` (${update.latest})` : ''} is available. Click to update.`}
              onClick={() => void openSetupWindow('update')}
            >
              Update ●
            </button>
          )}
          <ThemePicker value={theme} onChange={setTheme} />
          <AccountChip />
        </footer>
      </div>

      {/* Kept mounted so the slide transition fires on every open, and so the
          agent session and transcript survive being closed and reopened. */}
      {boot?.root && (
        <div className={`agent-rail${showAgent ? ' open' : ''}`}>
          <AgentPanel root={boot.root} onOpenFile={openTab} />
        </div>
      )}

      {showSettings && boot?.root && (
        <ProjectSettings
          root={boot.root}
          onClose={() => {
            setShowSettings(false)
            if (boot?.root) requestReload(`${boot.root}/peko.toml`)
          }}
          onEditRaw={() => {
            const manifest = `${boot.root}/peko.toml`
            if (activePath !== manifest) {
              suppressAutoSettings.current = true
              openTab(manifest)
            }
            setShowSettings(false)
            requestReload(manifest)
          }}
        />
      )}
      {showPackages && boot?.root && (
        <PackageManager
          root={boot.root}
          onClose={() => {
            setShowPackages(false)
            if (boot?.root) requestReload(`${boot.root}/peko.toml`)
          }}
        />
      )}
      {showIcon && boot?.root && (
        <IconBuilder
          root={boot.root}
          onClose={() => {
            setShowIcon(false)
            if (boot?.root) requestReload(`${boot.root}/peko.toml`)
          }}
        />
      )}
    </div>
  )
}
