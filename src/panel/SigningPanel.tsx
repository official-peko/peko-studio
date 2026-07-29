/// The Signing tab: one sub-tab per target platform, each showing what that
/// platform has and what it still needs.
///
/// Replaces a grid of cards that showed every platform's drop zone, password
/// fields, and actions at once. That made a project with five targets a wall of
/// controls where the one thing needing attention was not obvious.
///
/// Two ideas carry the layout:
///
///   - The sub-tab strip is the status display. A platform that cannot ship
///     without keys and has none is marked, so the tab strip alone says whether
///     there is anything to do.
///   - A platform shows one thing at a time. Normally that is what is
///     registered. Adding, generating, or removing replaces the body with a
///     single-purpose form and returns when it finishes, so the drop zone is
///     only present when the user asked to add something.
import { useEffect, useRef, useState } from 'react'
import { peko } from '@peko/client'

import type { PlatformSigning } from './types'
import {
  DROP_ACCEPT,
  DROP_HINT,
  GENERATABLE_PLATFORMS,
  PASSWORDS_FOR_ROLE,
  PLATFORM_LABEL,
  PLATFORM_NEEDS,
  ROLE_LABEL,
  fileToBase64,
  needsAttention,
  roleForDrop,
  stateSummary,
} from './signingShared'

/// What the body of a platform tab is currently showing.
type Mode = 'view' | 'add' | 'generate' | 'remove'

export function SigningView({
  platforms,
  signing,
  refresh,
}: {
  platforms: string[]
  signing: PlatformSigning[]
  refresh: () => Promise<void>
}) {
  const byPlatform = new Map(signing.map((s) => [s.platform, s]))
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (platforms.length === 0) {
    return <div className="brpanel-empty">No platforms declared in peko.toml.</div>
  }

  // Open on whatever needs attention, so the tab lands on the problem rather
  // than on whichever platform happens to be first.
  const current =
    active && platforms.includes(active)
      ? active
      : platforms.find((p) => needsAttention(byPlatform.get(p)?.state)) ?? platforms[0]

  return (
    <div className="signing-panel">
      <div className="signing-tabs">
        {platforms.map((platform) => {
          const report = byPlatform.get(platform)
          const attention = needsAttention(report?.state)
          return (
            <button
              key={platform}
              type="button"
              className={`signing-tab${platform === current ? ' active' : ''}`}
              onClick={() => setActive(platform)}
            >
              {PLATFORM_LABEL[platform] ?? platform}
              {attention && <span className="signing-dot" title="Needs signing keys" />}
            </button>
          )
        })}
      </div>
      <PlatformPane
        key={current}
        platform={current}
        report={byPlatform.get(current)}
        refresh={refresh}
      />
    </div>
  )
}


/// The frame every mode shares: a title, one line explaining it, the body, and
/// the actions along the bottom. Having one shape means switching modes changes
/// the content rather than the layout.
function Pane({
  title,
  lead,
  children,
  actions,
  note,
}: {
  title: string
  lead?: string
  children?: React.ReactNode
  actions?: React.ReactNode
  note?: { text: string; failed?: boolean } | null
}) {
  return (
    <div className="signing-pane">
      <header className="signing-pane-head">
        <h3>{title}</h3>
        {lead && <p>{lead}</p>}
      </header>
      {children && <div className="signing-pane-body">{children}</div>}
      {note && (
        <pre className={`signing-note${note.failed ? ' failed' : ''}`}>{note.text}</pre>
      )}
      {actions && <footer className="signing-pane-actions">{actions}</footer>}
    </div>
  )
}

function PlatformPane({
  platform,
  report,
  refresh,
}: {
  platform: string
  report: PlatformSigning | undefined
  refresh: () => Promise<void>
}) {
  const [mode, setMode] = useState<Mode>('view')
  const [note, setNote] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const state = report?.state ?? 'missing'

  // Linux has no signing model, so it gets an explanation and nothing else.
  if (state === 'not_required' || !DROP_ACCEPT[platform]) {
    return (
      <Pane
        title={`${PLATFORM_LABEL[platform] ?? platform} apps are not code signed`}
        lead={`There is nothing to set up. ${PLATFORM_LABEL[platform] ?? platform} builds are distributed without a signature.`}
      />
    )
  }

  const done = async (message: string | null, isFailure = false) => {
    setNote(message)
    setFailed(isFailure)
    if (!isFailure) setMode('view')
    await refresh()
  }

  if (mode === 'add') {
    return <AddFileForm platform={platform} onDone={done} onCancel={() => setMode('view')} />
  }
  if (mode === 'generate') {
    return <GenerateForm platform={platform} onDone={done} onCancel={() => setMode('view')} />
  }
  if (mode === 'remove') {
    return <RemoveForm platform={platform} onDone={done} onCancel={() => setMode('view')} />
  }

  const registered = (report?.checks ?? []).filter((check) => check.file)
  const hasAnything = registered.length > 0
  const problems = (report?.checks ?? []).filter((check) => !check.ok && !check.file)

  return (
    <Pane
      title={stateSummary(platform, state)}
      lead={hasAnything ? undefined : PLATFORM_NEEDS[platform]}
      note={note ? { text: note, failed } : null}
      actions={
        <>
          <button type="button" onClick={() => setMode('add')}>
            {hasAnything ? 'Replace a file' : 'Add a file'}
          </button>
          {GENERATABLE_PLATFORMS.includes(platform) && (
            <button type="button" onClick={() => setMode('generate')}>
              {platform === 'android' ? 'Create a keystore' : 'Create a signing request'}
            </button>
          )}
          {hasAnything && (
            <button type="button" className="signing-danger" onClick={() => setMode('remove')}>
              Remove
            </button>
          )}
        </>
      }
    >
      {hasAnything && (
        <ul className="signing-files">
          {registered.map((check, i) => (
            <li key={`${check.role}-${i}`} className={check.ok ? 'ok' : 'bad'}>
              <span className="signing-file-role">{ROLE_LABEL[check.role] ?? check.role}</span>
              <span className="signing-file-name">{check.file}</span>
              <span className="signing-file-detail">{check.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {/* Something registered but not working is why this platform cannot sign,
          so it is stated rather than left in the list. */}
      {problems.map((check, i) => (
        <p key={i} className="signing-sub warn">
          {check.detail}
        </p>
      ))}
    </Pane>
  )
}

/// Adding a key file: choose it, then give the password it needs.
///
/// The password lives here rather than on the summary view because it only
/// means anything next to a file. Asking for it at the moment the file is
/// chosen also names which password is wanted, which a standing row of fields
/// could not.
function AddFileForm({
  platform,
  onDone,
  onCancel,
}: {
  platform: string
  onDone: (message: string | null, failed?: boolean) => Promise<void>
  onCancel: () => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [role, setRole] = useState<string | null>(null)
  const [passwords, setPasswords] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  // macOS takes two certificates that are both .p12, so the installer one
  // cannot be told apart by its extension and has to be chosen.
  const [asInstaller, setAsInstaller] = useState(false)

  const choose = (picked: File) => {
    setError(null)
    const detected = asInstaller ? 'installer-p12' : roleForDrop(platform, picked.name)
    if (!detected) {
      setError(`${picked.name} is not a ${PLATFORM_LABEL[platform] ?? platform} signing file.`)
      return
    }
    setFile(picked)
    setRole(detected)
  }

  const needed = role ? (PASSWORDS_FOR_ROLE[role] ?? []) : []
  const ready = file && needed.every((n) => passwords[n.role])

  const submit = async () => {
    if (!file || !role) return
    setBusy(true)
    setError(null)
    try {
      const data = await fileToBase64(file)
      const res = (await peko.invoke('ide.signing.install', {
        platform,
        role,
        filename: file.name,
        data,
      })) as { ok?: boolean }
      if (!res.ok) {
        setError(`Could not add ${file.name}.`)
        setBusy(false)
        return
      }
      // Passwords are stored after the file lands, so a failed install does not
      // leave a password for something that is not there.
      for (const { role: secretRole } of needed) {
        await peko.invoke('ide.signing.set_password', {
          platform,
          role: secretRole,
          password: passwords[secretRole],
        })
      }
      await onDone(`Added ${file.name}.`)
    } catch (err) {
      setError(String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Pane
      title={file ? 'Confirm this file' : 'Add a signing file'}
      lead={
        file
          ? needed.length > 0
            ? 'This file needs a password to be used.'
            : 'This file does not need a password.'
          : PLATFORM_NEEDS[platform]
      }
      note={error ? { text: error, failed: true } : null}
      actions={
        <>
          {file && (
            <button type="button" disabled={busy || !ready} onClick={() => void submit()}>
              {busy ? 'Adding...' : 'Add file'}
            </button>
          )}
          {file && !busy && (
            <button
              type="button"
              onClick={() => {
                setFile(null)
                setRole(null)
              }}
            >
              Choose another
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      }
    >
      {!file && platform === 'macos' && (
        <label className="signing-check-row">
          <input
            type="checkbox"
            checked={asInstaller}
            onChange={(e) => setAsInstaller(e.target.checked)}
          />
          This is the installer certificate, for the App Store .pkg
        </label>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={DROP_ACCEPT[platform] ?? ''}
        style={{ display: 'none' }}
        onChange={(e) => {
          const picked = e.target.files?.[0]
          if (picked) choose(picked)
          e.target.value = ''
        }}
      />

      {!file ? (
        <button
          type="button"
          className={`signing-dropzone${dragOver ? ' active' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const dropped = e.dataTransfer.files[0]
            if (dropped) choose(dropped)
          }}
        >
          {DROP_HINT[platform] ?? 'Drop a file, or click to browse'}
        </button>
      ) : (
        <>
          <div className="signing-chosen">
            <span className="signing-file-role">{ROLE_LABEL[role ?? ''] ?? role}</span>
            <span className="signing-file-name">{file.name}</span>
          </div>
          {needed.length > 0 && (
            <div className="signing-form">
              {needed.map(({ role: secretRole, label }) => (
                <label key={secretRole}>
                  {label}
                  <input
                    type="password"
                    autoFocus={secretRole === needed[0].role}
                    value={passwords[secretRole] ?? ''}
                    onChange={(e) =>
                      setPasswords((prev) => ({ ...prev, [secretRole]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && ready) void submit()
                    }}
                  />
                </label>
              ))}
            </div>
          )}
        </>
      )}
    </Pane>
  )
}

/// The single-purpose form for creating new key material.
function GenerateForm({
  platform,
  onDone,
  onCancel,
}: {
  platform: string
  onDone: (message: string | null, failed?: boolean) => Promise<void>
  onCancel: () => void
}) {
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cerRef = useRef<HTMLInputElement>(null)
  const isApple = platform === 'ios' || platform === 'macos'

  const run = async (method: string, params: Record<string, unknown>) => {
    setBusy(true)
    setError(null)
    try {
      const res = (await peko.invoke(method, params)) as
        | { ok?: boolean; output?: string; csr?: string }
        | null
      // The CLI runs with --json, one event per line. Only the human sentences
      // are shown; a line that does not parse is plumbing, not something to act
      // on.
      const events = (res?.output ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { type?: string; message?: string }
          } catch {
            return { type: 'output' as const, message: undefined }
          }
        })
      const failure = events.find((e) => e.type === 'error')
      const messages = events
        .filter((e) => e.message && e.type !== 'output')
        .map((e) => e.message as string)
        .join('\n')
      if (failure) {
        setError(messages || 'That did not work.')
        setBusy(false)
        return
      }
      // A generated request is only useful if the user can get to it.
      if (res?.csr) void peko.invoke('ide.reveal', { path: res.csr })
      await onDone(messages || 'Done.')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Pane
      title={platform === 'android' ? 'Create a keystore' : 'Create a signing request'}
      lead={
        platform === 'android'
          ? 'Back this file up once it exists. Google Play ties your app to it, and updates cannot be signed with a different one.'
          : 'This makes a request you upload to Apple. Apple sends back a certificate, which you bring back here.'
      }
      note={error ? { text: error, failed: true } : null}
      actions={
        <>
          <button
            type="button"
            disabled={busy || !password || (isApple && !email)}
            onClick={() =>
              void run('ide.keys.generate', {
                platform: isApple ? 'apple' : 'android',
                password,
                email,
              })
            }
          >
            {busy ? 'Working...' : platform === 'android' ? 'Create keystore' : 'Create request'}
          </button>
          {isApple && (
            <button
              type="button"
              disabled={busy || !password}
              onClick={() => cerRef.current?.click()}
            >
              I have the .cer from Apple
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      }
    >
      {isApple && (
        <ol className="signing-steps">
          <li>Fill in the fields below and create the request.</li>
          <li>Upload it at developer.apple.com, under Certificates.</li>
          <li>Download the .cer Apple issues, then choose it here.</li>
        </ol>
      )}

      <div className="signing-form">
        <label>
          Password for the new key
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {isApple && (
          <label>
            Your Apple ID email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        )}
      </div>

      {isApple && (
        <input
          ref={cerRef}
          type="file"
          accept=".cer"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0] as (File & { path?: string }) | undefined
            // The CLI reads the certificate from disk, so the path crosses the
            // bridge rather than the bytes.
            if (file?.path) void run('ide.keys.p12', { platform, cer: file.path, password })
            else if (file) setError('Could not read that file path. Use the CLI for this step.')
            e.target.value = ''
          }}
        />
      )}
    </Pane>
  )
}

/// The single-purpose confirmation for deleting key material.
function RemoveForm({
  platform,
  onDone,
  onCancel,
}: {
  platform: string
  onDone: (message: string | null, failed?: boolean) => Promise<void>
  onCancel: () => void
}) {
  const [busy, setBusy] = useState(false)
  const isApple = platform === 'ios' || platform === 'macos'

  const remove = async (target: string) => {
    setBusy(true)
    try {
      await peko.invoke('ide.keys.remove', { platform: target })
      await onDone(`Removed ${PLATFORM_LABEL[target] ?? target} keys.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Pane
      title="Remove signing keys"
      lead={
        platform === 'android'
          ? 'This deletes the keystore and its passwords. If your app is already on Google Play, you will never be able to update it again.'
          : 'This deletes the registered files and their stored passwords.'
      }
      actions={
        <>
          <button
            type="button"
            className="signing-danger"
            disabled={busy}
            onClick={() => void remove(platform)}
          >
            Delete {PLATFORM_LABEL[platform] ?? platform} keys
          </button>
          {isApple && (
            <button
              type="button"
              className="signing-danger"
              disabled={busy}
              onClick={() => void remove('apple')}
            >
              Delete the signing request too
            </button>
          )}
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </>
      }
    />
  )
}
