// File-type icons for the explorer and tabs. The Peko mark comes from the
// peko-zed editor icon; language files use their official brand logos from
// simple-icons; images, folders, and unknown files use small drawn glyphs.
import {
  siTypescript,
  siReact,
  siJavascript,
  siJson,
  siHtml5,
  siCss,
  siSass,
  siMarkdown,
  siToml,
  siYaml,
  siGnubash,
  siSvg,
} from 'simple-icons'

interface SimpleIcon {
  path: string
  hex: string
}

// The Peko logo mark. The path data and viewBox are from the peko-zed icon; the
// three primary shapes are kept and drawn in the Peko accent color.
export function PekoMark() {
  return (
    <svg
      className="ficon"
      viewBox="687.41 360.04 93.85 67.09"
      fill="#8a7bff"
      aria-hidden="true"
    >
      <path
        d="M35.46 0.12 L0 62.27 0.85 63.49 29.37 63.61 31.68 62.27 50.82 29.13 51.06 25.71 36.56 0 35.46 0.12 z"
        transform="translate(687.91,363.03)"
        fillOpacity="0.95"
      />
      <path
        d="M0 0 L29.73 0 31.32 1.1 45.45 25.35 45.45 29.37 32.17 52.89 29.73 54.59 14.99 27.42 Z"
        transform="translate(735.32,362.66)"
        fillOpacity="0.6"
      />
      <path
        d="M30.1 26.44 L0.61 26.57 0 25.47 14.87 0 30.1 26.44 z"
        transform="translate(735.19,390.93)"
        fillOpacity="0.6"
      />
    </svg>
  )
}

// An official brand logo from simple-icons, drawn in the given color (usually
// the brand color, but overridden for near-black marks so they read on a dark
// theme).
function BrandIcon({ icon, color }: { icon: SimpleIcon; color: string }) {
  return (
    <svg className="ficon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={icon.path} fill={color} />
    </svg>
  )
}

// A closed or open folder outline in the current text color.
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg className="ficon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {open ? (
        <path
          d="M1.5 3.5h4l1.2 1.5H14a.5.5 0 0 1 .5.5v1H3.6a1 1 0 0 0-.96.73L1.5 12V4a.5.5 0 0 1 .5-.5Zm1.1 4h12.2l-1.5 4.8a.6.6 0 0 1-.57.4H2.2a.5.5 0 0 1-.48-.65L2.6 8.2a.6.6 0 0 1 .57-.4Z"
          fill="currentColor"
          fillOpacity="0.7"
        />
      ) : (
        <path
          d="M1.5 4a.5.5 0 0 1 .5-.5h4l1.2 1.5H14a.5.5 0 0 1 .5.5v6.5a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5V4Z"
          fill="currentColor"
          fillOpacity="0.7"
        />
      )}
    </svg>
  )
}

// A labelled rounded-square badge for file kinds with no brand logo.
function Badge({ label, bg, fg = '#ffffff' }: { label: string; bg: string; fg?: string }) {
  const size = label.length >= 3 ? 4.4 : 6
  return (
    <svg className="ficon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill={bg} />
      <text
        x="8"
        y="8"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={size}
        fontWeight="700"
        fontFamily="ui-sans-serif, system-ui, sans-serif"
        fill={fg}
      >
        {label}
      </text>
    </svg>
  )
}

// A photo glyph for image files: a framed picture with a sun and mountains.
function ImageIcon() {
  return (
    <svg className="ficon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect
        x="2"
        y="3"
        width="12"
        height="10"
        rx="1.6"
        stroke="#4ab3a0"
        strokeWidth="1.2"
        fill="rgba(74,179,160,0.14)"
      />
      <circle cx="5.6" cy="6.3" r="1.1" fill="#4ab3a0" />
      <path d="M3 12l3-3.2 2.2 2 2.3-2.6L13 12Z" fill="#4ab3a0" />
    </svg>
  )
}

// A plain document outline for unrecognized files.
function DocIcon() {
  return (
    <svg className="ficon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 1.75h5L12.5 5.2V13.25a1 1 0 0 1-1 1h-7.5a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="1.1"
        fill="none"
      />
      <path d="M9 1.75V5.2h3.4" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.1" />
    </svg>
  )
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// Readable colors for brand marks whose official hue is near-black.
const JSON_COLOR = '#e0b83a'
const MARKDOWN_COLOR = '#9aa4b2'

/// The icon for a tree or tab entry, chosen by directory state or file
/// extension.
export function FileIcon({
  name,
  dir = false,
  expanded = false,
}: {
  name: string
  dir?: boolean
  expanded?: boolean
}) {
  if (dir) return <FolderIcon open={expanded} />

  switch (extensionOf(name)) {
    case 'peko':
      return <PekoMark />
    case 'ts':
    case 'mts':
    case 'cts':
      return <BrandIcon icon={siTypescript} color={`#${siTypescript.hex}`} />
    case 'tsx':
    case 'jsx':
      return <BrandIcon icon={siReact} color={`#${siReact.hex}`} />
    case 'js':
    case 'mjs':
    case 'cjs':
      return <BrandIcon icon={siJavascript} color={`#${siJavascript.hex}`} />
    case 'json':
    case 'jsonc':
      return <BrandIcon icon={siJson} color={JSON_COLOR} />
    case 'html':
    case 'htm':
      return <BrandIcon icon={siHtml5} color={`#${siHtml5.hex}`} />
    case 'css':
      return <BrandIcon icon={siCss} color={`#${siCss.hex}`} />
    case 'scss':
    case 'sass':
      return <BrandIcon icon={siSass} color={`#${siSass.hex}`} />
    case 'md':
    case 'markdown':
      return <BrandIcon icon={siMarkdown} color={MARKDOWN_COLOR} />
    case 'toml':
      return <BrandIcon icon={siToml} color={`#${siToml.hex}`} />
    case 'yaml':
    case 'yml':
      return <BrandIcon icon={siYaml} color={`#${siYaml.hex}`} />
    case 'sh':
    case 'bash':
      return <BrandIcon icon={siGnubash} color={`#${siGnubash.hex}`} />
    case 'svg':
      return <BrandIcon icon={siSvg} color={`#${siSvg.hex}`} />
    case 'less':
      return <Badge label="less" bg="#1d365d" />
    case 'xml':
      return <Badge label="<>" bg="#e07b39" />
    case 'lock':
      return <Badge label="=" bg="#6b7280" />
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
    case 'bmp':
    case 'ico':
    case 'avif':
      return <ImageIcon />
    default:
      return <DocIcon />
  }
}
