// Registry browse/search client. The public package index lives in the platform's
// Firestore `packages` collection, which App Check now guards — so the webview can
// no longer read it directly (a bare fetch 403s). Instead it goes through the
// platform's server-side registry API, which reads Firestore with admin creds and
// returns plain JSON (no App Check needed for the client).
const PLATFORM_BASE = 'https://app.pekoui.com'

export interface RegistryPackage {
  name: string
  description: string
  latest: string
  downloadCount: number
  author: string | null
  license: string | null
  versions: string[]
  keywords: string[]
  readme: string | null
}

// The platform's JSON shapes (apps/platform/src/lib/server/packages.ts).
interface PackageSummary {
  name: string
  description?: string
  latest?: string
  downloadCount?: number
  author?: string | null
  license?: string | null
}
interface PackageDetail extends PackageSummary {
  versions?: string[]
  readme?: string | null
  keywords?: string[]
}

function toRegistryPackage(p: PackageDetail): RegistryPackage {
  return {
    name: p.name,
    description: p.description ?? '',
    latest: p.latest ?? '',
    downloadCount: typeof p.downloadCount === 'number' ? p.downloadCount : 0,
    author: p.author ?? null,
    license: p.license ?? null,
    versions: Array.isArray(p.versions) ? p.versions : [],
    keywords: Array.isArray(p.keywords) ? p.keywords : [],
    readme: typeof p.readme === 'string' ? p.readme : null,
  }
}

/// Browse or search the registry. An empty query returns the top packages.
export async function registrySearch(query: string, max = 40): Promise<RegistryPackage[]> {
  const url = `${PLATFORM_BASE}/api/packages?q=${encodeURIComponent(query.trim())}&max=${max}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`registry ${response.status}`)
  const body = (await response.json()) as { packages?: PackageSummary[] }
  return (body.packages ?? []).map(toRegistryPackage)
}

/// Fetch one package's full record (versions, readme, keywords).
export async function registryPackage(name: string): Promise<RegistryPackage | null> {
  const url = `${PLATFORM_BASE}/api/packages/${encodeURIComponent(name)}`
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`registry ${response.status}`)
  const body = (await response.json()) as PackageDetail
  return toRegistryPackage(body)
}
