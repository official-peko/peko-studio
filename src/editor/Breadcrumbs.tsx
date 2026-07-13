import { Fragment, useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import type { LspDocumentSymbol } from '../lsp/pekoLsp'
import { getDocumentSymbols } from './builtinLanguages'

// LSP SymbolKind -> a css class used to tint the breadcrumb / dropdown item.
const KIND_CLASS: Record<number, string> = {
  2: 'namespace',
  3: 'namespace',
  5: 'class',
  6: 'method',
  9: 'method',
  10: 'enum',
  11: 'interface',
  12: 'function',
  13: 'variable',
  22: 'enumMember',
  23: 'class',
}

type LspRangeLike = LspDocumentSymbol['range']

function contains(range: LspRangeLike, line: number, col: number): boolean {
  const afterStart =
    line > range.start.line || (line === range.start.line && col >= range.start.character)
  const beforeEnd = line < range.end.line || (line === range.end.line && col <= range.end.character)
  return afterStart && beforeEnd
}

interface Level {
  list: LspDocumentSymbol[]
  chosen: LspDocumentSymbol
}

/// The chain of levels containing the cursor. Each level carries the list of
/// symbols at that depth (for the dropdown) and the one the cursor is in.
function pathLevels(symbols: LspDocumentSymbol[], line: number, col: number): Level[] {
  const levels: Level[] = []
  let list = symbols
  for (;;) {
    const chosen = list.find((symbol) => contains(symbol.range, line, col))
    if (!chosen) break
    levels.push({ list, chosen })
    list = chosen.children ?? []
  }
  return levels
}

/// A breadcrumb bar. Each crumb (including the file) opens a dropdown of the
/// symbols at that level; picking one jumps to it.
export function Breadcrumbs({
  editor,
  file,
}: {
  editor: monaco.editor.IStandaloneCodeEditor
  file: string
}) {
  const [symbols, setSymbols] = useState<LspDocumentSymbol[]>([])
  const [levels, setLevels] = useState<Level[]>([])
  // The open dropdown, if any: which crumb and the viewport coordinates to
  // anchor the menu at. Fixed positioning keeps it clear of the breadcrumb
  // bar's overflow clip.
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  // Fetch the symbol tree on edits, retrying while empty (the file may not be
  // analyzed yet just after it opens).
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let attempt = 0
    const refresh = async () => {
      const model = editor.getModel()
      if (!model) return
      const next = await getDocumentSymbols(model)
      if (cancelled) return
      setSymbols(next)
      if (next.length === 0 && attempt < 8) {
        attempt += 1
        timer = window.setTimeout(() => void refresh(), 400 * attempt)
      }
    }
    void refresh()
    const sub = editor.getModel()?.onDidChangeContent(() => {
      if (timer) window.clearTimeout(timer)
      attempt = 0
      timer = window.setTimeout(() => void refresh(), 400)
    })
    return () => {
      cancelled = true
      if (timer) window.clearTimeout(timer)
      sub?.dispose()
    }
    // `file` changes when the active tab switches; re-subscribe to the new model.
  }, [editor, file])

  // Recompute the path on cursor move and when the symbols change.
  useEffect(() => {
    const update = () => {
      const pos = editor.getPosition()
      setLevels(pos ? pathLevels(symbols, pos.lineNumber - 1, pos.column - 1) : [])
    }
    update()
    const sub = editor.onDidChangeCursorPosition(update)
    return () => sub.dispose()
  }, [editor, symbols])

  // Close an open dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onDocument = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(null)
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  const jump = (symbol: LspDocumentSymbol) => {
    const position = {
      lineNumber: symbol.selectionRange.start.line + 1,
      column: symbol.selectionRange.start.character + 1,
    }
    editor.revealPositionInCenter(position)
    editor.setPosition(position)
    editor.focus()
    setOpen(null)
  }

  const renderCrumb = (
    index: number,
    label: string,
    className: string,
    items: LspDocumentSymbol[],
  ) => (
    <span className="crumb-wrap">
      <button
        className={`crumb ${className}`}
        onClick={(event) => {
          if (open?.index === index) {
            setOpen(null)
            return
          }
          const rect = event.currentTarget.getBoundingClientRect()
          setOpen({ index, x: rect.left, y: rect.bottom + 4 })
        }}
      >
        {label}
      </button>
      {open?.index === index && items.length > 0 && (
        <div className="crumb-menu" role="menu" style={{ left: open.x, top: open.y }}>
          {items.map((symbol, position) => (
            <button
              key={`${symbol.name}-${position}`}
              className={`crumb-option crumb-${KIND_CLASS[symbol.kind] ?? 'variable'}`}
              onClick={() => jump(symbol)}
            >
              {symbol.name}
            </button>
          ))}
        </div>
      )}
    </span>
  )

  return (
    <div className="breadcrumbs" ref={ref}>
      {renderCrumb(-1, file, 'crumb-file', symbols)}
      {levels.map((level, index) => (
        <Fragment key={`${level.chosen.name}-${index}`}>
          <span className="crumb-sep">›</span>
          {renderCrumb(
            index,
            level.chosen.name,
            `crumb-${KIND_CLASS[level.chosen.kind] ?? 'variable'}`,
            level.list,
          )}
        </Fragment>
      ))}
    </div>
  )
}
