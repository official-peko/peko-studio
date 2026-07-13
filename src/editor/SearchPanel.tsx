import { useMemo, useState } from 'react'
import { peko } from '@peko/client'

/// One project-search hit, mirroring the native `peko search` reply.
type Match = { path: string; line: number; column: number; text: string; start: number; length: number }
type SearchResult = { matches?: Match[]; truncated?: boolean; error?: string }

type Options = { regex: boolean; caseSensitive: boolean; word: boolean }

/// Project-wide search and replace. Drives the native ide.search / ide.replace
/// handlers (which run `peko search` in a subprocess) with regex, case, whole
/// word, and include/exclude glob filters. Results are grouped by file and each
/// group folds; clicking a hit opens the file at that line.
export function SearchPanel({
  rootPath,
  onOpen,
}: {
  rootPath: string
  onOpen: (path: string, line: number, column: number) => void
}) {
  const [query, setQuery] = useState('')
  const [replace, setReplace] = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [opts, setOpts] = useState<Options>({ regex: false, caseSensitive: false, word: false })
  const [matches, setMatches] = useState<Match[]>([])
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [ran, setRan] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const flag = (on: boolean) => (on ? '1' : '')
  const searchParams = () => ({
    query: query.trim(),
    regex: flag(opts.regex),
    case: flag(opts.caseSensitive),
    word: flag(opts.word),
    include: include.trim(),
    exclude: exclude.trim(),
  })

  const run = async () => {
    const q = query.trim()
    if (!q) {
      setMatches([])
      setRan(false)
      setError('')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = (await peko.invoke('ide.search', searchParams())) as SearchResult
      setMatches(res.matches ?? [])
      setTruncated(!!res.truncated)
      setError(res.error ?? '')
      setCollapsed(new Set())
    } catch {
      setMatches([])
      setError('search failed')
    }
    setBusy(false)
    setRan(true)
  }

  const replaceAll = async () => {
    const q = query.trim()
    if (!q) return
    setBusy(true)
    try {
      await peko.invoke('ide.replace', { ...searchParams(), replace })
    } catch {
      // ignore; re-run reflects the result
    }
    setBusy(false)
    await run()
  }

  const groups = useMemo(() => {
    const map = new Map<string, Match[]>()
    for (const m of matches) {
      const arr = map.get(m.path) ?? []
      arr.push(m)
      map.set(m.path, arr)
    }
    return map
  }, [matches])

  const rel = (p: string) => (rootPath && p.startsWith(rootPath + '/') ? p.slice(rootPath.length + 1) : p)
  const toggleFold = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const OptBtn = ({ on, onClick, label, title }: { on: boolean; onClick: () => void; label: string; title: string }) => (
    <button className={`search-opt ${on ? 'on' : ''}`} title={title} onClick={onClick} tabIndex={-1}>
      {label}
    </button>
  )

  return (
    <div className="search-panel">
      <div className="search-top">
        <button
          className="search-expand"
          title={showReplace ? 'Hide replace' : 'Toggle replace'}
          onClick={() => setShowReplace((s) => !s)}
        >
          {showReplace ? '▾' : '▸'}
        </button>
        <div className="search-fields">
          <div className="search-field">
            <input
              className="search-input"
              value={query}
              placeholder="Search"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run()
              }}
            />
            <div className="search-opts">
              <OptBtn on={opts.caseSensitive} title="Match case" label="Aa" onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))} />
              <OptBtn on={opts.word} title="Match whole word" label="ab" onClick={() => setOpts((o) => ({ ...o, word: !o.word }))} />
              <OptBtn on={opts.regex} title="Use regular expression" label=".*" onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))} />
            </div>
          </div>
          {showReplace && (
            <div className="search-field">
              <input
                className="search-input"
                value={replace}
                placeholder="Replace"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(e) => setReplace(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void replaceAll()
                }}
              />
              <button className="search-replace-all" title="Replace all" disabled={busy || matches.length === 0} onClick={() => void replaceAll()}>
                Replace All
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="search-filtertoggle">
        <button onClick={() => setShowFilters((s) => !s)}>{showFilters ? '▾' : '▸'} files to include / exclude</button>
      </div>
      {showFilters && (
        <div className="search-filters">
          <input className="search-input" value={include} placeholder="include e.g. *.ts, src/**" spellCheck={false} onChange={(e) => setInclude(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
          <input className="search-input" value={exclude} placeholder="exclude e.g. *.test.*, dist/**" spellCheck={false} onChange={(e) => setExclude(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void run()} />
        </div>
      )}

      {busy && <div className="search-hint">Searching...</div>}
      {error && <div className="search-hint search-error">{error}</div>}
      {ran && !busy && !error && matches.length === 0 && <div className="search-hint">No results</div>}
      {matches.length > 0 && (
        <div className="search-count">
          {matches.length} result{matches.length === 1 ? '' : 's'} in {groups.size} file
          {groups.size === 1 ? '' : 's'}
          {truncated ? ' (truncated)' : ''}
        </div>
      )}

      <div className="search-results">
        {[...groups.entries()].map(([path, ms]) => {
          const folded = collapsed.has(path)
          const name = rel(path)
          return (
            <div key={path} className="search-group">
              <div className="search-file" onClick={() => toggleFold(path)}>
                <span className="search-fold">{folded ? '▸' : '▾'}</span>
                <span className="search-file-name" title={name}>
                  {name.split('/').pop()}
                </span>
                <span className="search-dir">{name.split('/').slice(0, -1).join('/')}</span>
                <span className="search-group-count">{ms.length}</span>
              </div>
              {!folded &&
                ms.map((m, i) => (
                  <div key={i} className="search-match" onClick={() => onOpen(m.path, m.line, m.column)}>
                    <span className="search-ln">{m.line}</span>
                    <span className="search-text">
                      {m.text.slice(0, m.start)}
                      <mark className="search-hit">{m.text.slice(m.start, m.start + Math.max(1, m.length))}</mark>
                      {m.text.slice(m.start + Math.max(1, m.length))}
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
