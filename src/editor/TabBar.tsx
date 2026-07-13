import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import type { Tab } from '../ide/workspace'
import { FileIcon } from './FileIcon'

interface TabMenu {
  path: string
  index: number
  x: number
  y: number
}

/// The open-file tab strip. Click a tab to activate it, click the close glyph
/// or middle-click to close it, drag to reorder, and right-click for tab
/// management actions.
export function TabBar({
  tabs,
  activePath,
  dirtyPaths,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onCloseAll,
  onReorder,
}: {
  tabs: Tab[]
  activePath: string | null
  dirtyPaths: Set<string>
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onCloseOthers: (path: string) => void
  onCloseToRight: (path: string) => void
  onCloseToLeft: (path: string) => void
  onCloseAll: () => void
  onReorder: (fromPath: string, toPath: string) => void
}) {
  const [menu, setMenu] = useState<TabMenu | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Translate a vertical mouse wheel into horizontal scrolling so a mouse can
  // reach overflowed tabs. A trackpad's native horizontal delta is left alone.
  const onWheel = (event: ReactWheelEvent) => {
    const bar = barRef.current
    if (!bar || bar.scrollWidth <= bar.clientWidth) return
    if (event.deltaX === 0 && event.deltaY !== 0) {
      bar.scrollLeft += event.deltaY
    }
  }

  useEffect(() => {
    if (!menu) return
    // Close on an outside mousedown only; a click inside the menu must reach the
    // item's onClick before the menu unmounts.
    const onMouseDown = (event: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(event.target as Node)) return
      setMenu(null)
    }
    const onScroll = () => setMenu(null)
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('scroll', onScroll, true)
    }
  }, [menu])

  const onAuxClick = (event: ReactMouseEvent, path: string) => {
    if (event.button === 1) {
      event.preventDefault()
      onClose(path)
    }
  }

  const onContextMenu = (event: ReactMouseEvent, path: string, index: number) => {
    event.preventDefault()
    setMenu({ path, index, x: event.clientX, y: event.clientY })
  }

  const onDragStart = (event: ReactDragEvent, path: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', path)
  }

  const onDrop = (event: ReactDragEvent, toPath: string) => {
    event.preventDefault()
    const fromPath = event.dataTransfer.getData('text/plain')
    if (fromPath) onReorder(fromPath, toPath)
    setDragOver(null)
  }

  const run = (action: () => void) => {
    action()
    setMenu(null)
  }

  return (
    <div className="tabbar" data-peko-no-drag ref={barRef} onWheel={onWheel}>
      {tabs.map((tab, index) => (
        <div
          key={tab.path}
          className={`tab ${tab.path === activePath ? 'active' : ''} ${
            dragOver === tab.path ? 'drag-over' : ''
          }`}
          draggable
          onDragStart={(event) => onDragStart(event, tab.path)}
          onDragOver={(event) => {
            event.preventDefault()
            setDragOver(tab.path)
          }}
          onDragLeave={() => setDragOver((current) => (current === tab.path ? null : current))}
          onDrop={(event) => onDrop(event, tab.path)}
          onClick={() => onActivate(tab.path)}
          onAuxClick={(event) => onAuxClick(event, tab.path)}
          onContextMenu={(event) => onContextMenu(event, tab.path, index)}
          title={tab.path}
        >
          <span className="tab-icon">
            <FileIcon name={tab.name} />
          </span>
          <span className="tab-name">{tab.name}</span>
          <button
            className={`tab-close ${dirtyPaths.has(tab.path) ? 'dirty' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onClose(tab.path)
            }}
            aria-label={`Close ${tab.name}`}
          >
            <span className="tab-close-x">×</span>
            <span className="tab-dirty-dot" />
          </button>
        </div>
      ))}

      {menu &&
        createPortal(
        <div ref={menuRef} className="tab-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button className="tab-menu-item" onClick={() => run(() => onClose(menu.path))}>
            Close
          </button>
          <button
            className="tab-menu-item"
            disabled={tabs.length <= 1}
            onClick={() => run(() => onCloseOthers(menu.path))}
          >
            Close Others
          </button>
          <button
            className="tab-menu-item"
            disabled={menu.index >= tabs.length - 1}
            onClick={() => run(() => onCloseToRight(menu.path))}
          >
            Close to the Right
          </button>
          <button
            className="tab-menu-item"
            disabled={menu.index <= 0}
            onClick={() => run(() => onCloseToLeft(menu.path))}
          >
            Close to the Left
          </button>
          <div className="tab-menu-sep" />
          <button className="tab-menu-item" onClick={() => run(onCloseAll)}>
            Close All
          </button>
        </div>,
          document.body,
        )}
    </div>
  )
}
