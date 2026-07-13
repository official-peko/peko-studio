// The Peko Studio project launcher. It is the first window on launch (when no
// project is set) and can also open from an editor's menu as a pop-up. The home
// view is an Xcode-like split: a wide "new project" template chooser on the
// left and a narrow recent-projects rail on the right. Choosing a template or
// opening a project slides the whole window to a focused detail view. Each flow
// calls the native ide.projects.* handlers; opening or creating a project starts
// an editor window and dismisses the launcher.
import { useEffect, useRef, useState } from 'react'
import { peko } from '@peko/client'
import { applyTheme } from '../editor/themes'
import {
  recentProjects,
  openProject,
  newProject,
  pickFolder,
  type RecentProject,
} from './workspace'
import { PekoMark } from '../editor/FileIcon'
import reactLogo from './logos/react.svg'
import vueLogo from './logos/vue.svg'
import svelteLogo from './logos/svelte.svg'
import solidLogo from './logos/solid.svg'
import preactLogo from './logos/preact.svg'
import jsLogo from './logos/javascript.svg'

type View = 'home' | 'configure' | 'open'

// create-vite templates offered for a new UI project, plus a command-line
// (no UI) option. Each carries its framework's logo; the command-line option
// has no framework logo and shows a terminal glyph.
const TEMPLATES = [
  { label: 'React', framework: 'react-ts', ui: true, logo: reactLogo },
  { label: 'Vue', framework: 'vue-ts', ui: true, logo: vueLogo },
  { label: 'Svelte', framework: 'svelte-ts', ui: true, logo: svelteLogo },
  { label: 'Solid', framework: 'solid', ui: true, logo: solidLogo },
  { label: 'Preact', framework: 'preact', ui: true, logo: preactLogo },
  { label: 'Vanilla', framework: 'vanilla', ui: true, logo: jsLogo },
  { label: 'Command Line', framework: '', ui: false, logo: null },
]

// The launcher runs either as the first window (the whole app, when no project
// is set) or as a pop-up opened from an editor's menu. Dismiss the right one.
function dismissLauncher(result?: unknown) {
  if (window.__PEKO__?.popup) {
    peko.windows.close(null, result)
  } else {
    peko.window.close()
  }
}

const isMac = peko.platform?.os === 'macos'

export function Launcher() {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [view, setView] = useState<View>('home')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // New-project fields.
  const [name, setName] = useState('')
  const [dir, setDir] = useState('')
  const [ui, setUi] = useState(true)
  const [framework, setFramework] = useState('react-ts')

  // Open-by-path field.
  const [openPath, setOpenPath] = useState('')

  const nameRef = useRef<HTMLInputElement>(null)
  const openRef = useRef<HTMLInputElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    applyTheme(localStorage.getItem('peko-theme') ?? 'peko-dark')
    // A rounded, transparent window needs a transparent page behind the card.
    document.documentElement.classList.add('launcher-window')
    void recentProjects().then(setRecents)
    return () => document.documentElement.classList.remove('launcher-window')
  }, [])

  // Slide between the home and detail panes by scrolling the viewport to an
  // exact pixel target. Native scroll decelerates to that target with no
  // overshoot, and both panes stay mounted, so nothing reflows mid-slide.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const index = view === 'home' ? 0 : 1
    viewport.scrollTo({ left: index * viewport.clientWidth, behavior: 'smooth' })
  }, [view])

  // Keep the pane aligned when the window resizes.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const realign = () => {
      const index = view === 'home' ? 0 : 1
      viewport.scrollTo({ left: index * viewport.clientWidth, behavior: 'auto' })
    }
    window.addEventListener('resize', realign)
    return () => window.removeEventListener('resize', realign)
  }, [view])

  // Focus the detail field when a form opens, without scrolling it into view
  // (a scroll-into-view would move the viewport and fight the slide).
  useEffect(() => {
    const target = view === 'configure' ? nameRef.current : view === 'open' ? openRef.current : null
    target?.focus({ preventScroll: true })
  }, [view])

  function goConfigure(template: (typeof TEMPLATES)[number]) {
    setUi(template.ui)
    if (template.ui) setFramework(template.framework)
    setError('')
    setView('configure')
  }

  function goOpen() {
    setError('')
    setView('open')
  }

  function back() {
    setError('')
    setView('home')
  }

  async function chooseInto(setter: (value: string) => void) {
    const chosen = await pickFolder()
    if (chosen) setter(chosen)
  }

  async function open(path: string) {
    const trimmed = path.trim()
    if (!trimmed) {
      setError('Enter a project path')
      return
    }
    setBusy(true)
    setError('')
    const err = await openProject(trimmed)
    setBusy(false)
    if (err) {
      setError(err)
      return
    }
    dismissLauncher({ opened: trimmed })
  }

  async function create() {
    if (!name.trim()) {
      setError('Enter a project name')
      return
    }
    setBusy(true)
    setError('')
    const result = await newProject({
      name: name.trim(),
      dir: dir.trim() || undefined,
      ui,
      framework: ui ? framework : undefined,
    })
    setBusy(false)
    if ('error' in result) {
      setError(result.error)
      return
    }
    dismissLauncher({ created: result.path })
  }

  return (
    <div className={`launcher${isMac ? ' rounded' : ''}`}>
      <div className="launcher-titlebar" data-peko-drag>
        <span className="launcher-glyph">
          <PekoMark />
        </span>
        <span className="launcher-title">Peko Studio</span>
        <button
          type="button"
          className="launcher-x"
          data-peko-no-drag
          onClick={() => dismissLauncher()}
          aria-label="Close"
        >
          &times;
        </button>
      </div>

      <div className="launcher-viewport" ref={viewportRef}>
        {/* Home pane: template chooser (wide) + recent rail (narrow). */}
        <section className="launcher-pane launcher-home">
          <div className="launcher-new">
            <h1>Create a new project</h1>
            <p className="launcher-sub">Choose a template to get started.</p>
            <div className="launcher-templates">
              {TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  className="launcher-card"
                  onClick={() => goConfigure(t)}
                >
                  {t.logo ? (
                    <img className="launcher-card-logo" src={t.logo} alt="" draggable={false} />
                  ) : (
                    <span className="launcher-card-logo launcher-card-term" aria-hidden>
                      &gt;_
                    </span>
                  )}
                  <span className="launcher-card-label">{t.label}</span>
                </button>
              ))}
            </div>
          </div>

          <aside className="launcher-rail">
            <h2>Recent</h2>
            <div className="launcher-recents">
              {recents.length === 0 ? (
                <p className="launcher-empty">No recent projects.</p>
              ) : (
                recents.map((p) => (
                  <button
                    key={p.path}
                    type="button"
                    className="launcher-recent"
                    disabled={busy || !p.exists}
                    onClick={() => open(p.path)}
                    title={p.path}
                  >
                    <span className="launcher-recent-name">{p.name}</span>
                    <span className="launcher-recent-path">
                      {p.exists ? p.path : `${p.path} (missing)`}
                    </span>
                  </button>
                ))
              )}
            </div>
            <button type="button" className="launcher-open-link" onClick={goOpen}>
              Open a project...
            </button>
          </aside>
        </section>

        {/* Detail pane: the configure form or the open form. */}
        <section className="launcher-pane launcher-detail">
          <button type="button" className="launcher-back" onClick={back}>
            &lsaquo; Back
          </button>

          {view === 'configure' && (
            <div className="launcher-form">
              <h1>{ui ? 'Configure your app' : 'Configure your project'}</h1>
              <label>
                <span>Name</span>
                <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="my-app" />
              </label>
              <label>
                <span>Location</span>
                <div className="launcher-path">
                  <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~ (home)" />
                  <button type="button" onClick={() => void chooseInto(setDir)}>Choose...</button>
                </div>
              </label>
              {ui && (
                <label>
                  <span>Framework</span>
                  <select value={framework} onChange={(e) => setFramework(e.target.value)}>
                    {TEMPLATES.filter((t) => t.ui).map((t) => (
                      <option key={t.framework} value={t.framework}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {error && <p className="launcher-error">{error}</p>}
              <div className="launcher-actions">
                <button type="button" className="primary" disabled={busy} onClick={create}>
                  {busy ? 'Creating...' : 'Create'}
                </button>
              </div>
            </div>
          )}

          {view === 'open' && (
            <div className="launcher-form">
              <h1>Open a project</h1>
              <label>
                <span>Project folder</span>
                <div className="launcher-path">
                  <input
                    ref={openRef}
                    value={openPath}
                    onChange={(e) => setOpenPath(e.target.value)}
                    placeholder="/path/to/project"
                  />
                  <button type="button" onClick={() => void chooseInto(setOpenPath)}>Choose...</button>
                </div>
              </label>
              <p className="launcher-hint">Pick the folder that holds the project's peko.toml.</p>
              {error && <p className="launcher-error">{error}</p>}
              <div className="launcher-actions">
                <button type="button" className="primary" disabled={busy} onClick={() => open(openPath)}>
                  {busy ? 'Opening...' : 'Open'}
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

