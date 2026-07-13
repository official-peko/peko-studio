import { Fragment } from 'react'

/// A token with the CSS class that colors it.
type Tok = { text: string; cls: string }

export type Lang = 'js' | 'json' | 'html' | 'css' | 'text' | 'auto'

const KEYWORDS = new Set([
  'var', 'let', 'const', 'function', 'return', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'new', 'delete', 'typeof', 'instanceof', 'in', 'of', 'this',
  'class', 'extends', 'super', 'try', 'catch', 'finally', 'throw', 'await', 'async', 'yield',
  'void', 'default', 'export', 'import', 'from',
])
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

const IDENT = /[A-Za-z_$][\w$]*/y
const NUMBER = /-?(?:0x[0-9a-fA-F]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)/y
const WS = /\s+/y

/// Tokenize JavaScript / JSON.
function tokenizeJs(code: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = code.length
  const push = (text: string, cls: string) => toks.push({ text, cls })
  const peekColon = (from: number) => {
    let j = from
    while (j < n && /\s/.test(code[j])) j += 1
    return code[j] === ':'
  }
  while (i < n) {
    const ch = code[i]
    WS.lastIndex = i
    const ws = WS.exec(code)
    if (ws && ws.index === i) {
      push(ws[0], 'plain')
      i = WS.lastIndex
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1
      while (j < n) {
        if (code[j] === '\\') {
          j += 2
          continue
        }
        if (code[j] === ch) {
          j += 1
          break
        }
        j += 1
      }
      push(code.slice(i, j), peekColon(j) ? 'key' : 'str')
      i = j
      continue
    }
    if (ch === '/' && code[i + 1] === '/') {
      let j = i
      while (j < n && code[j] !== '\n') j += 1
      push(code.slice(i, j), 'com')
      i = j
      continue
    }
    if (ch === '/' && code[i + 1] === '*') {
      const end = code.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      push(code.slice(i, j), 'com')
      i = j
      continue
    }
    NUMBER.lastIndex = i
    const num = NUMBER.exec(code)
    if (num && num.index === i && /[0-9]/.test(ch === '-' ? code[i + 1] ?? '' : ch)) {
      push(num[0], 'num')
      i = NUMBER.lastIndex
      continue
    }
    IDENT.lastIndex = i
    const id = IDENT.exec(code)
    if (id && id.index === i) {
      const word = id[0]
      let cls = 'ident'
      if (KEYWORDS.has(word)) cls = 'kw'
      else if (LITERALS.has(word)) cls = 'lit'
      else if (peekColon(i + word.length)) cls = 'key'
      push(word, cls)
      i = IDENT.lastIndex
      continue
    }
    if ('{}[]()<>.,;:'.includes(ch)) {
      push(ch, 'punct')
      i += 1
      continue
    }
    push(ch, 'op')
    i += 1
  }
  return toks
}

/// Tokenize HTML: tags, attribute names, quoted values, comments, and text.
function tokenizeHtml(code: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = code.length
  const push = (text: string, cls: string) => text && toks.push({ text, cls })
  while (i < n) {
    if (code.startsWith('<!--', i)) {
      const end = code.indexOf('-->', i + 4)
      const j = end === -1 ? n : end + 3
      push(code.slice(i, j), 'com')
      i = j
      continue
    }
    if (code[i] === '<') {
      let j = i + 1
      if (code[j] === '/') j += 1
      const nameStart = j
      while (j < n && /[\w:-]/.test(code[j])) j += 1
      push(code.slice(i, nameStart), 'punct')
      push(code.slice(nameStart, j), 'tag')
      // Attributes until '>'.
      while (j < n && code[j] !== '>') {
        const c = code[j]
        if (c === '"' || c === "'") {
          const q = c
          let k = j + 1
          while (k < n && code[k] !== q) k += 1
          push(code.slice(j, Math.min(k + 1, n)), 'str')
          j = k + 1
        } else if (/[A-Za-z_:-]/.test(c)) {
          let k = j
          while (k < n && /[\w:-]/.test(code[k])) k += 1
          push(code.slice(j, k), 'key')
          j = k
        } else {
          push(c, 'punct')
          j += 1
        }
      }
      if (j < n) {
        push('>', 'punct')
        j += 1
      }
      i = j
      continue
    }
    // Text run until the next tag.
    let j = i
    while (j < n && code[j] !== '<') j += 1
    push(code.slice(i, j), 'plain')
    i = j
  }
  return toks
}

/// Tokenize CSS: selectors, properties, values, strings, comments.
function tokenizeCss(code: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  const n = code.length
  const push = (text: string, cls: string) => text && toks.push({ text, cls })
  let inBlock = false
  let expectValue = false
  while (i < n) {
    const ch = code[i]
    if (code.startsWith('/*', i)) {
      const end = code.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      push(code.slice(i, j), 'com')
      i = j
      continue
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < n && code[j] !== ch) j += 1
      push(code.slice(i, Math.min(j + 1, n)), 'str')
      i = j + 1
      continue
    }
    if (ch === '{') {
      inBlock = true
      expectValue = false
      push(ch, 'punct')
      i += 1
      continue
    }
    if (ch === '}') {
      inBlock = false
      push(ch, 'punct')
      i += 1
      continue
    }
    if (ch === ':' && inBlock) {
      expectValue = true
      push(ch, 'punct')
      i += 1
      continue
    }
    if (ch === ';') {
      expectValue = false
      push(ch, 'punct')
      i += 1
      continue
    }
    if (/\s/.test(ch)) {
      let j = i
      while (j < n && /\s/.test(code[j])) j += 1
      push(code.slice(i, j), 'plain')
      i = j
      continue
    }
    let j = i
    while (j < n && !/[\s{}:;"']/.test(code[j]) && !code.startsWith('/*', j)) j += 1
    const word = code.slice(i, j)
    push(word, !inBlock ? 'tag' : expectValue ? 'num' : 'key')
    i = j
  }
  return toks
}

/// Best-effort HTML re-indentation so a one-line outerHTML reads as a tree.
export function reindentHtml(html: string): string {
  const VOID = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param',
    'source', 'track', 'wbr',
  ])
  const tokens = html.replace(/>\s+</g, '><').match(/<[^>]+>|[^<]+/g) || []
  let depth = 0
  const out: string[] = []
  const pad = () => '  '.repeat(Math.max(0, depth))
  for (const raw of tokens) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('<')) {
      const isClose = t.startsWith('</')
      const isComment = t.startsWith('<!')
      const name = (t.match(/^<\/?\s*([\w:-]+)/) || [])[1] || ''
      const selfClose = t.endsWith('/>') || VOID.has(name.toLowerCase()) || isComment
      if (isClose) depth = Math.max(0, depth - 1)
      out.push(pad() + t)
      if (!isClose && !selfClose) depth += 1
    } else {
      out.push(pad() + t)
    }
  }
  return out.join('\n')
}

function detectLang(code: string): Lang {
  const t = code.trimStart()
  if (t.startsWith('<')) return 'html'
  if (t.startsWith('{') || t.startsWith('[')) return 'json'
  return 'js'
}

/// Render highlighted code. `lang` selects the tokenizer; 'auto' detects it.
/// When `pretty` and the content is HTML, it is re-indented first.
export function Highlight({ code, lang = 'auto', pretty = false }: { code: string; lang?: Lang; pretty?: boolean }) {
  const resolved = lang === 'auto' ? detectLang(code) : lang
  let text = code
  if (pretty && resolved === 'html') text = reindentHtml(code)
  let toks: Tok[]
  if (resolved === 'html') toks = tokenizeHtml(text)
  else if (resolved === 'css') toks = tokenizeCss(text)
  else if (resolved === 'text') toks = [{ text, cls: 'plain' }]
  else toks = tokenizeJs(text)
  return (
    <>
      {toks.map((t, i) => (
        <Fragment key={i}>
          {t.cls === 'plain' ? t.text : <span className={`hl-${t.cls}`}>{t.text}</span>}
        </Fragment>
      ))}
    </>
  )
}
