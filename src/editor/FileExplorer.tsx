import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { peko } from '@peko/client'
import {
  listDir,
  createFile,
  makeDir,
  rename,
  remove,
  trash,
  revealInFinder,
  parentDir,
  joinPath,
  setWatchedDirs,
  type DirEntry,
} from '../ide/workspace'
import { FileIcon } from './FileIcon'

interface CtxMenu {
  x: number
  y: number
  // The entry the menu was opened on, or null for the empty area (root).
  entry: DirEntry | null
}

type Modal =
  | { kind: 'name'; mode: 'file' | 'folder' | 'rename'; dir: string; original?: string; value: string }
  | { kind: 'confirm'; name: string; path: string }

// The single-letter badge shown for each git status.
const GIT_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  untracked: 'U',
  deleted: 'D',
  renamed: 'R',
}

// The CSS class for a git status, or empty when the path is unchanged.
function gitClass(status: string | undefined): string {
  return status ? `git-${status}` : ''
}

function TreeNode({
  entry,
  depth,
  activePath,
  dirtyPaths,
  problemPaths,
  gitStatus,
  nonce,
  onOpen,
  onContext,
  onMove,
  onExpand,
}: {
  entry: DirEntry
  depth: number
  activePath: string | null
  dirtyPaths: Set<string>
  problemPaths: Map<string, 'error' | 'warning'>
  gitStatus: Map<string, string>
  nonce: number
  onOpen: (path: string) => void
  onContext: (x: number, y: number, entry: DirEntry) => void
  onMove: (fromPath: string, toDir: string) => Promise<void>
  onExpand: (path: string, expanded: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<DirEntry[] | null>(null)
  const [dropActive, setDropActive] = useState(false)
  const [dragging, setDragging] = useState(false)

  const reload = async () => setChildren(await listDir(entry.path))

  const toggle = async () => {
    if (!entry.dir) {
      onOpen(entry.path)
      return
    }
    const next = !expanded
    setExpanded(next)
    onExpand(entry.path, next)
    // Always re-fetch on expand so a folder never shows stale cached contents.
    if (next) await reload()
  }

  // Reload children when a refresh is requested (a file op elsewhere).
  useEffect(() => {
    if (entry.dir && expanded) void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce])

  const active = !entry.dir && entry.path === activePath
  return (
    <div className="tree-node">
      <div
        className={`tree-row ${active ? 'active' : ''} ${dropActive ? 'drop-active' : ''} ${
          dragging ? 'dragging' : ''
        }`}
        style={{ paddingLeft: 8 + depth * 12 }}
        draggable
        onDragStart={(event) => {
          event.stopPropagation()
          event.dataTransfer.setData('text/plain', entry.path)
          event.dataTransfer.effectAllowed = 'move'
          // A snapshot of the row follows the cursor so the file looks picked up.
          event.dataTransfer.setDragImage(
            event.currentTarget,
            event.nativeEvent.offsetX,
            event.nativeEvent.offsetY,
          )
          setDragging(true)
        }}
        onDragEnd={() => setDragging(false)}
        onDragOver={
          entry.dir
            ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                event.dataTransfer.dropEffect = 'move'
                setDropActive(true)
              }
            : undefined
        }
        onDragLeave={entry.dir ? () => setDropActive(false) : undefined}
        onDrop={
          entry.dir
            ? async (event) => {
                event.preventDefault()
                event.stopPropagation()
                setDropActive(false)
                const from = event.dataTransfer.getData('text/plain')
                if (!from) return
                await onMove(from, entry.path)
                // Open the destination and show the moved item immediately.
                setExpanded(true)
                await reload()
              }
            : undefined
        }
        onClick={toggle}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onContext(event.clientX, event.clientY, entry)
        }}
      >
        <span className="tree-caret">{entry.dir ? (expanded ? '▾' : '▸') : ''}</span>
        <span className="tree-icon">
          <FileIcon name={entry.name} dir={entry.dir} expanded={expanded} />
        </span>
        <span
          className={`tree-label ${problemPaths.get(entry.path) ?? gitClass(gitStatus.get(entry.path))}`}
        >
          {entry.name}
        </span>
        {!entry.dir && dirtyPaths.has(entry.path) && <span className="tree-dirty-dot" />}
        {gitStatus.get(entry.path) && !dirtyPaths.has(entry.path) && (
          <span className={`tree-git ${gitClass(gitStatus.get(entry.path))}`}>
            {GIT_LETTER[gitStatus.get(entry.path) as string] ?? ''}
          </span>
        )}
      </div>
      {entry.dir && expanded && children && (
        <div className="tree-children">
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              activePath={activePath}
              dirtyPaths={dirtyPaths}
              problemPaths={problemPaths}
              gitStatus={gitStatus}
              nonce={nonce}
              onOpen={onOpen}
              onContext={onContext}
              onMove={onMove}
              onExpand={onExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/// The workspace file tree with a context menu for file operations (new file,
/// new folder, rename, delete). Hard-coded to the project root.
export function FileExplorer({
  rootPath,
  activePath,
  dirtyPaths,
  problemPaths,
  gitStatus,
  revealLabel,
  onOpen,
  onPathRemoved,
}: {
  rootPath: string
  activePath: string | null
  dirtyPaths: Set<string>
  problemPaths: Map<string, 'error' | 'warning'>
  gitStatus: Map<string, string>
  // The platform-specific label for the reveal action (Finder/Explorer/Folder).
  revealLabel: string
  onOpen: (path: string) => void
  // A path that no longer exists (trashed, deleted, or renamed away); its tab
  // should close.
  onPathRemoved: (path: string) => void
}) {
  const [roots, setRoots] = useState<DirEntry[]>([])
  const [nonce, setNonce] = useState(0)
  const [menu, setMenu] = useState<CtxMenu | null>(null)
  const [modal, setModal] = useState<Modal | null>(null)
  const [collapseNonce, setCollapseNonce] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = () => setNonce((value) => value + 1)

  // The directories the tree has expanded, watched for structural changes.
  const expandedDirs = useRef(new Set<string>())
  const pushWatchedDirs = () => setWatchedDirs([rootPath, ...expandedDirs.current])
  const handleExpand = (path: string, expanded: boolean) => {
    if (expanded) expandedDirs.current.add(path)
    else expandedDirs.current.delete(path)
    pushWatchedDirs()
  }

  // Collapse every expanded folder: remount the tree so each node resets to its
  // collapsed initial state, and drop the watched-dir set to the root.
  const collapseAll = () => {
    expandedDirs.current.clear()
    pushWatchedDirs()
    setCollapseNonce((value) => value + 1)
  }

  // Create a file or folder at the root from the toolbar.
  const createAtRoot = (mode: 'file' | 'folder') => {
    setMenu(null)
    setModal({ kind: 'name', mode, dir: rootPath, value: '' })
  }

  const copyText = (text: string) => {
    void navigator.clipboard?.writeText(text)
    setMenu(null)
  }

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const entries = await listDir()
      if (!cancelled) setRoots(entries)
    })()
    return () => {
      cancelled = true
    }
  }, [nonce])

  // Watch the root, and refresh the tree when the host reports a structural
  // change or the window regains focus.
  useEffect(() => {
    pushWatchedDirs()
    const off = peko.on('ide.fs.tree', () => refresh())
    const onFocus = () => refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      off?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootPath])

  useEffect(() => {
    if (!menu) return
    const onDown = (event: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return
      setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  // Focus and select only when the name modal opens, not on every keystroke
  // (re-selecting on each change would make each character replace the text).
  const nameModalOpen = modal?.kind === 'name'
  useEffect(() => {
    if (nameModalOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [nameModalOpen])

  const targetDir = (entry: DirEntry | null): string => {
    if (!entry) return rootPath
    return entry.dir ? entry.path : parentDir(entry.path)
  }

  const startCreate = (mode: 'file' | 'folder') => {
    if (!menu) return
    setModal({ kind: 'name', mode, dir: targetDir(menu.entry), value: '' })
    setMenu(null)
  }

  const startRename = () => {
    if (!menu?.entry) return
    setModal({
      kind: 'name',
      mode: 'rename',
      dir: parentDir(menu.entry.path),
      original: menu.entry.path,
      value: menu.entry.name,
    })
    setMenu(null)
  }

  const doTrash = async () => {
    if (!menu?.entry) return
    const path = menu.entry.path
    setMenu(null)
    if (await trash(path)) onPathRemoved(path)
    refresh()
  }

  const startDelete = () => {
    if (!menu?.entry) return
    setModal({ kind: 'confirm', name: menu.entry.name, path: menu.entry.path })
    setMenu(null)
  }

  const submitName = async () => {
    if (modal?.kind !== 'name') return
    const name = modal.value.trim()
    if (!name) {
      setModal(null)
      return
    }
    const path = joinPath(modal.dir, name)
    if (modal.mode === 'file') {
      if (await createFile(path)) onOpen(path)
    } else if (modal.mode === 'folder') {
      await makeDir(path)
    } else if (modal.original) {
      // The old path is gone; close its tab (the renamed file can be reopened).
      if (await rename(modal.original, path)) onPathRemoved(modal.original)
    }
    setModal(null)
    refresh()
  }

  const confirmDelete = async () => {
    if (modal?.kind !== 'confirm') return
    const path = modal.path
    if (await remove(path)) onPathRemoved(path)
    setModal(null)
    refresh()
  }

  // Move a dragged file or directory into a target directory.
  const moveEntry = async (fromPath: string, toDir: string) => {
    const name = fromPath.split('/').pop() ?? fromPath
    const dest = joinPath(toDir, name)
    // No-op when dropped onto its own folder, itself, or a descendant.
    if (dest === fromPath || parentDir(fromPath) === toDir) return
    if (toDir === fromPath || toDir.startsWith(`${fromPath}/`)) return
    if (await rename(fromPath, dest)) onPathRemoved(fromPath)
    refresh()
  }

  const modalTitle =
    modal?.kind === 'name'
      ? modal.mode === 'file'
        ? 'New File'
        : modal.mode === 'folder'
          ? 'New Folder'
          : 'Rename'
      : ''

  return (
    <div
      className="tree"
      onContextMenu={(event) => {
        // Right-click in the empty area targets the root.
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY, entry: null })
      }}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(event) => {
        // A drop that reached the tree background moves to the project root.
        event.preventDefault()
        const from = event.dataTransfer.getData('text/plain')
        if (from && rootPath) moveEntry(from, rootPath)
      }}
    >
      <div className="explorer-toolbar">
        <span className="explorer-title">Explorer</span>
        <span className="explorer-tool-spacer" />
        <button className="explorer-tool" title="New File" onClick={() => createAtRoot('file')}>
          ＋
        </button>
        <button className="explorer-tool" title="New Folder" onClick={() => createAtRoot('folder')}>
          ⊞
        </button>
        <button className="explorer-tool" title="Collapse All" onClick={collapseAll}>
          ⊟
        </button>
        <button className="explorer-tool" title="Refresh" onClick={refresh}>
          ⟳
        </button>
      </div>
      {roots.map((entry) => (
        <TreeNode
          key={`${entry.path}:${collapseNonce}`}
          entry={entry}
          depth={0}
          activePath={activePath}
          dirtyPaths={dirtyPaths}
          problemPaths={problemPaths}
          gitStatus={gitStatus}
          nonce={nonce}
          onOpen={onOpen}
          onContext={(x, y, target) => setMenu({ x, y, entry: target })}
          onMove={moveEntry}
          onExpand={handleExpand}
        />
      ))}

      {menu &&
        createPortal(
          <div ref={menuRef} className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button className="ctx-item" onClick={() => startCreate('file')}>
              New File
            </button>
            <button className="ctx-item" onClick={() => startCreate('folder')}>
              New Folder
            </button>
            {menu.entry && (
              <>
                <div className="ctx-sep" />
                <button
                  className="ctx-item"
                  onClick={() => {
                    const path = menu.entry?.path
                    setMenu(null)
                    if (path) void revealInFinder(path)
                  }}
                >
                  {revealLabel}
                </button>
                <button
                  className="ctx-item"
                  onClick={() => menu.entry && copyText(menu.entry.path)}
                >
                  Copy Path
                </button>
                <button
                  className="ctx-item"
                  onClick={() =>
                    menu.entry &&
                    copyText(menu.entry.path.startsWith(`${rootPath}/`)
                      ? menu.entry.path.slice(rootPath.length + 1)
                      : menu.entry.path)
                  }
                >
                  Copy Relative Path
                </button>
                <div className="ctx-sep" />
                <button className="ctx-item" onClick={startRename}>
                  Rename
                </button>
                <button className="ctx-item" onClick={() => void doTrash()}>
                  Move to Trash
                </button>
                <button className="ctx-item danger" onClick={startDelete}>
                  Delete Permanently
                </button>
              </>
            )}
          </div>,
          document.body,
        )}

      {modal &&
        createPortal(
          <div className="modal-backdrop" onMouseDown={() => setModal(null)}>
            <div className="name-modal" onMouseDown={(event) => event.stopPropagation()}>
              {modal.kind === 'name' ? (
                <>
                  <div className="modal-title">{modalTitle}</div>
                  <input
                    ref={inputRef}
                    className="name-input"
                    value={modal.value}
                    onChange={(event) => setModal({ ...modal, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void submitName()
                      if (event.key === 'Escape') setModal(null)
                    }}
                    placeholder="name"
                  />
                  <div className="modal-actions">
                    <button className="modal-btn" onClick={() => setModal(null)}>
                      Cancel
                    </button>
                    <button className="modal-btn primary" onClick={() => void submitName()}>
                      OK
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="modal-title">Delete {modal.name} permanently?</div>
                  <div className="modal-sub">This cannot be undone.</div>
                  <div className="modal-actions">
                    <button className="modal-btn" onClick={() => setModal(null)}>
                      Cancel
                    </button>
                    <button className="modal-btn danger" onClick={() => void confirmDelete()}>
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
