import * as monaco from 'monaco-editor'

/// Semantic highlighting for TypeScript/JavaScript, bridged from the Monaco TS
/// worker's classifier. Monaco ships the classifier but does not wire it to a
/// DocumentSemanticTokensProvider, so identifiers only get Monarch (syntactic)
/// colors. This provider asks the worker for the 2020-format classifications
/// and maps them onto the same legend the .peko provider uses, so the theme
/// colors TS/JS identifiers exactly like .peko (variable vs function vs type).

// The legend token-type names match the theme rules in themes.ts.
const LEGEND: monaco.languages.SemanticTokensLegend = {
  tokenTypes: [
    'namespace', 'type', 'class', 'enum', 'interface', 'function', 'method',
    'parameter', 'variable', 'property', 'enumMember', 'typeParameter',
  ],
  tokenModifiers: ['declaration'],
}

// The TS classifier's type index order is: class, enum, interface, namespace,
// typeParameter, type, parameter, variable, enumMember, property, function,
// member. Map each onto our legend index.
const TS_TYPE_TO_LEGEND = [2, 3, 4, 0, 11, 1, 7, 8, 10, 9, 5, 6]

const provider: monaco.languages.DocumentSemanticTokensProvider = {
  getLegend: () => LEGEND,
  async provideDocumentSemanticTokens(model) {
    let worker: unknown
    try {
      // A .js/.jsx model is served by the JavaScript worker, a .ts/.tsx model by
      // the TypeScript worker; asking the wrong one returns no classifications.
      const getWorker =
        model.getLanguageId() === 'javascript'
          ? await monaco.languages.typescript.getJavaScriptWorker()
          : await monaco.languages.typescript.getTypeScriptWorker()
      worker = await getWorker(model.uri)
    } catch {
      return null
    }
    const value = model.getValue()
    let result: { spans?: number[] } | undefined
    try {
      // getEncodedSemanticClassifications is on the worker but not in its public
      // types, so reach it through an untyped call.
      result = await (
        worker as {
          getEncodedSemanticClassifications: (
            fileName: string,
            span: { start: number; length: number },
            format: string,
          ) => Promise<{ spans?: number[] }>
        }
      ).getEncodedSemanticClassifications(model.uri.toString(), { start: 0, length: value.length }, '2020')
    } catch {
      return null
    }

    const spans = result?.spans ?? []
    const data: number[] = []
    let prevLine = 0
    let prevChar = 0
    // spans is a flat [start, length, classification] triple array in char
    // offsets; classification = (typeIndex + 1) << 8 | modifierSet.
    for (let i = 0; i + 2 < spans.length; i += 3) {
      const start = spans[i]
      const length = spans[i + 1]
      const tsType = (spans[i + 2] >> 8) - 1
      if (tsType < 0 || tsType >= TS_TYPE_TO_LEGEND.length) continue
      const pos = model.getPositionAt(start)
      const line = pos.lineNumber - 1
      const char = pos.column - 1
      const deltaLine = line - prevLine
      const deltaChar = deltaLine === 0 ? char - prevChar : char
      data.push(deltaLine, deltaChar, length, TS_TYPE_TO_LEGEND[tsType], 0)
      prevLine = line
      prevChar = char
    }
    return { data: new Uint32Array(data) }
  },
  releaseDocumentSemanticTokens() {},
}

let registered = false

/// Register the TS/JS semantic-tokens provider once.
export function registerTsSemanticTokens(): void {
  if (registered) return
  registered = true
  for (const lang of ['typescript', 'javascript']) {
    monaco.languages.registerDocumentSemanticTokensProvider(lang, provider)
  }
}
