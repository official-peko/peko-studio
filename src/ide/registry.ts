// Registry browse/search client. The public package index lives in the platform's
// Firestore `packages` collection, which is public-read. The webview queries the
// Firestore REST API directly (it allows cross-origin reads with the public
// Firebase web key). Firestore has no substring search, so the whole (bounded)
// collection is read and filtered here, matching the platform's own logic.
//
// The apiKey and projectId are the platform's public Firebase client config
// (the same values the unauthenticated /api/cli/config endpoint returns); Firebase
// web keys are meant to be embedded in clients and are guarded by Firestore rules.
const FIREBASE_API_KEY = 'AIzaSyB2JVeHOgULpv9K3PhSj8zv8gNrkcMUin0'
const FIREBASE_PROJECT = 'peko-platform'
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`

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

// Firestore REST wraps each field in a typed value ({stringValue}, {integerValue},
// {arrayValue:{values:[...]}}, {mapValue:{fields:{...}}}). Unwrap to plain JS.
/* eslint-disable @typescript-eslint/no-explicit-any */
function unwrap(value: any): any {
  if (value == null) return undefined
  if ('stringValue' in value) return value.stringValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('booleanValue' in value) return value.booleanValue
  if ('timestampValue' in value) return value.timestampValue
  if ('nullValue' in value) return null
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(unwrap)
  if ('mapValue' in value) return unwrapFields(value.mapValue.fields ?? {})
  return undefined
}

function unwrapFields(fields: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const key of Object.keys(fields)) out[key] = unwrap(fields[key])
  return out
}

function toPackage(docName: string, fields: Record<string, any>): RegistryPackage {
  const d = unwrapFields(fields)
  const id = docName.split('/').pop() ?? ''
  const versions: string[] = Array.isArray(d.versions) ? d.versions : []
  const author =
    d.author && typeof d.author === 'object'
      ? (d.author.name ?? null)
      : typeof d.author === 'string'
        ? d.author
        : null
  return {
    name: d.name ?? id,
    description: d.description ?? '',
    latest: d.latest ?? versions[versions.length - 1] ?? '',
    downloadCount: typeof d.downloadCount === 'number' ? d.downloadCount : 0,
    author,
    license: d.license ?? null,
    versions,
    keywords: Array.isArray(d.keywords) ? d.keywords : [],
    readme: typeof d.readme === 'string' ? d.readme : null,
  }
}

// Read the (bounded) package collection, newest/most-downloaded first.
async function readAll(cap = 200): Promise<RegistryPackage[]> {
  const url = `${FIRESTORE_BASE}/packages?key=${FIREBASE_API_KEY}&pageSize=${cap}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`registry ${response.status}`)
  const body = (await response.json()) as { documents?: { name: string; fields?: Record<string, any> }[] }
  const docs = body.documents ?? []
  return docs
    .map((doc) => toPackage(doc.name, doc.fields ?? {}))
    .sort((a, b) => b.downloadCount - a.downloadCount)
}

/// Browse or search the registry. An empty query returns the top packages.
export async function registrySearch(query: string, max = 40): Promise<RegistryPackage[]> {
  const q = query.trim().toLowerCase()
  const all = await readAll()
  const matched = q
    ? all.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    : all
  return matched.slice(0, max)
}

/// Fetch one package's full record (versions, readme, keywords).
export async function registryPackage(name: string): Promise<RegistryPackage | null> {
  const url = `${FIRESTORE_BASE}/packages/${encodeURIComponent(name)}?key=${FIREBASE_API_KEY}`
  const response = await fetch(url)
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`registry ${response.status}`)
  const body = (await response.json()) as { name: string; fields?: Record<string, any> }
  return toPackage(body.name, body.fields ?? {})
}
