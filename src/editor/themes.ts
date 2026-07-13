// Editor + shell theme registry. Each theme has a Monaco editor theme (built
// from a palette) and a matching shell palette selected in CSS by the
// data-theme attribute on the document root.
import * as monaco from 'monaco-editor'

export interface PekoTheme {
  id: string
  name: string
  type: 'dark' | 'light'
}

interface Palette {
  base: monaco.editor.BuiltinTheme
  editorBg: string
  keyword: string
  type: string
  namespace: string
  func: string
  variable: string
  string: string
  number: string
  comment: string
  operator: string
}

const PALETTES: Record<string, Palette> = {
  'peko-dark': {
    base: 'vs-dark',
    editorBg: '1b1b1f',
    keyword: 'c586c0',
    type: '4ec9b0',
    namespace: '4fc1ff',
    func: 'dcdcaa',
    variable: '9cdcfe',
    string: 'ce9178',
    number: 'b5cea8',
    comment: '6a9955',
    operator: 'd4d4d4',
  },
  midnight: {
    base: 'vs-dark',
    editorBg: '0f111a',
    keyword: 'ff7b9c',
    type: '82d2ce',
    namespace: '7aa2f7',
    func: 'e0af68',
    variable: 'c0caf5',
    string: '9ece6a',
    number: 'ff9e64',
    comment: '565f89',
    operator: '89ddff',
  },
  'peko-light': {
    base: 'vs',
    editorBg: 'fbfbfd',
    keyword: 'af00db',
    type: '267f99',
    namespace: '001080',
    func: '795e26',
    variable: '001080',
    string: 'a31515',
    number: '098658',
    comment: '008000',
    operator: '333333',
  },
  daylight: {
    base: 'vs',
    editorBg: 'ffffff',
    keyword: 'ad3da4',
    type: '3f6e75',
    namespace: '703daa',
    func: '703daa',
    variable: '0f68a0',
    string: 'd12f1b',
    number: '272ad8',
    comment: '707f8c',
    operator: '272c36',
  },
  'xcode-dark': {
    base: 'vs-dark',
    editorBg: '292a30',
    keyword: 'fc5fa3',
    type: '5dd8ff',
    namespace: 'd0a8ff',
    func: '67b7a4',
    variable: 'acf2e4',
    string: 'fc6a5d',
    number: 'd0bf69',
    comment: '7f8c98',
    operator: 'dfdfe0',
  },
  'github-dark': {
    base: 'vs-dark',
    editorBg: '0d1117',
    keyword: 'ff7b72',
    type: '79c0ff',
    namespace: '79c0ff',
    func: 'd2a8ff',
    variable: 'ffa657',
    string: 'a5d6ff',
    number: '79c0ff',
    comment: '8b949e',
    operator: 'c9d1d9',
  },
  'one-dark': {
    base: 'vs-dark',
    editorBg: '282c34',
    keyword: 'c678dd',
    type: 'e5c07b',
    namespace: '61afef',
    func: '61afef',
    variable: 'e06c75',
    string: '98c379',
    number: 'd19a66',
    comment: '5c6370',
    operator: 'abb2bf',
  },
}

export const THEMES: PekoTheme[] = [
  { id: 'peko-dark', name: 'Peko Dark', type: 'dark' },
  { id: 'xcode-dark', name: 'Xcode Dark', type: 'dark' },
  { id: 'midnight', name: 'Midnight', type: 'dark' },
  { id: 'github-dark', name: 'GitHub Dark', type: 'dark' },
  { id: 'one-dark', name: 'One Dark', type: 'dark' },
  { id: 'peko-light', name: 'Peko Light', type: 'light' },
  { id: 'daylight', name: 'Daylight (Xcode)', type: 'light' },
]

function rules(p: Palette): monaco.editor.ITokenThemeRule[] {
  return [
    { token: 'keyword', foreground: p.keyword },
    { token: 'operator.arrow', foreground: p.keyword },
    { token: 'type', foreground: p.type },
    { token: 'class', foreground: p.type },
    { token: 'enum', foreground: p.type },
    { token: 'interface', foreground: p.type },
    { token: 'typeParameter', foreground: p.type },
    { token: 'namespace', foreground: p.namespace },
    { token: 'enumMember', foreground: p.namespace },
    { token: 'function', foreground: p.func },
    { token: 'method', foreground: p.func },
    { token: 'annotation', foreground: p.func },
    { token: 'variable', foreground: p.variable },
    { token: 'parameter', foreground: p.variable },
    { token: 'property', foreground: p.variable },
    { token: 'string', foreground: p.string },
    { token: 'number', foreground: p.number },
    { token: 'comment', foreground: p.comment },
    { token: 'comment.doc', foreground: p.comment, fontStyle: 'italic' },
    { token: 'operator', foreground: p.operator },
    // PekoX tags.
    { token: 'tag', foreground: p.type },
    { token: 'delimiter.tag', foreground: p.operator },
    { token: 'attribute.name', foreground: p.variable },
    { token: 'attribute.value', foreground: p.string },
  ]
}

let registered = false

/// Define every Monaco editor theme. Idempotent.
export function registerThemes(): void {
  if (registered) return
  registered = true
  for (const [id, palette] of Object.entries(PALETTES)) {
    monaco.editor.defineTheme(id, {
      base: palette.base,
      inherit: true,
      rules: rules(palette),
      colors: { 'editor.background': `#${palette.editorBg}` },
    })
  }
}

/// Apply a theme to both the Monaco editors and the app shell. Falls back to
/// the first theme for an unknown id.
export function applyTheme(id: string): void {
  registerThemes()
  const theme = THEMES.find((t) => t.id === id) ?? THEMES[0]
  monaco.editor.setTheme(theme.id)
  document.documentElement.dataset.theme = theme.id
}
