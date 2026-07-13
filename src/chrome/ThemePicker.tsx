import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { THEMES } from '../editor/themes'

/// A compact theme menu for the status bar: a swatch button that opens a
/// popover list of the built-in themes. The list renders in a portal with fixed
/// positioning so the scrolling status bar cannot clip it.
export function ThemePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const current = THEMES.find((theme) => theme.id === value) ?? THEMES[0]

  useEffect(() => {
    if (!open) return
    const onDocument = (event: MouseEvent) => {
      const target = event.target as Node
      if (buttonRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDocument)
    return () => document.removeEventListener('mousedown', onDocument)
  }, [open])

  const toggle = () => {
    if (!open && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      // Anchor the menu just above the button, right-aligned to it.
      setPos({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 8 })
    }
    setOpen((previous) => !previous)
  }

  return (
    <div className="theme-picker">
      <button ref={buttonRef} className="theme-button" onClick={toggle}>
        <span className={`theme-swatch ${current.type}`} />
        {current.name}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="theme-menu"
            role="menu"
            ref={menuRef}
            style={{ right: pos.right, bottom: pos.bottom }}
          >
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                className={`theme-option ${theme.id === value ? 'active' : ''}`}
                onClick={() => {
                  onChange(theme.id)
                  setOpen(false)
                }}
              >
                <span className={`theme-swatch ${theme.type}`} />
                {theme.name}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  )
}
