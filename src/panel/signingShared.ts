/// Constants and helpers shared between the build panel and the signing view.
///
/// They live outside both so the two can import from here without a cycle.

export const PLATFORM_LABEL: Record<string, string> = {
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  ios: 'iOS',
  android: 'Android',
}

/// Platforms that have a code signing model at all. Linux is absent because
/// AppImages are not signed.
export const SIGNABLE_PLATFORMS = ['android', 'ios', 'macos', 'windows']

/// Platforms whose keys the CLI can create, rather than only register.
export const GENERATABLE_PLATFORMS = ['android', 'ios', 'macos']

/// The password-carrying roles the CLI keychain stores per platform.
export const SECRET_ROLES: Record<string, { role: string; label: string }[]> = {
  android: [
    { role: 'store', label: 'Keystore password' },
    { role: 'key', label: 'Key password' },
  ],
  macos: [
    { role: 'p12', label: 'Certificate password' },
    { role: 'installer-p12', label: 'Installer certificate password' },
  ],
  ios: [{ role: 'p12', label: 'Certificate password' }],
  windows: [{ role: 'pfx', label: 'Certificate password' }],
}

/// What a platform needs, in the user's words, for the empty state.
export const PLATFORM_NEEDS: Record<string, string> = {
  android: 'A keystore, used to sign every release you send to Google Play.',
  ios: 'A signing certificate and a provisioning profile from Apple.',
  macos: 'A signing certificate from Apple. The App Store also needs a separate installer certificate.',
  windows: 'A code signing certificate. Optional: Windows apps run without one, but users see a warning on first run.',
}

/// The file types a platform's picker offers.
export const DROP_ACCEPT: Record<string, string> = {
  android: '.jks,.keystore,.p12',
  macos: '.p12,.entitlements,.plist',
  ios: '.p12,.mobileprovision,.entitlements,.plist',
  windows: '.pfx,.p12',
}

/// The prompt shown when adding a file.
export const DROP_HINT: Record<string, string> = {
  android: 'Drop a keystore (.jks, .keystore, .p12), or click to browse',
  macos: 'Drop a signing certificate (.p12), or click to browse',
  ios: 'Drop a certificate (.p12) or profile (.mobileprovision), or click to browse',
  windows: 'Drop a signing certificate (.pfx, .p12), or click to browse',
}

/// Given a platform and a dropped file name, the registry role it fills, or null
/// when the file type does not belong to that platform.
export function roleForDrop(platform: string, filename: string): string | null {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase()
  if (platform === 'android') return ['.jks', '.keystore', '.p12'].includes(ext) ? 'keystore' : null
  if (platform === 'windows') return ['.pfx', '.p12'].includes(ext) ? 'pfx' : null
  if (platform === 'macos') {
    if (ext === '.p12') return 'p12'
    if (ext === '.entitlements' || ext === '.plist') return 'entitlements'
    return null
  }
  if (platform === 'ios') {
    if (ext === '.p12') return 'p12'
    if (ext === '.mobileprovision') return 'profile'
    if (ext === '.entitlements' || ext === '.plist') return 'entitlements'
    return null
  }
  return null
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer()
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/// Whether a platform still needs attention from the user.
///
/// Only a platform that must be signed counts. Windows is optional and Linux
/// does not sign, so neither should show a warning badge for having no keys.
export function needsAttention(state: string | undefined): boolean {
  return state === 'missing' || state === 'invalid'
}

/// A short, plain description of a platform's signing state.
export function stateSummary(platform: string, state: string | undefined): string {
  switch (state) {
    case 'valid':
      return 'Ready to sign'
    case 'unverified':
      return 'Registered, but could not be fully checked'
    case 'invalid':
      return 'Registered, but not usable'
    case 'optional':
      return 'No certificate. Builds are unsigned.'
    case 'not_required':
      return `${PLATFORM_LABEL[platform] ?? platform} apps are not code signed`
    default:
      return 'No keys yet'
  }
}

/// The keychain password roles a newly added file needs, keyed by the registry
/// role the file fills. A provisioning profile or entitlements plist has no
/// password, so adding one asks for nothing.
export const PASSWORDS_FOR_ROLE: Record<string, { role: string; label: string }[]> = {
  keystore: [
    { role: 'store', label: 'Keystore password' },
    { role: 'key', label: 'Key password' },
  ],
  p12: [{ role: 'p12', label: 'Certificate password' }],
  'installer-p12': [{ role: 'installer-p12', label: 'Installer certificate password' }],
  pfx: [{ role: 'pfx', label: 'Certificate password' }],
  profile: [],
  entitlements: [],
}

/// A readable name for a registry role, for the file list.
export const ROLE_LABEL: Record<string, string> = {
  keystore: 'Keystore',
  p12: 'Certificate',
  'installer-p12': 'Installer certificate',
  pfx: 'Certificate',
  profile: 'Provisioning profile',
  entitlements: 'Entitlements',
  certificate: 'Certificate',
}
