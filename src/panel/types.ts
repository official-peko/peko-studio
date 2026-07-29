// Data models for the build/run panel. These mirror the CLI's devtools event
// shapes (crates/peko-cli/src/commands/devtools.rs: DevEvent / DevDiagnostic /
// DevConsoleLine) so the native layer can forward them over the bridge with
// minimal translation.

export type PanelTab = 'problems' | 'output' | 'console' | 'bridge' | 'page' | 'signing' | 'deploy'

export type ResourceType = 'document' | 'script' | 'style' | 'image' | 'json' | 'font' | 'other'

// One resource the page loaded.
export interface PageResource {
  url: string
  type: ResourceType
}

// A fetched resource's body, from ide.run.resource.
export interface ResourceBody {
  url: string
  mime: string
  text: string
  error?: string
}

// A snapshot of the running page, from ide.run.page (mirrors the client SDK's
// pageSnapshot).
export interface PageInfo {
  route: string
  url: string
  origin: string
  title: string
  referrer: string
  readyState: string
  width: number
  height: number
  scrollX: number
  scrollY: number
  elements: number
  html: string
  resources: PageResource[]
}

// idle: nothing running. building: a one-shot build in progress. running: the
// dev loop is live. stopping: tearing the loop down.
export type RunState = 'idle' | 'building' | 'running' | 'stopping'

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  file: string
  line: number // 1-based, editor coordinates
  column: number // 1-based
  severity: Severity
  message: string
}

export interface LogLine {
  id: number
  stream: 'stdout' | 'stderr'
  text: string
}

export interface ConsoleLine {
  id: number
  // 'result' is an evaluated expression's return value (styled apart from a
  // forwarded console.log line).
  level: 'log' | 'info' | 'warn' | 'error' | 'debug' | 'result'
  text: string
}

export type TraceDir = 'call' | 'reply' | 'event'

export interface TraceEntry {
  id: number
  dir: TraceDir
  label: string
  data: string // raw JSON payload
}

// One verification check within a platform's signing status (mirrors the CLI's
// signing::KeyCheck).
export interface KeyCheck {
  role: string
  file: string | null
  present: boolean
  ok: boolean
  unverified: boolean
  detail: string
}

// Signing verification for one declared platform, from ide.signing.status
// (which runs `peko keys verify --json`). Mirrors signing::PlatformReport.
export interface PlatformSigning {
  platform: string
  // not_required: the platform has no signing model (Linux).
  // optional: signing is available but absent — the build still ships (Windows).
  state: 'not_required' | 'optional' | 'missing' | 'invalid' | 'unverified' | 'valid'
  // Whether the platform must be signed to ship, so a caller can gate on the
  // requirement instead of inferring it from the platform name.
  requirement?: 'required' | 'optional' | 'not_applicable'
  checks: KeyCheck[]
}
