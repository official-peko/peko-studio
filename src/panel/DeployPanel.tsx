/// The Deploy panel: link the project to a platform app, then deploy it.
///
/// Four states, driven by what the native layer reports rather than by local
/// guesses:
///
///   signed out   -> prompt to sign in (the app list needs a session)
///   unlinked     -> pick from the apps this account owns
///   linked       -> deploy buttons, gated by the app's capabilities
///   deploying    -> streamed log with a cancel button
///
/// Capabilities are fixed when an app is created on the platform, so a project
/// linked to an app without `distribution` can never deploy native binaries.
/// Saying that up front beats letting the CLI fail several minutes into a build.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { LogLine } from './types'

const peko = (window as any).peko

/// One app as the platform projects it. Everything past the id is optional: the
/// platform omits fields that an app's capabilities do not apply to.
export interface PlatformApp {
  id: string
  slug?: string | null
  displayName?: string | null
  capabilities?: { server?: boolean; distribution?: boolean }
  status?: string | null
  statusReason?: string | null
  framework?: string | null
  bundleId?: string | null
}

/// A per-platform signing report from `peko keys verify`.
interface SigningReport {
  platform: string
  /// not_required | optional | missing | invalid | unverified | valid
  state?: string
  /// required | optional | not_applicable — whether the platform must be signed
  /// to ship at all.
  requirement?: string
  checks?: { ok: boolean; label?: string }[]
}

type DeployKind = 'server' | 'app'

/// The outcome event the CLI emits at the end of a deploy.
interface DeployResult {
  ok: boolean
  kind?: string
  state?: string
  url?: string | null
  error?: string
}

export function appLabel(app: PlatformApp): string {
  return app.displayName?.trim() || app.slug?.trim() || app.id
}

/// The platforms that block a deploy for want of signing keys.
///
/// Only `deploy app` signs anything, so a server deploy is never gated on this.
///
/// Blocking is decided by the platform's REQUIREMENT, not merely by whether keys
/// are present. Windows Authenticode is optional — an unsigned .exe still ships
/// — and Linux AppImages have no signing model at all, so neither can hold up a
/// deploy. Only a platform the stores reject unsigned (Apple, Android) does.
///
/// A required platform with no report at all counts as blocking: absence of
/// evidence is not evidence of a key.
export function unsignedPlatforms(targets: string[], reports: SigningReport[]): string[] {
  return targets.filter((target) => {
    const report = reports.find((r) => r.platform === target)
    if (!report) {
      // No report: block only if this platform is one that must be signed.
      return target === 'ios' || target === 'macos' || target === 'android'
    }
    if (report.requirement && report.requirement !== 'required') return false
    // An older CLI sends no `requirement` and calls an unsigned Windows target
    // "missing", so the requirement check alone would let it block a deploy it
    // has no business blocking. These two states say the same thing on their
    // own — signing is a choice here, or does not exist — whatever the CLI's age.
    if (report.state === 'optional' || report.state === 'not_required') return false
    if (!report.requirement && target !== 'ios' && target !== 'macos' && target !== 'android') {
      return false
    }
    return report.state !== 'valid' && report.state !== 'unverified'
  })
}

interface Props {
  /// The platforms the project targets, from peko.toml.
  platforms: string[]
  /// Streamed deploy output, owned by the parent so it survives a tab switch.
  output: LogLine[]
  deploying: boolean
  onClear: () => void
  onStart: (kind: DeployKind) => void
  onStop: () => void
  result: DeployResult | null
}

export function DeployView({
  platforms,
  output,
  deploying,
  onClear,
  onStart,
  onStop,
  result,
}: Props) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [apps, setApps] = useState<PlatformApp[]>([])
  const [linkedId, setLinkedId] = useState<string | null>(null)
  const [linkedApp, setLinkedApp] = useState<PlatformApp | null>(null)
  const [linkProblem, setLinkProblem] = useState<string | null>(null)
  const [reports, setReports] = useState<SigningReport[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tailRef = useRef<HTMLDivElement | null>(null)

  const invoke = useCallback(async (method: string, params: unknown = {}) => {
    try {
      return await peko.invoke(method, params)
    } catch {
      return null
    }
  }, [])

  /// Load the link, then whatever that implies: the app's details when linked,
  /// the pickable list when not.
  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    setLinkProblem(null)
    const current = (await invoke('ide.apps.current')) as
      | { linked?: boolean; appId?: string | null }
      | null
    // An older installed CLI answers `peko link --json` with its human reply
    // wrapped as {type,message}, which parses but carries no `linked` field.
    // Left unchecked that reads as "not linked" and sends the user to re-link a
    // project that already is. Studio spawns whatever peko is installed, which
    // can lag behind the panel, so say what is actually wrong.
    if (current && typeof current.linked !== 'boolean') {
      setError('Your installed peko CLI is out of date. Reinstall it, then refresh.')
      setLoading(false)
      return
    }
    const id = current?.linked ? current.appId ?? null : null
    setLinkedId(id)

    if (id) {
      const shown = (await invoke('ide.apps.show', { appId: id })) as
        | { authenticated?: boolean; app?: PlatformApp | null; reason?: string }
        | null
      setAuthenticated(shown?.authenticated ?? null)
      setLinkedApp(shown?.app ?? null)
      if (shown && shown.app === null && shown.reason) {
        // A link can outlive the app it points at, or point at someone else's.
        // These need different remedies, so they are not collapsed.
        setLinkProblem(
          shown.reason === 'forbidden'
            ? 'This app belongs to another account. Sign in as its owner, or link to one of your apps.'
            : 'This app no longer exists. Link the project to another app.',
        )
      }
    } else {
      setLinkedApp(null)
    }

    const listed = (await invoke('ide.apps.list')) as
      | { authenticated?: boolean; apps?: PlatformApp[]; error?: string }
      | null
    if (listed && typeof listed.authenticated === 'boolean') {
      setAuthenticated(listed.authenticated)
      setApps(listed.apps ?? [])
      if (listed.error) setError(listed.error)
    } else if (listed) {
      // Same story as above: an older CLI has no `apps` subcommand, so the
      // reply is an error object rather than a list.
      setError('Your installed peko CLI is out of date. Reinstall it, then refresh.')
      setApps([])
    } else {
      setAuthenticated(false)
    }

    const signing = (await invoke('ide.signing.status')) as { reports?: SigningReport[] } | null
    setReports(signing?.reports ?? [])
    setLoading(false)
  }, [invoke])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Follow the log as it streams.
  useEffect(() => {
    tailRef.current?.scrollTo({ top: tailRef.current.scrollHeight })
  }, [output.length])

  const capabilities = linkedApp?.capabilities ?? {}
  const missingKeys = useMemo(
    () => unsignedPlatforms(platforms, reports),
    [platforms, reports],
  )

  const link = async (id: string) => {
    setLoading(true)
    await invoke('ide.apps.link', { appId: id })
    await refresh()
  }

  if (authenticated === null && loading) {
    return <div className="deploy-empty">Checking your account…</div>
  }

  if (authenticated === false) {
    return (
      <div className="deploy-empty">
        <p>Sign in to link this project to one of your apps.</p>
        <button
          className="deploy-primary"
          onClick={async () => {
            await invoke('ide.account.login')
            await refresh()
          }}
        >
          Sign in
        </button>
      </div>
    )
  }

  return (
    <div className="deploy-view">
      <div className="deploy-head">
        {linkedId && linkedApp ? (
          <>
            <span className="deploy-app">{appLabel(linkedApp)}</span>
            <span className="deploy-caps">
              {capabilities.server ? 'server' : null}
              {capabilities.server && capabilities.distribution ? ' · ' : null}
              {capabilities.distribution ? 'distribution' : null}
              {!capabilities.server && !capabilities.distribution ? 'cannot be deployed' : null}
            </span>
            <span className="spacer" />
            <button className="deploy-link-change" onClick={() => setLinkedId(null)}>
              Change
            </button>
          </>
        ) : (
          <span className="deploy-app">Not linked</span>
        )}
        <button className="deploy-refresh" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </button>
      </div>

      {error && <div className="deploy-error">{error}</div>}
      {linkProblem && <div className="deploy-error">{linkProblem}</div>}

      {!linkedId || !linkedApp ? (
        <div className="deploy-picker">
          {apps.length === 0 ? (
            <p className="deploy-empty">
              This account owns no apps. Create one on the Peko dashboard, then refresh.
            </p>
          ) : (
            <ul className="deploy-app-list">
              {apps.map((app) => (
                <li key={app.id}>
                  <button onClick={() => void link(app.id)} disabled={loading}>
                    <span className="deploy-app-name">{appLabel(app)}</span>
                    <span className="deploy-app-caps">
                      {app.capabilities?.server ? 'server' : ''}
                      {app.capabilities?.server && app.capabilities?.distribution ? ' · ' : ''}
                      {app.capabilities?.distribution ? 'distribution' : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="deploy-actions">
          <button
            className="deploy-primary"
            disabled={!capabilities.server || deploying}
            title={
              capabilities.server
                ? 'Deploy the web app to Peko hosting'
                : 'This app cannot host a server. Turn that on from the dashboard.'
            }
            onClick={() => onStart('server')}
          >
            Deploy server
          </button>
          <button
            className="deploy-primary"
            disabled={!capabilities.distribution || deploying || missingKeys.length > 0}
            title={
              !capabilities.distribution
                ? 'This app cannot ship to app stores. Turn that on from the dashboard.'
                : missingKeys.length > 0
                  ? `Signing keys missing for ${missingKeys.join(', ')}`
                  : 'Build the apps and send them to the platform'
            }
            onClick={() => onStart('app')}
          >
            Deploy app
          </button>
          {deploying && (
            <button className="deploy-stop" onClick={onStop}>
              Cancel
            </button>
          )}
          <span className="spacer" />
          <button className="deploy-clear" onClick={onClear} disabled={output.length === 0}>
            Clear
          </button>
        </div>
      )}

      {capabilities.distribution && missingKeys.length > 0 && (
        <div className="deploy-gate">
          Signing keys are missing for {missingKeys.join(', ')}. Add them in the Signing tab before
          deploying the app.
        </div>
      )}

      {result && (
        <div className={result.ok ? 'deploy-result ok' : 'deploy-result failed'}>
          {result.ok
            ? result.state === 'building'
              ? 'Still building. Track it on your dashboard.'
              : result.url
                ? `Live at ${result.url}`
                : 'Deploy finished.'
            : `Deploy failed: ${result.error ?? 'unknown error'}`}
        </div>
      )}

      <div className="deploy-log" ref={tailRef}>
        {output.map((line) => (
          <div key={line.id} className={`log-line ${line.stream}`}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  )
}
