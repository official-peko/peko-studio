import { useMemo } from 'react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

/// Renders Markdown text to sanitized HTML. Used for the preview pane of a .md
/// file; the text is the live editor content.
export function MarkdownPreview({ text }: { text: string }) {
  const html = useMemo(() => {
    const rendered = marked.parse(text, { async: false }) as string
    return DOMPurify.sanitize(rendered)
  }, [text])

  return <div className="markdown-preview" dangerouslySetInnerHTML={{ __html: html }} />
}
