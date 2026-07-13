import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  accountStatus,
  accountLogin,
  accountRefresh,
  accountLogout,
  onAccountChanged,
  type Identity,
} from './account'

// Account control in the status bar. Reuses the peko CLI session: signed out
// shows a "Sign in" chip that starts the browser flow; signed in shows the
// avatar + name and a popover with email/role/tier, Refresh, and Sign out. The
// startup state comes from a cached identity, so it never prompts for a keychain
// password on its own.
export function AccountChip() {
  const [identity, setIdentity] = useState<Identity>({ authenticated: false })
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void accountStatus().then(setIdentity)
    const off = onAccountChanged((next) => {
      setIdentity(next)
      setBusy(false)
    })
    return off
  }, [])

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
      setPos({ right: window.innerWidth - rect.right, bottom: window.innerHeight - rect.top + 8 })
    }
    setOpen((previous) => !previous)
  }

  const signIn = () => {
    setBusy(true)
    void accountLogin()
  }
  const refresh = () => {
    setBusy(true)
    void accountRefresh()
  }
  const signOut = () => {
    setOpen(false)
    void accountLogout().then(setIdentity)
  }

  const authed = identity.authenticated
  const label = busy ? 'Signing in...' : authed ? identity.name || identity.email || 'Account' : 'Sign in'

  return (
    <div className="account-chip">
      <button ref={buttonRef} className="account-btn" title="Peko account" onClick={toggle}>
        <span className="account-avatar" aria-hidden="true">
          {authed ? <Avatar identity={identity} /> : <PersonGlyph />}
        </span>
        <span className="account-name">{label}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="account-menu" role="menu" ref={menuRef} style={{ right: pos.right, bottom: pos.bottom }}>
            {authed ? (
              <>
                <div className="account-menu-user">
                  <span className="account-avatar lg" aria-hidden="true">
                    <Avatar identity={identity} />
                  </span>
                  <div className="account-menu-id">
                    <div className="account-menu-title">{identity.name || 'Signed in'}</div>
                    {identity.email && <div className="account-menu-note">{identity.email}</div>}
                  </div>
                </div>
                {(identity.role || identity.tier) && (
                  <div className="account-menu-tags">
                    {identity.role && <span className="account-tag">{identity.role}</span>}
                    {identity.tier && <span className="account-tag">{identity.tier}</span>}
                  </div>
                )}
                <button type="button" className="account-menu-line" onClick={refresh} disabled={busy}>
                  Refresh
                </button>
                <button type="button" className="account-menu-line danger" onClick={signOut}>
                  Sign out
                </button>
              </>
            ) : (
              <>
                <div className="account-menu-title">Peko account</div>
                <div className="account-menu-note">
                  Sign in to publish packages and use platform features. Opens your browser.
                </div>
                <button type="button" className="account-menu-action" onClick={signIn} disabled={busy}>
                  {busy ? 'Waiting for browser...' : 'Sign in'}
                </button>
                <button type="button" className="account-menu-line" onClick={refresh} disabled={busy}>
                  Already signed in with the CLI? Check now
                </button>
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  )
}

function Avatar({ identity }: { identity: Identity }) {
  const [broken, setBroken] = useState(false)
  if (identity.photoUrl && !broken) {
    return <img className="account-photo" src={identity.photoUrl} alt="" onError={() => setBroken(true)} />
  }
  return <span className="account-initials">{initials(identity.name || identity.email)}</span>
}

function initials(source: string | undefined): string {
  if (!source) return '?'
  const parts = source.trim().split(/[\s@._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

function PersonGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" strokeLinecap="round" />
    </svg>
  )
}
