// Package manager: an in-editor panel over the project's dependencies and the
// public registry. The Installed tab lists the [dependencies] table from peko.toml
// and adds/removes packages through the native ide.packages.* handlers (which run
// `peko add` / `peko remove`). The Browse tab searches the public registry index
// and installs directly.
import { useEffect, useMemo, useRef, useState } from 'react'
import { listPackages, addPackage, removePackage, type Package } from './workspace'
import { registrySearch, type RegistryPackage } from './registry'

type Tab = 'installed' | 'browse'

export function PackageManager({ root, onClose }: { root: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('installed')
  const [scope, setScope] = useState<'local' | 'global'>('local')
  const [packages, setPackages] = useState<Package[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [output, setOutput] = useState('')

  const installedNames = useMemo(() => new Set(packages.map((p) => p.name)), [packages])

  function refresh() {
    setLoading(true)
    void listPackages(root).then((list) => {
      setPackages(list)
      setLoading(false)
    })
  }
  useEffect(refresh, [root])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  async function install(name: string, version?: string) {
    if (busy) return
    const global = scope === 'global'
    setBusy(true)
    setOutput(`Installing ${name}${version ? ` ${version}` : ''}${global ? ' globally' : ''}...`)
    const result = await addPackage({ name, version, global })
    setBusy(false)
    setOutput(result.output.trim() || (result.ok ? 'Done.' : 'Failed.'))
    // A global install does not change the project's dependency list.
    if (result.ok && !global) refresh()
    return result.ok
  }

  async function remove(name: string) {
    if (busy) return
    setBusy(true)
    setOutput(`Removing ${name}...`)
    const result = await removePackage(name)
    setBusy(false)
    setOutput(result.output.trim() || (result.ok ? 'Done.' : 'Failed.'))
    if (result.ok) refresh()
  }

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="settings-card pkg-card" role="dialog" aria-label="Package manager">
        <div className="settings-head">
          <h2>Packages</h2>
          <button type="button" className="settings-x" onClick={onClose} disabled={busy} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="pkg-tabs" role="tablist">
          <button
            type="button"
            className={`pkg-tab${tab === 'installed' ? ' active' : ''}`}
            onClick={() => setTab('installed')}
          >
            Installed{packages.length > 0 ? ` (${packages.length})` : ''}
          </button>
          <button
            type="button"
            className={`pkg-tab${tab === 'browse' ? ' active' : ''}`}
            onClick={() => setTab('browse')}
          >
            Browse
          </button>
          <span className="pkg-tab-spacer" />
          <div className="pkg-scope" title="Where to install: this project, or shared across all projects">
            <button
              type="button"
              className={`pkg-scope-opt${scope === 'local' ? ' active' : ''}`}
              onClick={() => setScope('local')}
            >
              Local
            </button>
            <button
              type="button"
              className={`pkg-scope-opt${scope === 'global' ? ' active' : ''}`}
              onClick={() => setScope('global')}
            >
              Global
            </button>
          </div>
        </div>

        <div className="settings-body">
          {tab === 'installed' ? (
            <InstalledTab
              packages={packages}
              loading={loading}
              busy={busy}
              onAdd={install}
              onRemove={remove}
            />
          ) : (
            <BrowseTab busy={busy} installed={installedNames} onInstall={install} />
          )}

          {output && <pre className="pkg-output">{output}</pre>}
        </div>

        <div className="settings-actions">
          <button type="button" className="settings-cancel" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function InstalledTab({
  packages,
  loading,
  busy,
  onAdd,
  onRemove,
}: {
  packages: Package[]
  loading: boolean
  busy: boolean
  onAdd: (name: string, version?: string) => void
  onRemove: (name: string) => void
}) {
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')

  function submit() {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    onAdd(trimmed, version.trim() || undefined)
    setName('')
    setVersion('')
  }

  return (
    <>
      <div className="pkg-add">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="package name (e.g. sockets)"
        />
        <input
          className="pkg-version"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="version (optional)"
        />
        <button type="button" className="settings-save" disabled={busy || !name.trim()} onClick={submit}>
          Add
        </button>
      </div>

      <div className="pkg-list">
        {loading ? (
          <p className="pkg-empty">Loading...</p>
        ) : packages.length === 0 ? (
          <p className="pkg-empty">No dependencies. Use Browse to find packages.</p>
        ) : (
          packages.map((p) => (
            <div key={p.name} className="pkg-item">
              <div className="pkg-meta">
                <span className="pkg-name">{p.name}</span>
                <span className="pkg-spec">{p.isPath ? `path: ${p.spec}` : p.spec}</span>
              </div>
              <button
                type="button"
                className="pkg-remove"
                disabled={busy}
                onClick={() => onRemove(p.name)}
                title={`Remove ${p.name}`}
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>
    </>
  )
}

function ResultRow({
  pkg,
  busy,
  installed,
  onInstall,
}: {
  pkg: RegistryPackage
  busy: boolean
  installed: boolean
  onInstall: (name: string, version?: string) => void
}) {
  // Newest first, with "latest" (no pin) as the default.
  const [choice, setChoice] = useState('latest')
  const versions = [...pkg.versions].reverse()

  return (
    <div className="pkg-result">
      <div className="pkg-result-head">
        <span className="pkg-name">{pkg.name}</span>
        {pkg.latest && <span className="pkg-badge">{pkg.latest}</span>}
        <span className="pkg-result-spacer" />
        {installed ? (
          <span className="pkg-installed">Installed</span>
        ) : (
          <>
            {versions.length > 0 && (
              <select
                className="pkg-ver-select"
                value={choice}
                disabled={busy}
                onChange={(e) => setChoice(e.target.value)}
                title="Version to install"
              >
                <option value="latest">latest</option>
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="settings-save pkg-install"
              disabled={busy}
              onClick={() => onInstall(pkg.name, choice === 'latest' ? undefined : choice)}
            >
              Add
            </button>
          </>
        )}
      </div>
      {pkg.description && <div className="pkg-result-desc">{pkg.description}</div>}
      <div className="pkg-result-foot">
        {pkg.author && <span>{pkg.author}</span>}
        {pkg.license && <span>{pkg.license}</span>}
        <span>{pkg.downloadCount.toLocaleString()} downloads</span>
      </div>
    </div>
  )
}

function BrowseTab({
  busy,
  installed,
  onInstall,
}: {
  busy: boolean
  installed: Set<string>
  onInstall: (name: string, version?: string) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<RegistryPackage[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('loading')
  const reqId = useRef(0)

  useEffect(() => {
    const id = ++reqId.current
    setState('loading')
    const handle = setTimeout(() => {
      registrySearch(query)
        .then((list) => {
          if (reqId.current !== id) return
          setResults(list)
          setState('idle')
        })
        .catch(() => {
          if (reqId.current !== id) return
          setState('error')
        })
    }, 220)
    return () => clearTimeout(handle)
  }, [query])

  return (
    <>
      <div className="pkg-search">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the registry by name or description..."
        />
      </div>

      <div className="pkg-list">
        {state === 'loading' ? (
          <p className="pkg-empty">Searching...</p>
        ) : state === 'error' ? (
          <p className="pkg-empty">Could not reach the registry. Check your connection.</p>
        ) : results.length === 0 ? (
          <p className="pkg-empty">{query ? 'No packages match your search.' : 'No packages published yet.'}</p>
        ) : (
          results.map((p) => <ResultRow key={p.name} pkg={p} busy={busy} installed={installed.has(p.name)} onInstall={onInstall} />)
        )}
      </div>
    </>
  )
}
