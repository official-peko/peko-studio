import { useState } from 'react'
import { peko } from '@peko/client'

// Confirms and performs a full uninstall of Peko: deletes ~/.Peko (the CLI, SDK,
// toolchains, and global packages) via ide.uninstall. Projects are untouched.
export function UninstallDialog({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function uninstall() {
    setBusy(true)
    setError(null)
    try {
      const res = (await peko.invoke('ide.uninstall', {})) as { ok?: boolean; output?: string }
      if (res.ok) setDone(true)
      else setError(res.output || 'Could not uninstall Peko.')
    } catch {
      setError('No native bridge.')
    }
    setBusy(false)
  }

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div className="settings-card" role="dialog" aria-label="Uninstall Peko">
        <div className="settings-head">
          <h2>Uninstall Peko</h2>
          <button
            type="button"
            className="settings-x"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            &times;
          </button>
        </div>
        <div className="settings-body">
          {done ? (
            <>
              <p>
                Peko has been removed. Reinstall it any time from <b>Peko &rsaquo; Update Peko CLI</b>.
                Building is unavailable until then.
              </p>
              <div className="setup-actions-row">
                <button type="button" className="modal-btn" onClick={onClose}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                This permanently deletes the entire Peko installation (<code>~/.Peko</code>): the CLI,
                the standard library, every platform toolchain, and your global packages. Your projects
                are not touched. You will need to reinstall Peko before you can build again.
              </p>
              {error && <div className="setup-error">{error}</div>}
              <div className="setup-actions-row">
                <button type="button" className="modal-btn" onClick={onClose} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="modal-btn danger" onClick={uninstall} disabled={busy}>
                  {busy ? 'Removing…' : 'Uninstall Peko'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
