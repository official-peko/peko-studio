// Project settings editor: an in-editor modal over the project's peko.toml. It
// edits the common fields (name, bundle id, version, target platforms, and the
// UI scheme and window size) with targeted text replacements, so the rest of
// the manifest - comments, dependencies, capabilities - is preserved. "Edit
// Raw" closes the modal and opens peko.toml in the editor for direct edits.
import { useEffect, useState } from 'react'
import { readFile, saveFile, joinPath } from './workspace'

const PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android']

function firstMatch(text: string, re: RegExp): string {
  return text.match(re)?.[1] ?? ''
}

export function ProjectSettings({
  root,
  onClose,
  onEditRaw,
}: {
  root: string
  onClose: () => void
  onEditRaw: () => void
}) {
  const [base, setBase] = useState<string | null>(null)
  const [loadError, setLoadError] = useState('')
  const [name, setName] = useState('')
  const [bundle, setBundle] = useState('')
  const [version, setVersion] = useState('')
  const [scheme, setScheme] = useState('')
  const [width, setWidth] = useState('')
  const [height, setHeight] = useState('')
  const [targets, setTargets] = useState<string[]>([])
  const [hasUi, setHasUi] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void readFile(joinPath(root, 'peko.toml')).then((text) => {
      if (cancelled) return
      if (text === null) {
        setLoadError('Could not read peko.toml')
        return
      }
      setBase(text)
      setName(firstMatch(text, /^\s*name\s*=\s*"([^"]*)"/m))
      setBundle(firstMatch(text, /^\s*bundle\s*=\s*"([^"]*)"/m))
      setVersion(firstMatch(text, /^\s*version\s*=\s*"([^"]*)"/m))
      setScheme(firstMatch(text, /^\s*scheme\s*=\s*"([^"]*)"/m))
      setWidth(firstMatch(text, /^\s*width\s*=\s*(\d+)/m))
      setHeight(firstMatch(text, /^\s*height\s*=\s*(\d+)/m))
      setHasUi(/^\s*\[ui\]/m.test(text))
      const platforms = text.match(/target_platforms\s*=\s*\[([^\]]*)\]/)
      setTargets(platforms ? [...platforms[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [])
    })
    return () => {
      cancelled = true
    }
  }, [root])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function toggleTarget(platform: string) {
    setTargets((prev) => (prev.includes(platform) ? prev.filter((p) => p !== platform) : [...prev, platform]))
  }

  async function save() {
    if (base === null) return
    if (!name.trim()) {
      setError('Name cannot be empty')
      return
    }
    setSaving(true)
    setError('')

    const setStr = (t: string, key: string, value: string) =>
      t.replace(new RegExp(`^(\\s*${key}\\s*=\\s*)"[^"]*"`, 'm'), `$1"${value}"`)
    const setNum = (t: string, key: string, value: string) =>
      value ? t.replace(new RegExp(`^(\\s*${key}\\s*=\\s*)\\d+`, 'm'), `$1${value}`) : t

    let text = base
    text = setStr(text, 'name', name.trim())
    text = setStr(text, 'bundle', bundle.trim())
    text = setStr(text, 'version', version.trim())
    if (hasUi) {
      text = setStr(text, 'scheme', scheme.trim())
      text = setNum(text, 'width', width)
      text = setNum(text, 'height', height)
    }
    const ordered = PLATFORMS.filter((p) => targets.includes(p))
    text = text.replace(
      /(target_platforms\s*=\s*\[)[^\]]*(\])/,
      `$1${ordered.map((p) => `"${p}"`).join(', ')}$2`,
    )

    const ok = await saveFile(joinPath(root, 'peko.toml'), text)
    setSaving(false)
    if (!ok) {
      setError('Could not write peko.toml')
      return
    }
    onClose()
  }

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-card" role="dialog" aria-label="Project settings">
        <div className="settings-head">
          <h2>Project Settings</h2>
          <button type="button" className="settings-x" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        {loadError ? (
          <p className="settings-error" style={{ padding: 16 }}>
            {loadError}
          </p>
        ) : (
          <div className="settings-body">
            <label>
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span>Bundle ID</span>
              <input value={bundle} onChange={(e) => setBundle(e.target.value)} placeholder="com.example.app" />
            </label>
            <label>
              <span>Version</span>
              <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="0.1.0" />
            </label>

            <div className="settings-field">
              <span>Target platforms</span>
              <div className="settings-targets">
                {PLATFORMS.map((p) => (
                  <label key={p} className="settings-check">
                    <input type="checkbox" checked={targets.includes(p)} onChange={() => toggleTarget(p)} />
                    <span>{p}</span>
                  </label>
                ))}
              </div>
            </div>

            {hasUi && (
              <>
                <label>
                  <span>URL scheme</span>
                  <input value={scheme} onChange={(e) => setScheme(e.target.value)} placeholder="myapp" />
                </label>
                <div className="settings-row2">
                  <label>
                    <span>Window width</span>
                    <input
                      value={width}
                      onChange={(e) => setWidth(e.target.value.replace(/\D/g, ''))}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    <span>Window height</span>
                    <input
                      value={height}
                      onChange={(e) => setHeight(e.target.value.replace(/\D/g, ''))}
                      inputMode="numeric"
                    />
                  </label>
                </div>
              </>
            )}

            {error && <p className="settings-error">{error}</p>}
          </div>
        )}

        <div className="settings-actions">
          <button type="button" className="settings-editraw" onClick={onEditRaw}>
            Edit Raw peko.toml
          </button>
          <span className="settings-actions-spacer" />
          <button type="button" className="settings-cancel" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="settings-save" disabled={saving || base === null} onClick={save}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
