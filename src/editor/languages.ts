// Language detection and extras for the built-in file types Peko Studio opens
// alongside .peko: TypeScript/JavaScript, JSON, HTML, CSS/SCSS/Sass/Less,
// Markdown, TOML, YAML, XML. Monaco ships language services for most of these;
// this maps file extensions to their language id, registers a small TOML
// grammar, and turns on Emmet for markup and styles.
import * as monaco from 'monaco-editor'
import { emmetHTML, emmetCSS, emmetJSX } from 'emmet-monaco-es'
import { PEKO_LANGUAGE_ID } from './monacoSetup'
import { registerPekoTomlSupport } from './pekoToml'
import { configureBuiltinLanguages } from './builtinLanguages'
import { registerTsSemanticTokens } from './tsSemanticTokens'

// File extension (without the dot) to Monaco language id.
const EXTENSION_LANGUAGE: Record<string, string> = {
  peko: PEKO_LANGUAGE_ID,
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  md: 'markdown',
  markdown: 'markdown',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
}

/// The Monaco language id for a file path, or 'plaintext' when unknown.
export function languageForPath(path: string): string {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
  const id = EXTENSION_LANGUAGE[ext] ?? 'plaintext'
  // Fall back to plaintext when a mapped language is not actually registered
  // (e.g. an older Monaco build without yaml/toml basics).
  if (id !== 'plaintext' && !monaco.languages.getLanguages().some((l) => l.id === id)) {
    return 'plaintext'
  }
  return id
}

// A small Monarch grammar for TOML: comments, tables, keys, strings, numbers,
// booleans, and dates. Monaco has no built-in TOML language.
const TOML_GRAMMAR: monaco.languages.IMonarchLanguage = {
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/\[\[.*?\]\]/, 'type'],
      [/\[.*?\]/, 'type'],
      [/[A-Za-z0-9_.-]+(?=\s*=)/, 'key'],
      [/=/, 'operator'],
      [/"""/, { token: 'string', next: '@mstring' }],
      [/"/, { token: 'string', next: '@string' }],
      [/'''/, { token: 'string', next: '@mlitstring' }],
      [/'/, { token: 'string', next: '@litstring' }],
      [/\b(true|false)\b/, 'keyword'],
      [/\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?/, 'number'],
      [/[+-]?\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?/, 'number'],
      [/0x[0-9a-fA-F_]+/, 'number.hex'],
    ],
    string: [
      [/[^\\"]+/, 'string'],
      [/\\./, 'string.escape'],
      [/"/, { token: 'string', next: '@pop' }],
    ],
    mstring: [
      [/[^"]+/, 'string'],
      [/"""/, { token: 'string', next: '@pop' }],
      [/"/, 'string'],
    ],
    litstring: [
      [/[^']+/, 'string'],
      [/'/, { token: 'string', next: '@pop' }],
    ],
    mlitstring: [
      [/[^']+/, 'string'],
      [/'''/, { token: 'string', next: '@pop' }],
      [/'/, 'string'],
    ],
  },
}

let registered = false

/// Register languages Monaco does not ship (TOML) and turn on Emmet for markup
/// and styles. Safe to call more than once.
export function registerLanguageExtras(): void {
  if (registered) return
  registered = true

  // Configure the built-in language services (TS/JS compiler options for
  // JSX/TSX, JSON validation) so their full feature set - completion, hover,
  // signature help, diagnostics, symbols/breadcrumbs, formatting - is active.
  configureBuiltinLanguages()

  // Semantic highlighting for TS/JS (Monaco ships the classifier but does not
  // wire it up), so identifiers color by kind like .peko.
  registerTsSemanticTokens()

  if (!monaco.languages.getLanguages().some((l) => l.id === 'toml')) {
    monaco.languages.register({ id: 'toml', extensions: ['.toml'] })
    monaco.languages.setLanguageConfiguration('toml', {
      comments: { lineComment: '#' },
      brackets: [
        ['[', ']'],
        ['{', '}'],
      ],
      autoClosingPairs: [
        { open: '[', close: ']' },
        { open: '{', close: '}' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
    })
    monaco.languages.setMonarchTokensProvider('toml', TOML_GRAMMAR)
  }

  // Schema-aware completion and validation for peko.toml.
  registerPekoTomlSupport()

  // Emmet: HTML abbreviations in markup, CSS abbreviations in style languages,
  // and JSX abbreviations in TS/JS.
  emmetHTML(monaco, ['html'])
  emmetCSS(monaco, ['css', 'scss', 'sass', 'less'])
  emmetJSX(monaco, ['javascript', 'typescript'])
}
