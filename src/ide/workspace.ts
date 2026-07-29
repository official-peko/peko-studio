// Typed wrappers over the native workspace bridge. The host answers ide.entry
// (the project bootstrap), ide.list (a directory's children), ide.read (a
// file's text), and ide.save. Each returns a safe fallback when the bridge is
// absent, e.g. a plain browser dev server with no native host.
import { peko } from '@peko/client'

// The project bootstrap: the workspace root, the entry file to open first, and
// the language-server relay port.
export interface Entry {
  root: string
  path: string
  text: string
  lspPort?: number
}

// One child of a listed directory.
export interface DirEntry {
  name: string
  path: string
  dir: boolean
}

// An open editor tab.
export interface Tab {
  path: string
  name: string
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
}

/// Ask the host for the project bootstrap. Returns null when no native bridge
/// answers within the timeout (a browser dev server).
export async function loadEntry(): Promise<Entry | null> {
  try {
    await Promise.race([peko.ready, timeout(2500)])
    return (await peko.invoke('ide.entry', {})) as Entry
  } catch {
    return null
  }
}

/// Whether this window should show the project launcher rather than the editor.
/// The host reports launcher mode when no project is set. Without a bridge (a
/// plain browser dev server) the editor renders so development still works.
export async function isLauncherWindow(): Promise<boolean> {
  try {
    await Promise.race([peko.ready, timeout(2500)])
    const entry = (await peko.invoke('ide.entry', {})) as { launcher?: boolean }
    return entry.launcher === true
  } catch {
    return false
  }
}

// The parts of peko.toml the build/run panel needs to seed its controls.
export interface Manifest {
  name: string
  // "native" | "static" | "server", or undefined for a CLI project.
  framework?: string
  // Declared build targets, e.g. ["macos", "windows", "linux"].
  targetPlatforms: string[]
}

const KNOWN_PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android']

/// Read and lightly parse peko.toml (target_platforms, name, framework) so the
/// run bar can seed its target selector. A minimal parse - not a full TOML
/// reader - is enough for these fixed keys and avoids a native round trip; the
/// authoritative parse will move to an `ide.project.manifest` bridge handler.
export async function loadManifest(root: string): Promise<Manifest | null> {
  const text = await readFile(joinPath(root, 'peko.toml'))
  if (text === null) return null

  const nameMatch = text.match(/^\s*name\s*=\s*"([^"]*)"/m)
  const frameworkMatch = text.match(/^\s*framework\s*=\s*"([^"]*)"/m)
  const platformsMatch = text.match(/target_platforms\s*=\s*\[([^\]]*)\]/)
  const targetPlatforms = platformsMatch
    ? [...platformsMatch[1].matchAll(/"([^"]+)"/g)]
        .map((m) => m[1].toLowerCase())
        .filter((p) => KNOWN_PLATFORMS.includes(p))
    : []

  return {
    name: nameMatch?.[1] ?? 'project',
    framework: frameworkMatch?.[1],
    targetPlatforms,
  }
}

/// List a directory's immediate children. Omitting path lists the workspace
/// root. Directories sort before files.
export async function listDir(path?: string): Promise<DirEntry[]> {
  try {
    const result = (await peko.invoke('ide.list', path ? { path } : {})) as {
      entries?: DirEntry[]
    }
    return result.entries ?? []
  } catch {
    return []
  }
}

/// Read a file's text. Returns null when the file cannot be read or no bridge
/// answers.
export async function readFile(path: string): Promise<string | null> {
  try {
    const result = (await peko.invoke('ide.read', { path })) as { text?: string; error?: boolean }
    if (result.error || result.text === undefined) return null
    return result.text
  } catch {
    return null
  }
}

// One changed path from git and its normalized status.
export interface GitEntry {
  path: string
  status: 'modified' | 'added' | 'untracked' | 'deleted' | 'renamed'
}

// The workspace source-control state.
export interface GitStatus {
  branch: string
  entries: GitEntry[]
}

/// The stored editor preferences. Backed by a native file rather than
/// localStorage, which does not survive restarts (the asset server binds a fresh
/// origin each launch). Empty when none are stored or no bridge answers.
export async function getPrefs(): Promise<Record<string, string>> {
  try {
    const result = (await peko.invoke('ide.prefs.get', {})) as Record<string, string>
    return result && typeof result === 'object' ? result : {}
  } catch {
    return {}
  }
}

/// Pending preference writes, flushed together.
///
/// Persisting is read-modify-write over one JSON file, so two writes started
/// before either finished would both read the same base and the later one would
/// drop the earlier one's key. Collecting them and flushing once removes that
/// window, and it also collapses a burst from a drag into a single write.
let pendingPrefs: Record<string, string> = {}
let prefFlush: ReturnType<typeof setTimeout> | null = null

/// Merge preferences into the store and persist them. Accepts one key or
/// several; several in one call are guaranteed to land together.
export function setPref(key: string, value: string): void
export function setPref(values: Record<string, string>): void
export function setPref(keyOrValues: string | Record<string, string>, value?: string): void {
  if (typeof keyOrValues === 'string') pendingPrefs[keyOrValues] = value ?? ''
  else Object.assign(pendingPrefs, keyOrValues)

  if (prefFlush) clearTimeout(prefFlush)
  prefFlush = setTimeout(() => void flushPrefs(), 250)
}

/// Write every pending preference in one read-modify-write.
export async function flushPrefs(): Promise<void> {
  if (prefFlush) {
    clearTimeout(prefFlush)
    prefFlush = null
  }
  const writing = pendingPrefs
  pendingPrefs = {}
  if (Object.keys(writing).length === 0) return
  try {
    const prefs = await getPrefs()
    await peko.invoke('ide.prefs.set', { data: JSON.stringify({ ...prefs, ...writing }) })
  } catch {
    // No bridge; the values are kept only for this session.
  }
}

/// The current branch and changed paths for the workspace. Empty when the
/// workspace is not a git repository or no bridge answers.
export async function gitStatus(): Promise<GitStatus> {
  try {
    const result = (await peko.invoke('ide.git.status', {})) as GitStatus
    return {
      branch: result.branch ?? '',
      entries: Array.isArray(result.entries) ? result.entries : [],
    }
  } catch {
    return { branch: '', entries: [] }
  }
}

// A dependency listed in peko.toml's [dependencies] table.
export interface Package {
  name: string
  // A version requirement ("*", "^1.2") or a local path.
  spec: string
  isPath: boolean
}

/// Parse the project's [dependencies] table from peko.toml. A line-based read is
/// enough for the name and a summary of each requirement.
export async function listPackages(root: string): Promise<Package[]> {
  const text = await readFile(joinPath(root, 'peko.toml'))
  if (text === null) return []
  const out: Package[] = []
  let inDeps = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) {
      inDeps = line === '[dependencies]'
      continue
    }
    if (!inDeps || !line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const name = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    const isPath = value.startsWith('{') && /path/.test(value)
    let spec = value
    if (isPath) {
      spec = value.match(/path\s*=\s*"([^"]*)"/)?.[1] ?? 'local path'
    } else {
      spec = value.replace(/^"|"$/g, '')
    }
    out.push({ name, spec, isPath })
  }
  return out
}

async function packageCommand(method: string, params: unknown): Promise<{ ok: boolean; output: string }> {
  try {
    const result = (await peko.invoke(method, params)) as { ok?: boolean; output?: string }
    return { ok: result.ok === true, output: result.output ?? '' }
  } catch {
    return { ok: false, output: 'no native bridge' }
  }
}

/// Install a dependency (peko add). version pins a registry requirement; path
/// adds a local path dependency; global installs into the shared global manifest
/// (importable from every project) instead of the current project.
export function addPackage(opts: { name: string; version?: string; path?: string; global?: boolean }) {
  return packageCommand('ide.packages.add', {
    name: opts.name,
    version: opts.version,
    path: opts.path,
    global: opts.global ? 'true' : '',
  })
}

/// Remove a dependency (peko remove). `global` targets the shared global manifest.
export function removePackage(name: string, global = false) {
  return packageCommand('ide.packages.remove', { name, global: global ? 'true' : '' })
}

/// The shared global library root, whose peko.toml lists globally-installed
/// packages. Empty when Peko is not installed.
export async function globalRoot(): Promise<string> {
  try {
    const result = (await peko.invoke('ide.packages.global_root', {})) as { root?: string }
    return result.root ?? ''
  } catch {
    return ''
  }
}

/// Every .peko source file under the project, so the editor can open them all to
/// the language server for project-wide diagnostics.
export async function projectSources(): Promise<string[]> {
  try {
    const result = (await peko.invoke('ide.project_sources', {})) as { files?: string[] }
    return result.files ?? []
  } catch {
    return []
  }
}

/// Tell the host which files to watch for external changes. The host polls them
/// and emits ide.fs.change {path} when one changes on disk.
export function setWatchedFiles(paths: string[]): void {
  void peko.invoke('ide.watch', { paths }).catch(() => {})
}

/// Tell the host which directories to watch for tree changes (added, removed, or
/// renamed entries). The host emits ide.fs.tree {path} when a listing changes.
export function setWatchedDirs(paths: string[]): void {
  void peko.invoke('ide.watch_dirs', { paths }).catch(() => {})
}

/// Write text to a file. Returns whether the write succeeded.
export async function saveFile(path: string, text: string): Promise<boolean> {
  try {
    const result = (await peko.invoke('ide.save', { path, text })) as { ok?: boolean }
    return result.ok === true
  } catch {
    return false
  }
}

// Image extensions to their MIME type, for rendering as data URLs.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

function extensionOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/// The MIME type for an image path, or null when it is not a raster image.
/// SVG is treated as text/code, not an image render.
export function imageMime(path: string): string | null {
  return IMAGE_MIME[extensionOf(path)] ?? null
}

/// Whether a path is a Markdown file.
export function isMarkdown(path: string): boolean {
  const ext = extensionOf(path)
  return ext === 'md' || ext === 'markdown'
}

/// Read a binary file as a base64 data URL, or null on failure. mime is the
/// image MIME type.
export async function readImageDataUrl(path: string, mime: string): Promise<string | null> {
  try {
    const result = (await peko.invoke('ide.readb64', { path })) as { data?: string; error?: boolean }
    if (result.error || result.data === undefined) return null
    return `data:${mime};base64,${result.data}`
  } catch {
    return null
  }
}

async function invokeOk(method: string, params: unknown): Promise<boolean> {
  try {
    const result = (await peko.invoke(method, params)) as { ok?: boolean }
    return result.ok === true
  } catch {
    return false
  }
}

/// Create an empty file at path.
export function createFile(path: string): Promise<boolean> {
  return invokeOk('ide.create', { path })
}

/// Create a directory at path.
export function makeDir(path: string): Promise<boolean> {
  return invokeOk('ide.mkdir', { path })
}

/// Rename or move a file or directory.
export function rename(from: string, to: string): Promise<boolean> {
  return invokeOk('ide.rename', { from, to })
}

/// Delete a file or directory (recursively).
export function remove(path: string): Promise<boolean> {
  return invokeOk('ide.delete', { path })
}

/// Move a file or directory to the user Trash (recoverable).
export function trash(path: string): Promise<boolean> {
  return invokeOk('ide.trash', { path })
}

/// Reveal a file or directory in the Finder.
export function revealInFinder(path: string): Promise<boolean> {
  return invokeOk('ide.reveal', { path })
}

// A recent project entry for the launcher.
export interface RecentProject {
  path: string
  name: string
  exists: boolean
}

/// The recent projects, most recent first. Empty when none or no bridge.
export async function recentProjects(): Promise<RecentProject[]> {
  try {
    const result = (await peko.invoke('ide.projects.recent', {})) as { projects?: RecentProject[] }
    return result.projects ?? []
  } catch {
    return []
  }
}

/// Open a project by root path in a new editor window. Resolves to an error
/// message on failure, or null on success.
export async function openProject(path: string): Promise<string | null> {
  try {
    const result = (await peko.invoke('ide.projects.open', { path })) as {
      ok?: boolean
      error?: string
    }
    return result.ok ? null : result.error ?? 'could not open project'
  } catch {
    return 'no native bridge'
  }
}

/// Open the Setup window as a fresh app instance (spawned like the launcher).
/// `view` opens straight to one action (update | resetup | packages | uninstall).
export async function openSetupWindow(view?: string): Promise<void> {
  try {
    await peko.invoke('ide.open_setup', { view: view ?? '' })
  } catch {
    // No native bridge; nothing to open.
  }
}

/// Open the project launcher in a new window (a fresh instance with no project).
/// The caller closes its own window to replace it. Resolves true on success.
export async function openLauncherWindow(): Promise<boolean> {
  try {
    const result = (await peko.invoke('ide.open_launcher', {})) as { ok?: boolean }
    return result.ok === true
  } catch {
    return false
  }
}

/// Open the native folder chooser and return the chosen absolute path, or empty
/// when the user cancels or no chooser is wired for the platform.
export async function pickFolder(): Promise<string> {
  try {
    const result = (await peko.invoke('ide.pick_folder', {})) as { path?: string }
    return result.path ?? ''
  } catch {
    return ''
  }
}

// Options for scaffolding a project.
export interface NewProjectOptions {
  name: string
  dir?: string
  /** Project kind: `ui`, `cli`, or `package` (a library). Falls back to `ui`. */
  type?: 'ui' | 'cli' | 'package'
  ui?: boolean
  framework?: string
}

/// Scaffold a project and open it. Resolves to the created path on success, or
/// an error message string on failure.
export async function newProject(options: NewProjectOptions): Promise<{ path: string } | { error: string }> {
  try {
    const result = (await peko.invoke('ide.projects.new', options)) as {
      ok?: boolean
      path?: string
      error?: string
    }
    if (result.ok && result.path) return { path: result.path }
    return { error: result.error ?? 'could not create project' }
  } catch {
    return { error: 'no native bridge' }
  }
}

/// The parent directory of a path (no trailing slash).
export function parentDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash <= 0 ? '/' : path.slice(0, slash)
}

/// Join a directory and a name into a path.
export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`
}

// The platforms that can carry a distinct icon override.
export type IconPlatform = 'macos' | 'ios' | 'android' | 'windows' | 'linux'
export const ICON_PLATFORMS: IconPlatform[] = ['macos', 'ios', 'android', 'windows', 'linux']

// The saved icon document: the shared base layers plus optional per-platform
// override layer stacks. Layer shapes are the builder's own; kept as a loose
// record here so the store stays decoupled from the editor's types.
export interface IconDoc {
  version: number
  layers: Record<string, unknown>[]
  overrides?: Partial<Record<IconPlatform, Record<string, unknown>[]>>
}

// Everything the builder produces on save: the shared master, the Android
// adaptive layers, and a base64 flat PNG for each platform that has an override.
export interface IconArtifacts {
  master: string
  androidForeground: string
  androidBackground: string
  overrides: Partial<Record<IconPlatform, string>>
  doc: IconDoc
}

// The relative paths the builder writes into and records in [icon]. These live
// in a dedicated icon/ directory, not the web build output (a framework's build
// directory, e.g. Vite's outDir, is emptied on every build and would wipe them).
export const ICON_SOURCE_REL = 'icon/appicon.png'
export const ICON_PROJECT_REL = 'icon/appicon.pekoicon'
export const ICON_FOREGROUND_REL = 'icon/appicon-foreground.png'
export const ICON_BACKGROUND_REL = 'icon/appicon-background.png'

// The relative path of a platform's override flat PNG.
function overrideRel(platform: IconPlatform): string {
  return `icon/appicon-${platform}.png`
}

// The text of the [icon] table body, or empty when the project has none.
function iconTableBody(toml: string): string {
  const match = toml.match(/^\[icon\][^\n]*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)
  return match ? match[1] : ''
}

/// Load the project's saved icon document when [icon].project points at one.
/// Returns null when there is no saved document to reopen.
export async function loadIconDoc(root: string): Promise<IconDoc | null> {
  const toml = await readFile(joinPath(root, 'peko.toml'))
  if (toml === null) return null
  const rel = iconTableBody(toml).match(/^\s*project\s*=\s*"([^"]*)"/m)?.[1]
  if (!rel) return null
  const docText = await readFile(joinPath(root, rel))
  if (docText === null) return null
  try {
    const doc = JSON.parse(docText) as IconDoc
    if (!Array.isArray(doc.layers)) return null
    // Keep only well-formed per-platform override stacks.
    if (doc.overrides && typeof doc.overrides === 'object') {
      const clean: Partial<Record<IconPlatform, Record<string, unknown>[]>> = {}
      for (const platform of ICON_PLATFORMS) {
        const stack = doc.overrides[platform]
        if (Array.isArray(stack)) clean[platform] = stack
      }
      doc.overrides = clean
    }
    return doc
  } catch {
    return null
  }
}

// Set `key = "value"` inside a table body, replacing an existing line or
// appending one. Returns the edited body.
function setTableKey(body: string, key: string, value: string): string {
  const line = `${key} = "${value}"`
  const re = new RegExp(`^(\\s*)${key}\\s*=\\s*.*$`, 'm')
  if (re.test(body)) return body.replace(re, `$1${line}`)
  return `${body.replace(/\n*$/, '')}\n${line}\n`
}

// Ensure peko.toml has an [icon] table setting the given key/value pairs. Edits
// the existing table in place or appends a new one, leaving the rest untouched.
function upsertIconConfig(toml: string, entries: [string, string][]): string {
  if (!/^\[icon\]/m.test(toml)) {
    const lines = entries.map(([key, value]) => `${key} = "${value}"`).join('\n')
    return `${toml.replace(/\n*$/, '')}\n\n[icon]\n${lines}\n`
  }
  return toml.replace(/^(\[icon\][^\n]*\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m, (_all, head, body) => {
    let next = body
    for (const [key, value] of entries) next = setTableKey(next, key, value)
    return `${head}${next}`
  })
}

// Remove a key line from a table body. Matches only the exact key, so removing
// `android` never touches `android_foreground`.
function removeTableKey(body: string, key: string): string {
  return body.replace(new RegExp(`^[ \\t]*${key}[ \\t]*=.*\\n?`, 'm'), '')
}

// Drop the given keys from the [icon] table, used when a platform override is
// cleared so its stale path does not linger in the manifest.
function removeIconKeys(toml: string, keys: string[]): string {
  if (keys.length === 0 || !/^\[icon\]/m.test(toml)) return toml
  return toml.replace(/^(\[icon\][^\n]*\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m, (_all, head, body) => {
    let next = body
    for (const key of keys) next = removeTableKey(next, key)
    return `${head}${next}`
  })
}

// Write one base64 PNG into the project through the host. Returns an error
// message on failure, or null on success.
async function writeIconPng(root: string, rel: string, base64: string): Promise<string | null> {
  try {
    const res = (await Promise.race([
      peko.invoke('ide.icon.save', { path: joinPath(root, rel), data: base64 }),
      timeout(8000),
    ])) as { ok?: boolean }
    return res.ok ? null : 'The host could not write the icon image'
  } catch {
    return 'No response from the host (is this the latest build of Peko Studio?)'
  }
}

/// Save every icon artifact. Writes the master PNG and layered document, the
/// Android adaptive layers, and a flat PNG for each platform that carries an
/// override, then records the paths in peko.toml's [icon] table (removing the
/// keys of platforms whose override was cleared). Resolves to an error message
/// on failure, or null on success.
export async function saveIcon(root: string, art: IconArtifacts): Promise<string | null> {
  const masterError = await writeIconPng(root, ICON_SOURCE_REL, art.master)
  if (masterError) return masterError

  const okDoc = await saveFile(joinPath(root, ICON_PROJECT_REL), JSON.stringify(art.doc, null, 2))
  if (!okDoc) return 'Could not write the icon document'

  const fgError = await writeIconPng(root, ICON_FOREGROUND_REL, art.androidForeground)
  if (fgError) return fgError
  const bgError = await writeIconPng(root, ICON_BACKGROUND_REL, art.androidBackground)
  if (bgError) return bgError

  const entries: [string, string][] = [
    ['source', ICON_SOURCE_REL],
    ['project', ICON_PROJECT_REL],
    ['android_foreground', ICON_FOREGROUND_REL],
    ['android_background', ICON_BACKGROUND_REL],
  ]
  const removeKeys: string[] = []
  for (const platform of ICON_PLATFORMS) {
    const rel = overrideRel(platform)
    const data = art.overrides[platform]
    if (data) {
      const overrideError = await writeIconPng(root, rel, data)
      if (overrideError) return overrideError
      entries.push([platform, rel])
    } else {
      removeKeys.push(platform)
      void remove(joinPath(root, rel))
    }
  }

  const toml = await readFile(joinPath(root, 'peko.toml'))
  if (toml !== null) {
    let next = upsertIconConfig(toml, entries)
    next = removeIconKeys(next, removeKeys)
    if (next !== toml) await saveFile(joinPath(root, 'peko.toml'), next)
  }
  return null
}
