// Schema-aware editing for peko.toml: key/table completion and validation of
// which keys and tables belong where. Monaco has no TOML language service, so
// this is a small line-based checker over the known manifest shape. It applies
// only to files named peko.toml.
import * as monaco from 'monaco-editor'

type ValueType = 'string' | 'number' | 'array' | 'table'

interface KeySpec {
  type: ValueType
  values?: string[]
  detail?: string
}

interface TableSpec {
  detail?: string
  keys: Record<string, KeySpec>
  // A freeform table accepts arbitrary keys (e.g. [dependencies]).
  freeform?: boolean
}

const PLATFORMS = ['macos', 'windows', 'linux', 'ios', 'android']

const SCHEMA: Record<string, TableSpec> = {
  project: {
    detail: 'Application project metadata',
    keys: {
      name: { type: 'string', detail: 'Display name' },
      bundle: { type: 'string', detail: 'Reverse-DNS bundle id' },
      version: { type: 'string', detail: 'Semantic version' },
      app_id: { type: 'string', detail: 'Platform-assigned app id (managed)' },
      host: {
        type: 'string',
        detail: 'Deployed serving host, e.g. <slug>.serve.pekoui.com (managed)',
      },
      target_platforms: { type: 'array', values: PLATFORMS, detail: 'Platforms to build' },
      entry: { type: 'string', detail: 'Entry .peko file, relative to the project root' },
    },
  },
  ui: {
    detail: 'UI form and window',
    keys: {
      framework: {
        type: 'string',
        values: [
          'native',
          'static',
          'server',
          'next',
          'nuxt',
          'sveltekit',
          'remix',
          'astro',
          'angular',
        ],
      },
      icon: { type: 'string', detail: 'Square PNG icon path' },
      scheme: { type: 'string', detail: 'Deep-link URL scheme' },
      width: { type: 'number', detail: 'Initial window width' },
      height: { type: 'number', detail: 'Initial window height' },
    },
  },
  windows: {
    detail: 'Windows Store (MSIX) identity, from Partner Center',
    keys: {
      identity_name: {
        type: 'string',
        detail: 'Package Identity Name, e.g. Publisher.AppName',
      },
      publisher: { type: 'string', detail: 'Package Identity Publisher, e.g. CN=...' },
      publisher_display_name: { type: 'string', detail: 'Human-readable publisher name' },
    },
  },
  capabilities: {
    detail: 'Requested platform capabilities',
    keys: {
      uses: { type: 'array', detail: 'e.g. storage, assets, menu, keychain' },
    },
  },
  dependencies: {
    detail: 'Project dependencies',
    keys: {},
    freeform: true,
  },
  package: {
    detail: 'Library package metadata',
    keys: {
      name: { type: 'string' },
      version: { type: 'string' },
      description: { type: 'string' },
      license: { type: 'string' },
      authors: { type: 'array' },
      repository: { type: 'string' },
      keywords: { type: 'array' },
      categories: { type: 'array' },
      peko: { type: 'string', detail: 'Minimum Peko version' },
    },
  },
  lib: {
    detail: 'Library entry',
    keys: { root: { type: 'string', detail: 'Library root .peko file' } },
  },
}

function isPekoToml(model: monaco.editor.ITextModel): boolean {
  return model.uri.path.endsWith('/peko.toml') || model.uri.path === '/peko.toml'
}

// The base table name of a header line: `[dependencies.foo]` -> `dependencies`.
function tableBase(header: string): string {
  return header.split('.')[0].trim()
}

/// Validate a peko.toml and return diagnostic markers.
function validate(model: monaco.editor.ITextModel): monaco.editor.IMarkerData[] {
  const markers: monaco.editor.IMarkerData[] = []
  const lines = model.getValue().split('\n')
  let currentTable: string | null = null

  const warn = (line: number, startColumn: number, endColumn: number, message: string) => {
    markers.push({
      severity: monaco.MarkerSeverity.Warning,
      message,
      startLineNumber: line + 1,
      startColumn,
      endLineNumber: line + 1,
      endColumn,
    })
  }
  const error = (line: number, startColumn: number, endColumn: number, message: string) => {
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message,
      startLineNumber: line + 1,
      startColumn,
      endLineNumber: line + 1,
      endColumn,
    })
  }

  lines.forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '')
    const trimmed = line.trim()
    if (trimmed.length === 0) return

    const header = trimmed.match(/^\[(.+?)\]$/)
    if (header) {
      const base = tableBase(header[1])
      currentTable = base
      if (!SCHEMA[base]) {
        warn(index, 1, raw.length + 1, `Unknown table [${header[1]}] in peko.toml`)
      }
      return
    }

    const kv = line.match(/^(\s*)([A-Za-z0-9_.-]+)\s*=(.*)$/)
    if (!kv) return
    const key = kv[2]
    const keyStart = kv[1].length + 1
    const keyEnd = keyStart + key.length

    if (!currentTable) {
      warn(index, keyStart, keyEnd, `'${key}' is not inside a table`)
      return
    }
    const spec = SCHEMA[currentTable]
    if (!spec) return
    if (!spec.freeform && !spec.keys[key]) {
      warn(index, keyStart, keyEnd, `Unknown key '${key}' in [${currentTable}]`)
      return
    }

    // Validate a constrained set of values.
    const keySpec = spec.keys[key]
    if (keySpec?.values) {
      const value = kv[3]
      const found = value.match(/"([^"]*)"|'([^']*)'/g) ?? []
      for (const token of found) {
        const text = token.slice(1, -1)
        if (!keySpec.values.includes(text)) {
          const col = raw.indexOf(token) + 1
          error(
            index,
            col,
            col + token.length,
            `'${text}' is not a valid ${key} value (expected: ${keySpec.values.join(', ')})`,
          )
        }
      }
    }
  })

  return markers
}

// The table the cursor is currently under, scanning up for the last header.
function currentTableAt(model: monaco.editor.ITextModel, line: number): string | null {
  for (let i = line; i >= 1; i--) {
    const text = model.getLineContent(i).trim()
    const header = text.match(/^\[(.+?)\]$/)
    if (header) return tableBase(header[1])
  }
  return null
}

let registered = false

/// Register peko.toml completion and validation on the toml language. Safe to
/// call more than once.
export function registerPekoTomlSupport(): void {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider('toml', {
    provideCompletionItems(model, position) {
      if (!isPekoToml(model)) return { suggestions: [] }
      const linePrefix = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )

      // At the start of a line (or typing `[`), offer table headers.
      if (/^\s*\[?[A-Za-z]*$/.test(linePrefix)) {
        const tables = Object.entries(SCHEMA).map(([name, spec]) => ({
          label: `[${name}]`,
          kind: monaco.languages.CompletionItemKind.Struct,
          insertText: `[${name}]`,
          detail: spec.detail,
          range,
        }))
        const table = currentTableAt(model, position.lineNumber)
        const spec = table ? SCHEMA[table] : null
        const keys = spec
          ? Object.entries(spec.keys).map(([name, keySpec]) => ({
              label: name,
              kind: monaco.languages.CompletionItemKind.Property,
              insertText: `${name} = `,
              detail: keySpec.detail ?? keySpec.type,
              range,
            }))
          : []
        return { suggestions: [...keys, ...tables] }
      }

      // After `key = `, offer enum values for constrained keys.
      const assign = linePrefix.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*\[?\s*"?[A-Za-z]*$/)
      if (assign) {
        const table = currentTableAt(model, position.lineNumber)
        const keySpec = table ? SCHEMA[table]?.keys[assign[1]] : undefined
        if (keySpec?.values) {
          return {
            suggestions: keySpec.values.map((value) => ({
              label: value,
              kind: monaco.languages.CompletionItemKind.EnumMember,
              insertText: `"${value}"`,
              range,
            })),
          }
        }
      }

      return { suggestions: [] }
    },
  })

  const revalidate = (model: monaco.editor.ITextModel) => {
    if (model.getLanguageId() !== 'toml' || !isPekoToml(model)) return
    monaco.editor.setModelMarkers(model, 'peko-toml', validate(model))
  }

  monaco.editor.getModels().forEach(revalidate)
  monaco.editor.onDidCreateModel((model) => {
    revalidate(model)
    model.onDidChangeContent(() => revalidate(model))
  })
}
