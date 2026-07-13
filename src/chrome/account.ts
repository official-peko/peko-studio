// Typed wrappers over the native account bridge. The host reuses the peko CLI
// session: ide.account.login spawns `peko login` (browser flow), status reads a
// cached identity without a keychain prompt, and refresh/logout touch the session
// on demand. Identity changes arrive on the ide.account:changed channel.
import { peko } from '@peko/client'

export interface Identity {
  authenticated: boolean
  uid?: string
  email?: string
  name?: string
  photoUrl?: string
  role?: string
  tier?: string
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalize(raw: unknown): Identity {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    authenticated: o.authenticated === true,
    uid: str(o.uid),
    email: str(o.email),
    name: str(o.name),
    photoUrl: str(o.photoUrl),
    role: str(o.role),
    tier: str(o.tier),
  }
}

/// The cached identity (no keychain read). Signed out returns authenticated:false.
export async function accountStatus(): Promise<Identity> {
  try {
    return normalize(await peko.invoke('ide.account.status', {}))
  } catch {
    return { authenticated: false }
  }
}

/// Start the browser sign-in flow. The result arrives on ide.account:changed.
export async function accountLogin(): Promise<void> {
  try {
    await peko.invoke('ide.account.login', {})
  } catch {
    // No bridge; nothing to start.
  }
}

/// Re-verify the identity against the platform. Result on ide.account:changed.
export async function accountRefresh(): Promise<void> {
  try {
    await peko.invoke('ide.account.refresh', {})
  } catch {
    // No bridge; nothing to refresh.
  }
}

/// Clear the platform session and the cached identity.
export async function accountLogout(): Promise<Identity> {
  try {
    return normalize(await peko.invoke('ide.account.logout', {}))
  } catch {
    return { authenticated: false }
  }
}

/// Subscribe to identity changes (login, refresh, logout). Returns unsubscribe.
export function onAccountChanged(handler: (identity: Identity) => void): () => void {
  return peko.on('ide.account:changed', (raw) => handler(normalize(raw)))
}
