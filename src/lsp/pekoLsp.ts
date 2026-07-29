// PekoScript language client.
//
// A lean bridge between a Monaco model and the language server reached over the
// native relay. It runs the LSP lifecycle, turns diagnostics into editor
// markers, and answers Monaco completion and hover requests from the server.
// It is deliberately small; it can be swapped for monaco-languageclient later
// without changing the native relay.
import * as monaco from 'monaco-editor'
import { JsonRpcConnection } from './jsonRpc'
import { PEKO_LANGUAGE_ID } from '../editor/monacoSetup'

// Fallback loopback port for the language server relay when the host did not
// report one (e.g. a plain browser dev server).
const DEFAULT_LSP_PORT = 51000

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

interface LspDiagnostic {
  range: LspRange
  severity?: number
  message: string
  source?: string
}

interface LspTextEdit {
  range: LspRange
  newText: string
}

interface LspCommand {
  title: string
  command: string
  arguments?: unknown[]
}

interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { kind: string; value: string }
  insertText?: string
  insertTextFormat?: number
  sortText?: string
  filterText?: string
  additionalTextEdits?: LspTextEdit[]
  command?: LspCommand
}

interface LspHover {
  contents: string | { kind: string; value: string } | Array<string | { language: string; value: string }>
}

type LspMarkup = string | { kind?: string; value: string }

interface LspSignatureHelp {
  signatures: Array<{
    label: string
    documentation?: LspMarkup
    parameters?: Array<{ label: string | [number, number]; documentation?: LspMarkup }>
  }>
  activeSignature?: number
  activeParameter?: number
}

interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspDocumentSymbol {
  name: string
  detail?: string
  kind: number
  range: LspRange
  selectionRange: LspRange
  children?: LspDocumentSymbol[]
}

/// Request the document symbol tree for a file. Used by the breadcrumb bar;
/// returns an empty list when the server is not connected or the file is not
/// open.
export async function fetchDocumentSymbols(uri: string): Promise<LspDocumentSymbol[]> {
  if (!activeConnection || !openDocs.has(uri)) return []
  try {
    const result = (await activeConnection.request('textDocument/documentSymbol', {
      textDocument: { uri },
    })) as LspDocumentSymbol[] | null
    return result ?? []
  } catch {
    // The server may reject before it has finished initializing; the caller
    // retries, so treat this as "not ready yet".
    return []
  }
}

export interface PekoLanguageClient {
  connection: JsonRpcConnection
  // Register a model as an open document (didOpen + live didChange sync).
  openModel: (model: monaco.editor.ITextModel) => void
  // Unregister a model when its tab closes.
  closeModel: (model: monaco.editor.ITextModel) => void
  // Open a project file to the server without an editor model, so it is
  // diagnosed even when no tab is open. Kept open for the project's lifetime.
  openBackground: (uri: string, text: string) => void
  dispose: () => void
}

// One open document tracked by the client: its model (null for a background
// project file), sync version, and the content-change subscription.
interface OpenDoc {
  model: monaco.editor.ITextModel | null
  text?: string
  version: number
  changeSub?: monaco.IDisposable
  timer?: number
}

// Providers are registered once for the language; they read the live connection
// and the set of open documents from here. A single connection serves every
// open file.
let providersRegistered = false
let activeConnection: JsonRpcConnection | null = null
let clientReady = false
const openDocs = new Map<string, OpenDoc>()

// Loads a file's text by path, so definition targets in other files can be
// materialized as models (for peek and navigation). Set by the editor host.
let resolveFileText: ((path: string) => Promise<string | null>) | null = null
// Opens a file in the IDE and reveals a range, for go-to-definition across
// files. Set by the editor host.
let definitionOpener:
  | ((path: string, target: monaco.IRange | monaco.IPosition | undefined) => void)
  | null = null

export function setFileResolver(fn: (path: string) => Promise<string | null>): void {
  resolveFileText = fn
}

export function setDefinitionOpener(
  fn: (path: string, target: monaco.IRange | monaco.IPosition | undefined) => void,
): void {
  definitionOpener = fn
}

// One project-wide diagnostic, in editor coordinates (1-based).
export interface FileDiagnostic {
  file: string
  line: number
  column: number
  severity: 'error' | 'warning' | 'info'
  message: string
}

// Diagnostics from the server, keyed by file uri, so the Problems panel can show
// every project file's current errors, not just the open tab's.
const diagnosticsByUri = new Map<string, FileDiagnostic[]>()
let diagnosticsListener: ((all: FileDiagnostic[]) => void) | null = null

export function setDiagnosticsListener(fn: (all: FileDiagnostic[]) => void): void {
  diagnosticsListener = fn
  fn(flattenDiagnostics())
}

const LSP_SEVERITY: Record<number, FileDiagnostic['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'info',
}

function flattenDiagnostics(): FileDiagnostic[] {
  const all: FileDiagnostic[] = []
  for (const list of diagnosticsByUri.values()) all.push(...list)
  return all
}

// Convert a monaco resource path to the native path the IDE host opens and
// reads. A Windows file uri path is /C:/dir with a leading slash before the
// drive letter; strip it. Forward slashes are kept to match the host's path
// convention. A POSIX path (/Users/...) is returned unchanged.
function uriPathToNative(path: string): string {
  return /^\/[a-zA-Z]:\//.test(path) ? path.slice(1) : path
}

// Ensure a model exists at a uri with the file's content, so a peek widget can
// render its source and navigation can reveal it. The language is inferred from
// the uri extension.
async function ensureModelLoaded(uri: monaco.Uri): Promise<void> {
  if (monaco.editor.getModel(uri) || !resolveFileText) return
  const text = await resolveFileText(uriPathToNative(uri.path))
  if (text === null || monaco.editor.getModel(uri)) return
  monaco.editor.createModel(text, undefined, uri)
}

/// Connect to the language server and drive the LSP lifecycle. Documents are
/// registered per tab via the returned openModel/closeModel; one connection
/// serves them all. workspaceRoot is a file:// uri for the project, so the
/// server resolves the project's dependencies.
export function startPekoLanguageClient(
  workspaceRoot?: string,
  lspPort?: number,
): PekoLanguageClient {
  const url = `ws://127.0.0.1:${lspPort ?? DEFAULT_LSP_PORT}`
  const connection = new JsonRpcConnection(url)
  activeConnection = connection
  clientReady = false

  // Diagnostics carry the file they apply to. Set editor markers when the file
  // is open, and always keep the central store so the Problems panel shows every
  // project file's current errors.
  connection.onNotification('textDocument/publishDiagnostics', (raw) => {
    const params = raw as { uri: string; diagnostics: LspDiagnostic[] }
    const model = monaco.editor.getModel(monaco.Uri.parse(params.uri))
    if (model) monaco.editor.setModelMarkers(model, 'peko-lsp', params.diagnostics.map(toMarker))

    const file = monaco.Uri.parse(params.uri).path
    if (params.diagnostics.length === 0) {
      diagnosticsByUri.delete(params.uri)
    } else {
      diagnosticsByUri.set(
        params.uri,
        params.diagnostics.map((d) => ({
          file,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: LSP_SEVERITY[d.severity ?? 1] ?? 'error',
          message: d.message,
        })),
      )
    }
    diagnosticsListener?.(flattenDiagnostics())
  })

  // Requests the server may send that need a reply for the handshake to settle.
  connection.onRequest('workspace/configuration', (raw) => {
    const params = raw as { items: unknown[] }
    return params.items.map(() => null)
  })
  connection.onRequest('client/registerCapability', () => null)
  connection.onRequest('window/workDoneProgress/create', () => null)

  const sendDidOpen = (uri: string, doc: OpenDoc) => {
    connection.notify('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: PEKO_LANGUAGE_ID,
        version: doc.version,
        text: doc.model ? doc.model.getValue() : (doc.text ?? ''),
      },
    })
  }

  connection.onOpen = async () => {
    await connection.request('initialize', {
      processId: null,
      clientInfo: { name: 'peko-studio', version: '1.0.0' },
      rootUri: workspaceRoot ?? null,
      workspaceFolders: workspaceRoot
        ? [{ uri: workspaceRoot, name: 'workspace' }]
        : null,
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false },
          publishDiagnostics: { relatedInformation: true },
          completion: {
            completionItem: {
              snippetSupport: true,
              documentationFormat: ['markdown', 'plaintext'],
            },
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
        },
      },
    })
    connection.notify('initialized', {})
    clientReady = true
    // Announce any documents registered before the handshake completed.
    for (const [uri, doc] of openDocs) sendDidOpen(uri, doc)
  }

  if (!providersRegistered) {
    providersRegistered = true
    registerProviders()
  }

  const attachChangeSync = (uri: string, doc: OpenDoc, model: monaco.editor.ITextModel) => {
    // Full-document sync, debounced so a burst of keystrokes sends once.
    doc.changeSub = model.onDidChangeContent(() => {
      if (!clientReady) return
      if (doc.timer) window.clearTimeout(doc.timer)
      doc.timer = window.setTimeout(() => {
        doc.version += 1
        connection.notify('textDocument/didChange', {
          textDocument: { uri, version: doc.version },
          contentChanges: [{ text: model.getValue() }],
        })
      }, 250)
    })
  }

  const openBackground = (uri: string, text: string) => {
    if (openDocs.has(uri)) return
    const doc: OpenDoc = { model: null, text, version: 1 }
    openDocs.set(uri, doc)
    if (clientReady) sendDidOpen(uri, doc)
  }

  const openModel = (model: monaco.editor.ITextModel) => {
    const uri = model.uri.toString()
    const existing = openDocs.get(uri)
    if (existing) {
      if (existing.model === model) return
      // The file was already opened as a background doc; attach the editor model
      // and sync its current text.
      existing.model = model
      existing.text = undefined
      attachChangeSync(uri, existing, model)
      if (clientReady) {
        existing.version += 1
        connection.notify('textDocument/didChange', {
          textDocument: { uri, version: existing.version },
          contentChanges: [{ text: model.getValue() }],
        })
      }
      return
    }
    const doc: OpenDoc = { model, version: 1 }
    attachChangeSync(uri, doc, model)
    openDocs.set(uri, doc)
    if (clientReady) sendDidOpen(uri, doc)
  }

  const closeModel = (model: monaco.editor.ITextModel) => {
    const uri = model.uri.toString()
    const doc = openDocs.get(uri)
    if (!doc) return
    // Keep the document open on the server so its diagnostics stay in the
    // Problems panel; just detach the editor model and its change sync.
    doc.changeSub?.dispose()
    if (doc.timer) window.clearTimeout(doc.timer)
    doc.changeSub = undefined
    doc.timer = undefined
    doc.model = null
  }

  return {
    connection,
    openModel,
    closeModel,
    openBackground,
    dispose: () => {
      for (const doc of openDocs.values()) {
        doc.changeSub?.dispose()
        if (doc.timer) window.clearTimeout(doc.timer)
      }
      openDocs.clear()
      diagnosticsByUri.clear()
      diagnosticsListener?.([])
      if (activeConnection === connection) {
        activeConnection = null
        clientReady = false
      }
      connection.close()
    },
  }
}

function registerProviders(): void {
  monaco.languages.registerCompletionItemProvider(PEKO_LANGUAGE_ID, {
    triggerCharacters: ['.', ':'],
    async provideCompletionItems(model, position) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return { suggestions: [] }
      const result = (await activeConnection.request('textDocument/completion', {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as LspCompletionItem[] | { items: LspCompletionItem[] } | null
      const items = Array.isArray(result) ? result : (result?.items ?? [])
      const word = model.getWordUntilPosition(position)
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      )
      return { suggestions: items.map((item) => toCompletion(item, range)) }
    },
  })

  // Whole-file semantic highlighting. The legend order must match the server's
  // SEMANTIC_TOKEN_TYPES / SEMANTIC_TOKEN_MODIFIERS.
  const legend: monaco.languages.SemanticTokensLegend = {
    tokenTypes: [
      'namespace',
      'type',
      'class',
      'enum',
      'interface',
      'function',
      'method',
      'parameter',
      'variable',
      'property',
      'enumMember',
      'typeParameter',
    ],
    tokenModifiers: ['declaration'],
  }
  monaco.languages.registerDocumentSemanticTokensProvider(PEKO_LANGUAGE_ID, {
    getLegend: () => legend,
    async provideDocumentSemanticTokens(model) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return null
      const result = (await activeConnection.request('textDocument/semanticTokens/full', {
        textDocument: { uri },
      })) as { data: number[] } | null
      if (!result || !result.data) return null
      return { data: new Uint32Array(result.data) }
    },
    releaseDocumentSemanticTokens() {},
  })

  monaco.languages.registerHoverProvider(PEKO_LANGUAGE_ID, {
    async provideHover(model, position) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return null
      const result = (await activeConnection.request('textDocument/hover', {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as LspHover | null
      if (!result || !result.contents) return null
      return { contents: toHover(result.contents) }
    },
  })

  monaco.languages.registerSignatureHelpProvider(PEKO_LANGUAGE_ID, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return null
      const result = (await activeConnection.request('textDocument/signatureHelp', {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as LspSignatureHelp | null
      if (!result || !result.signatures?.length) return null
      return {
        value: {
          signatures: result.signatures.map((sig) => ({
            label: sig.label,
            documentation: toMarkup(sig.documentation),
            parameters: (sig.parameters ?? []).map((param) => ({
              label: param.label,
              documentation: toMarkup(param.documentation),
            })),
          })),
          activeSignature: result.activeSignature ?? 0,
          activeParameter: result.activeParameter ?? 0,
        },
        dispose: () => {},
      }
    },
  })

  monaco.languages.registerDefinitionProvider(PEKO_LANGUAGE_ID, {
    async provideDefinition(model, position) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return null
      const result = (await activeConnection.request('textDocument/definition', {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as LspLocation | LspLocation[] | null
      if (!result) return null
      const locations = Array.isArray(result) ? result : [result]
      // Materialize target models so a peek widget renders their source and
      // navigation can open them.
      await Promise.all(locations.map((loc) => ensureModelLoaded(monaco.Uri.parse(loc.uri))))
      return locations.map((loc) => ({
        uri: monaco.Uri.parse(loc.uri),
        range: toMonacoRange(loc.range),
      }))
    },
  })

  monaco.languages.registerReferenceProvider(PEKO_LANGUAGE_ID, {
    async provideReferences(model, position, context) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return []
      const result = (await activeConnection.request('textDocument/references', {
        textDocument: { uri },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
        context: { includeDeclaration: context.includeDeclaration },
      })) as LspLocation[] | null
      if (!result) return []
      await Promise.all(result.map((loc) => ensureModelLoaded(monaco.Uri.parse(loc.uri))))
      return result.map((loc) => ({
        uri: monaco.Uri.parse(loc.uri),
        range: toMonacoRange(loc.range),
      }))
    },
  })

  // Route opening a definition in another file to the editor host, which opens
  // a tab and reveals the target. Same-file navigation is handled by Monaco
  // without this.
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      if (!definitionOpener) return false
      definitionOpener(uriPathToNative(resource.path), selectionOrPosition)
      return true
    },
  })

  monaco.languages.registerDocumentFormattingEditProvider(PEKO_LANGUAGE_ID, {
    async provideDocumentFormattingEdits(model, options) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return []
      const result = (await activeConnection.request('textDocument/formatting', {
        textDocument: { uri },
        options: {
          tabSize: options.tabSize,
          insertSpaces: options.insertSpaces,
        },
      })) as LspTextEdit[] | null
      if (!result) return []
      return result.map((edit) => ({ range: toMonacoRange(edit.range), text: edit.newText }))
    },
  })

  monaco.languages.registerDocumentSymbolProvider(PEKO_LANGUAGE_ID, {
    async provideDocumentSymbols(model) {
      const uri = model.uri.toString()
      if (!activeConnection || !openDocs.has(uri)) return []
      return (await fetchDocumentSymbols(uri)).map(toMonacoDocumentSymbol)
    },
  })
}

const SYMBOL_KIND: Record<number, monaco.languages.SymbolKind> = {
  2: monaco.languages.SymbolKind.Module,
  3: monaco.languages.SymbolKind.Namespace,
  5: monaco.languages.SymbolKind.Class,
  6: monaco.languages.SymbolKind.Method,
  7: monaco.languages.SymbolKind.Property,
  8: monaco.languages.SymbolKind.Field,
  9: monaco.languages.SymbolKind.Constructor,
  10: monaco.languages.SymbolKind.Enum,
  11: monaco.languages.SymbolKind.Interface,
  12: monaco.languages.SymbolKind.Function,
  13: monaco.languages.SymbolKind.Variable,
  22: monaco.languages.SymbolKind.EnumMember,
  23: monaco.languages.SymbolKind.Struct,
}

function toMonacoDocumentSymbol(symbol: LspDocumentSymbol): monaco.languages.DocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail ?? '',
    kind: SYMBOL_KIND[symbol.kind] ?? monaco.languages.SymbolKind.Variable,
    tags: [],
    range: toMonacoRange(symbol.range),
    selectionRange: toMonacoRange(symbol.selectionRange),
    children: symbol.children?.map(toMonacoDocumentSymbol),
  }
}

const MARKER_SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
}

function toMarker(diagnostic: LspDiagnostic): monaco.editor.IMarkerData {
  return {
    severity: MARKER_SEVERITY[diagnostic.severity ?? 1] ?? monaco.MarkerSeverity.Error,
    message: diagnostic.message,
    source: diagnostic.source ?? 'peko',
    startLineNumber: diagnostic.range.start.line + 1,
    startColumn: diagnostic.range.start.character + 1,
    endLineNumber: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
  }
}

const COMPLETION_KIND: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  4: monaco.languages.CompletionItemKind.Constructor,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  8: monaco.languages.CompletionItemKind.Interface,
  9: monaco.languages.CompletionItemKind.Module,
  10: monaco.languages.CompletionItemKind.Property,
  11: monaco.languages.CompletionItemKind.Unit,
  12: monaco.languages.CompletionItemKind.Value,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  15: monaco.languages.CompletionItemKind.Snippet,
  20: monaco.languages.CompletionItemKind.EnumMember,
  21: monaco.languages.CompletionItemKind.Constant,
  22: monaco.languages.CompletionItemKind.Struct,
  25: monaco.languages.CompletionItemKind.TypeParameter,
}

function toMonacoRange(range: LspRange): monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  }
}

function toMarkup(value: LspMarkup | undefined): monaco.IMarkdownString | string | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : { value: value.value }
}

function toCompletion(
  item: LspCompletionItem,
  range: monaco.IRange,
): monaco.languages.CompletionItem {
  const kind = COMPLETION_KIND[item.kind ?? 1] ?? monaco.languages.CompletionItemKind.Text

  // After accepting a module path (`json::`) immediately re-open suggestions so
  // its members are offered without a second keystroke.
  const retrigger = kind === monaco.languages.CompletionItemKind.Module
  const command = item.command
    ? { id: item.command.command, title: item.command.title, arguments: item.command.arguments }
    : retrigger
      ? { id: 'editor.action.triggerSuggest', title: 'Suggest' }
      : undefined

  return {
    label: item.label,
    kind,
    insertText: item.insertText ?? item.label,
    insertTextRules:
      item.insertTextFormat === 2
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
    detail: item.detail,
    documentation: toMarkup(item.documentation),
    // The server groups items by a numeric sort key; keep it so the popup keeps
    // that order instead of falling back to alphabetical.
    sortText: item.sortText,
    filterText: item.filterText,
    additionalTextEdits: item.additionalTextEdits?.map((edit) => ({
      range: toMonacoRange(edit.range),
      text: edit.newText,
    })),
    command,
    range,
  }
}

function toHover(contents: LspHover['contents']): monaco.IMarkdownString[] {
  if (typeof contents === 'string') return [{ value: contents }]
  if (Array.isArray(contents)) {
    return contents.map((entry) =>
      typeof entry === 'string'
        ? { value: entry }
        : { value: '```' + entry.language + '\n' + entry.value + '\n```' },
    )
  }
  return [{ value: contents.value }]
}
