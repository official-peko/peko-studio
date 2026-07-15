// Monaco bootstrap: worker wiring, the PekoScript language, and a dark theme.
//
// The base editor worker drives PekoScript (syntax from the Monarch grammar,
// semantics from the language server over the bridge). The language-service
// workers give the built-in languages (TypeScript, JSON, CSS, HTML) their own
// completion, hover, and validation.
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { registerThemes } from './themes'

// Vite bundles each worker; hand Monaco a factory that builds the right one
// locally so the editor works offline inside the webview.
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

export const PEKO_LANGUAGE_ID = 'pekoscript'

let registered = false

/// Register the PekoScript language, its Monarch tokenizer, and the theme.
/// Safe to call more than once.
export function registerPekoLanguage(): void {
  if (registered) return
  registered = true

  monaco.languages.register({ id: PEKO_LANGUAGE_ID, extensions: ['.peko'], aliases: ['PekoScript', 'peko'] })

  monaco.languages.setLanguageConfiguration(PEKO_LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    // Angle brackets are deliberately not a bracket pair. They are ambiguous
    // with comparison and the return-type arrow, and pairing them makes bracket
    // colorization mark a lone `>` (as in `=>`) as an unmatched bracket.
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '`', close: '`' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '`', close: '`' },
    ],
  })

  monaco.languages.setMonarchTokensProvider(PEKO_LANGUAGE_ID, {
    defaultToken: '',
    tokenPostfix: '.peko',

    keywords: [
      'fn', 'let', 'class', 'trait', 'enum', 'constructor', 'from', 'import',
      'export', 'return', 'if', 'else', 'while', 'for', 'in', 'switch', 'case',
      'default', 'break', 'continue', 'new', 'this', 'closure', 'as', 'else',
      'danger_cast', 'constant', 'true', 'false', 'None', 'Error', 'Ok',
    ],

    typeKeywords: [
      'i1', 'i8', 'i16', 'i32', 'i64', 'i128', 'f16', 'f32', 'f64', 'number',
      'string', 'bool', 'char', 'void', 'opaque', 'cstr', 'pointer', 'Array',
      'Map', 'Option',
    ],

    attributes: [
      'public', 'private', 'mutates', 'hide', 'static', 'serial', 'override',
    ],

    operators: [
      '=', '>', '<', '!', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '+',
      '-', '*', '/', '%', '=>', '.', '&',
    ],

    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"'`]|x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/,

    // The recognized PekoX HTML tag names, longest first so `<article` does not
    // match the shorter `<a`.
    htmlTags:
      /figcaption|blockquote|textarea|template|progress|optgroup|noscript|menuitem|frameset|fieldset|datalist|colgroup|basefont|summary|section|noembed|marquee|isindex|details|caption|bgsound|article|address|acronym|strong|strike|spacer|source|script|output|option|object|legend|keygen|iframe|hgroup|header|footer|figure|dialog|center|canvas|button|applet|video|track|title|tfoot|tbody|table|small|param|meter|label|input|frame|embed|audio|aside|time|span|samp|ruby|nobr|meta|mark|main|html|head|form|font|data|code|cite|body|base|area|abbr|xmp|wbr|var|svg|sup|sub|pre|nav|kbd|ins|img|div|dir|dfn|del|col|big|bdo|bdi|ul|tt|tr|td|rt|rp|li|hr|h6|h5|h4|h3|h2|h1|em|dt|dl|dd|br|u|q|p|i|b|a/,

    tokenizer: {
      root: [
        // Attributes like [public] or [public hide].
        [/\[[a-zA-Z][\w ]*\]/, 'annotation'],

        // PekoX tags. Only the recognized HTML tag names are matched, so a
        // generic like `Array<string>` is never mistaken for a tag. A trailing
        // negative lookahead keeps a longer word (`<article`) from matching a
        // shorter tag (`<a`).
        [/(<\/)(@htmlTags)(\s*>)/, ['delimiter.tag', 'tag', 'delimiter.tag']],
        [
          /(<)(@htmlTags)(?![\w-])/,
          ['delimiter.tag', { token: 'tag', next: '@tag' }],
        ],

        // `demo` is a contextual keyword: highlighted only when it leads a
        // `demo { ... }` block, and left an identifier everywhere else.
        [/\bdemo\b(?=\s*\{)/, 'keyword'],

        // Identifiers and keywords.
        [/[a-zA-Z_]\w*(?=\s*::)/, 'namespace'],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@attributes': 'keyword',
              '@default': 'identifier',
            },
          },
        ],

        // Whitespace and comments.
        { include: '@whitespace' },

        // Numbers.
        [/\d+\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/\d+/, 'number'],

        // Delimiters and operators. The return-type arrow is matched before the
        // general operator run so it gets its own token.
        [/[{}()[\]]/, '@brackets'],
        [/=>/, 'operator.arrow'],
        [
          /@symbols/,
          { cases: { '@operators': 'operator', '@default': '' } },
        ],

        // Strings.
        [/"/, { token: 'string.quote', next: '@string' }],
        [/`/, { token: 'string.quote', next: '@template' }],
        [/'[^'\\]'/, 'string'],
        [/'\\.'/, 'string'],
      ],

      whitespace: [
        [/\s+/, 'white'],
        [/\/\/\/.*$/, 'comment.doc'],
        [/\/\/!.*$/, 'comment.doc'],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, { token: 'comment', next: '@blockComment' }],
      ],

      blockComment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, { token: 'comment', next: '@pop' }],
        [/[/*]/, 'comment'],
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }],
      ],

      template: [
        [/\$\{/, { token: 'delimiter.bracket', next: '@templateExpr' }],
        [/[^\\`$]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/`/, { token: 'string.quote', next: '@pop' }],
      ],

      templateExpr: [
        [/\}/, { token: 'delimiter.bracket', next: '@pop' }],
        { include: '@root' },
      ],

      // Inside a PekoX opening tag: attributes until `>` or `/>`.
      tag: [
        [/\s+/, 'white'],
        [/(\/?>)/, { token: 'delimiter.tag', next: '@pop' }],
        [/[a-zA-Z][\w-]*(?=\s*=)/, 'attribute.name'],
        [/=/, 'delimiter'],
        [/"[^"]*"/, 'attribute.value'],
        [/`[^`]*`/, 'attribute.value'],
        // An expression attribute value `{ ... }`.
        [/\{/, { token: 'delimiter.bracket', next: '@templateExpr' }],
        // A bare boolean attribute.
        [/[a-zA-Z][\w-]*/, 'attribute.name'],
      ],
    },
  })

  registerThemes()
}
