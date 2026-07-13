// Minimal typings for the internal Monaco modules used to drive the built-in
// languages' document-symbol providers (see builtinLanguages.ts). These modules
// are not part of monaco-editor's public typings but are stable across 0.5x.
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices' {
  export const StandaloneServices: {
    get<T>(id: T): unknown
  }
}

declare module 'monaco-editor/esm/vs/editor/common/services/languageFeatures' {
  export const ILanguageFeaturesService: unknown
}

declare module 'monaco-editor/esm/vs/editor/contrib/documentSymbols/browser/outlineModel' {
  import type * as monaco from 'monaco-editor'
  export class OutlineModel {
    static create(
      registry: unknown,
      model: monaco.editor.ITextModel,
      token: monaco.CancellationToken,
    ): Promise<OutlineModel>
    getTopLevelSymbols(): unknown[]
    asListOfDocumentSymbols(): unknown[]
  }
}
