// Configuration and feature glue for the languages Monaco ships a service for
// (TypeScript/JavaScript, JSON, CSS/SCSS/LESS, HTML). Registering the language
// and wiring its worker (monacoSetup) is enough to get completion, hover,
// signature help, diagnostics, definition, references, rename, formatting,
// folding, and document symbols. Two things still need explicit setup:
//
//   1. The TypeScript/JavaScript service needs compiler options before it will
//      parse JSX/TSX or resolve modules; without them .jsx/.tsx files show
//      syntax errors and produce no symbol tree (so no breadcrumbs/outline).
//   2. Breadcrumbs read a document-symbol tree. The peko LSP serves .peko; the
//      built-in languages serve theirs through Monaco's own provider registry,
//      which has no public "run the providers" call. getBuiltinDocumentSymbols
//      drives the registry through Monaco's OutlineModel and normalizes the
//      result to the same LSP-shaped tree the peko path returns.
import * as monaco from 'monaco-editor'
// Internal Monaco modules: the standalone services locator, the language
// features registry, and the outline builder that runs document-symbol
// providers. These are not part of the public surface but are stable across
// the 0.5x line and are how a symbol tree is obtained without VS Code's
// workbench.
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices'
import { ILanguageFeaturesService } from 'monaco-editor/esm/vs/editor/common/services/languageFeatures'
import { OutlineModel } from 'monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/outlineModel'
import { PEKO_LANGUAGE_ID } from './monacoSetup'
import { fetchDocumentSymbols, type LspDocumentSymbol } from '../lsp/pekoLsp'

let configured = false

/// Configure the built-in language services. Safe to call more than once.
export function configureBuiltinLanguages(): void {
  if (configured) return
  configured = true

  const ts = monaco.languages.typescript
  // One option set for both TS and JS. allowJs + the jsx setting let the same
  // service parse .js/.jsx/.ts/.tsx; the module settings make imports resolve
  // the way a modern bundler (Vite) does.
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    // The automatic runtime (react/jsx-runtime), like Vite. This does not
    // require React to be in scope, so JSX files without `import React` do not
    // flood with "Cannot find name 'React'".
    jsx: ts.JsxEmit.ReactJSX,
    jsxImportSource: 'react',
    allowJs: true,
    // Type-check JavaScript/JSX too, so .js/.jsx files report real errors
    // (undefined names, bad JSX, wrong argument counts), not just syntax.
    checkJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    lib: ['esnext', 'dom', 'dom.iterable'],
  }
  ts.typescriptDefaults.setCompilerOptions(compilerOptions)
  ts.javascriptDefaults.setCompilerOptions(compilerOptions)

  // The @peko/client globals: a Peko app's bridge config is injected on window,
  // but the package's types come from node_modules, which the worker cannot
  // resolve. Declare them so window.__PEKO__ / window.peko do not error.
  const pekoGlobals = [
    'interface Window {',
    '  __PEKO__?: {',
    '    url?: string',
    '    token?: string | null',
    '    initialRoute?: string',
    '    frameless?: boolean',
    '    nativeControls?: boolean',
    '    htmlMenu?: boolean',
    '    devtools?: boolean',
    '    popup?: boolean',
    '    popupId?: string',
    '    [key: string]: unknown',
    '  }',
    '  peko?: unknown',
    '  __peko_deeplink?: (path: string) => void',
    '}',
    '',
  ].join('\n')
  ts.typescriptDefaults.addExtraLib(pekoGlobals, 'file:///peko-globals.d.ts')
  ts.javascriptDefaults.addExtraLib(pekoGlobals, 'file:///peko-globals.d.ts')
  // Keep every open model synced into the worker so cross-file features
  // (definition, references, rename) work across tabs, not just the active one.
  ts.typescriptDefaults.setEagerModelSync(true)
  ts.javascriptDefaults.setEagerModelSync(true)
  // Full validation. A project opened without its node_modules types would
  // otherwise flood the editor with "cannot find module" errors; keep semantic
  // checks on but silence the unresolved-import diagnostics.
  const diagnostics = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    noSuggestionDiagnostics: false,
    // 2307 cannot-find-module, 2792 module-resolution hint, 7016 no-types.
    diagnosticCodesToIgnore: [2307, 2792, 7016],
  }
  ts.typescriptDefaults.setDiagnosticsOptions(diagnostics)
  ts.javascriptDefaults.setDiagnosticsOptions(diagnostics)

  // JSON: validate, allow comments (jsonc), and keep schema errors as errors.
  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    schemaValidation: 'error',
    enableSchemaRequest: false,
  })

  // CSS-family and HTML services default to validation on; leave them as-is.
}

// Monaco DocumentSymbol -> the LSP-shaped node the breadcrumb bar consumes.
// Monaco ranges are 1-based (line/column); LSP is 0-based (line/character).
// Monaco SymbolKind is 0-based and LSP SymbolKind is 1-based, so kinds differ
// by exactly one.
function toLspRange(range: monaco.IRange): LspDocumentSymbol['range'] {
  return {
    start: { line: range.startLineNumber - 1, character: range.startColumn - 1 },
    end: { line: range.endLineNumber - 1, character: range.endColumn - 1 },
  }
}

interface MonacoDocumentSymbol {
  name: string
  detail: string
  kind: number
  range: monaco.IRange
  selectionRange: monaco.IRange
  children?: MonacoDocumentSymbol[]
}

function toLspSymbol(symbol: MonacoDocumentSymbol): LspDocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail || undefined,
    kind: symbol.kind + 1,
    range: toLspRange(symbol.range),
    selectionRange: toLspRange(symbol.selectionRange),
    children: symbol.children?.map(toLspSymbol),
  }
}

/// Document symbols for a built-in-language model, from Monaco's registered
/// providers (the TS/JSON/CSS/HTML workers). Empty when no provider is
/// registered or the model has no symbols yet.
export async function getBuiltinDocumentSymbols(
  model: monaco.editor.ITextModel,
): Promise<LspDocumentSymbol[]> {
  const features = StandaloneServices.get(ILanguageFeaturesService) as {
    documentSymbolProvider: { has(model: monaco.editor.ITextModel): boolean }
  }
  const registry = features.documentSymbolProvider
  if (!registry.has(model)) return []
  const source = new monaco.CancellationTokenSource()
  try {
    const outline = await OutlineModel.create(registry, model, source.token)
    const roots = outline.getTopLevelSymbols() as unknown as MonacoDocumentSymbol[]
    return roots.map(toLspSymbol)
  } catch {
    return []
  } finally {
    source.dispose()
  }
}

/// The document-symbol tree for any model: the peko language server for .peko,
/// Monaco's providers for the built-in languages. This is what the breadcrumb
/// bar and any outline view read, so both source classes get breadcrumbs.
export async function getDocumentSymbols(
  model: monaco.editor.ITextModel,
): Promise<LspDocumentSymbol[]> {
  if (model.getLanguageId() === PEKO_LANGUAGE_ID) {
    return fetchDocumentSymbols(model.uri.toString())
  }
  return getBuiltinDocumentSymbols(model)
}
