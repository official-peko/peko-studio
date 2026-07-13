// Visual app-icon builder: a layered compositor over an HTML canvas. Layers
// stack from bottom to top (background, shapes, images, text), each with color,
// scale, offset, and rotation. The editor renders a square master at full
// resolution and previews how each platform masks it (iOS squircle, Android
// circle, macOS rounded). Save writes the master PNG plus the layered document
// into assets/ and records both in peko.toml's [icon] table, so the build picks
// the icon up and the document can be reopened for more edits.
import { useEffect, useRef, useState } from 'react'
import {
  loadIconDoc,
  loadManifest,
  saveIcon,
  ICON_PLATFORMS,
  type IconArtifacts,
  type IconDoc,
  type IconPlatform,
} from './workspace'

// The editing target: the shared base design or one platform's override.
type Target = 'all' | IconPlatform

// The kinds of layer the builder composites.
type LayerType = 'background' | 'shape' | 'image' | 'text'

interface Layer {
  id: string
  type: LayerType
  name: string
  hidden?: boolean
  // background
  fill?: 'solid' | 'gradient'
  color?: string
  color2?: string
  angle?: number
  // shape
  shape?: string
  // shared placement (shape, image, text)
  scale?: number
  offsetX?: number
  offsetY?: number
  rotation?: number
  // image
  src?: string
  rounding?: number
  // text
  text?: string
  size?: number
  weight?: number
  font?: string
}

// The built-in generic shapes. All are plain geometry, no third-party artwork.
const SHAPES = [
  'circle',
  'square',
  'rounded',
  'squircle',
  'triangle',
  'diamond',
  'pentagon',
  'hexagon',
  'star',
]

const FONTS = ['system-ui', 'Georgia, serif', 'Menlo, monospace', 'Trebuchet MS', 'Impact']
const WEIGHTS = [
  { label: 'Regular', value: 400 },
  { label: 'Medium', value: 500 },
  { label: 'Semibold', value: 600 },
  { label: 'Bold', value: 700 },
  { label: 'Black', value: 900 },
]

// The platform preview masks, in display order. Each shows how that platform
// specializes the icon: macOS and iOS a squircle, Android the adaptive circle,
// Windows and Linux a square. The build routes every platform from the saved
// master (plus the Android adaptive layers), so these mirror the shipped icons.
const MASKS: { key: string; label: string }[] = [
  { key: 'macos', label: 'macOS' },
  { key: 'ios', label: 'iOS' },
  { key: 'android', label: 'Android' },
  { key: 'windows', label: 'Windows' },
  { key: 'linux', label: 'Linux' },
]

// The Apple squircle: a rounded rectangle with continuous (superellipse)
// corners, centered at (cx, cy) with half-side r. `k` is the corner size as a
// fraction of the half-side. Flat sides meet the bounding box; the corners use
// exponent 5. This mirrors the shape the bundler bakes into the app icon, so
// the preview matches the shipped icon.
function squircle(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, k = 0.4474) {
  const straight = r * (1 - k)
  const corner = r * k
  const steps = 240
  ctx.beginPath()
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2
    const ct = Math.cos(t)
    const st = Math.sin(t)
    const ex = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / 5)
    const ey = Math.sign(st) * Math.pow(Math.abs(st), 2 / 5)
    const x = cx + Math.sign(ct) * straight + ex * corner
    const y = cy + Math.sign(st) * straight + ey * corner
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function regularPolygon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  sides: number,
  rot: number,
) {
  ctx.beginPath()
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2
    const x = cx + Math.cos(a) * r
    const y = cy + Math.sin(a) * r
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  const points = 5
  const inner = r * 0.42
  ctx.beginPath()
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : inner
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2
    const x = cx + Math.cos(a) * rad
    const y = cy + Math.sin(a) * rad
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Build the path for a shape layer, centered at (0, 0) with radius r.
function shapePath(ctx: CanvasRenderingContext2D, shape: string, r: number) {
  switch (shape) {
    case 'square':
      ctx.beginPath()
      ctx.rect(-r, -r, r * 2, r * 2)
      ctx.closePath()
      return
    case 'rounded':
      roundRectPath(ctx, -r, -r, r * 2, r * 2, r * 0.36)
      return
    case 'squircle':
      squircle(ctx, 0, 0, r)
      return
    case 'triangle':
      regularPolygon(ctx, 0, 0, r, 3, -Math.PI / 2)
      return
    case 'diamond':
      regularPolygon(ctx, 0, 0, r, 4, -Math.PI / 2)
      return
    case 'pentagon':
      regularPolygon(ctx, 0, 0, r, 5, -Math.PI / 2)
      return
    case 'hexagon':
      regularPolygon(ctx, 0, 0, r, 6, -Math.PI / 2)
      return
    case 'star':
      starPath(ctx, 0, 0, r)
      return
    default:
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2)
      ctx.closePath()
  }
}

// Clip the context to a platform preview mask over a canvas of the given size.
function clipMask(ctx: CanvasRenderingContext2D, mask: string, size: number) {
  const half = size / 2
  if (mask === 'android') {
    ctx.beginPath()
    ctx.arc(half, half, half, 0, Math.PI * 2)
    ctx.closePath()
  } else if (mask === 'macos' || mask === 'ios') {
    // macOS and iOS bake a full-bleed squircle.
    squircle(ctx, half, half, half)
  } else {
    // Windows and Linux use a square icon: clip to the full bounds (a no-op
    // shape) so the preview shows the unrounded master.
    ctx.beginPath()
    ctx.rect(0, 0, size, size)
    ctx.closePath()
  }
  ctx.clip()
}

// The linear-gradient endpoints across a square of the given size at an angle.
function gradientCoords(size: number, angleDeg: number): [number, number, number, number] {
  const a = (angleDeg * Math.PI) / 180
  const half = size / 2
  const dx = Math.cos(a)
  const dy = Math.sin(a)
  return [half - dx * half, half - dy * half, half + dx * half, half + dy * half]
}

function paintLayer(
  ctx: CanvasRenderingContext2D,
  size: number,
  layer: Layer,
  images: Map<string, HTMLImageElement>,
) {
  if (layer.hidden) return

  if (layer.type === 'background') {
    if (layer.fill === 'gradient') {
      const [x0, y0, x1, y1] = gradientCoords(size, layer.angle ?? 90)
      const g = ctx.createLinearGradient(x0, y0, x1, y1)
      g.addColorStop(0, layer.color ?? '#000000')
      g.addColorStop(1, layer.color2 ?? layer.color ?? '#000000')
      ctx.fillStyle = g
    } else {
      ctx.fillStyle = layer.color ?? '#000000'
    }
    ctx.fillRect(0, 0, size, size)
    return
  }

  ctx.save()
  const cx = size / 2 + (layer.offsetX ?? 0) * size
  const cy = size / 2 + (layer.offsetY ?? 0) * size
  ctx.translate(cx, cy)
  if (layer.rotation) ctx.rotate((layer.rotation * Math.PI) / 180)

  if (layer.type === 'shape') {
    const r = ((layer.scale ?? 0.6) * size) / 2
    ctx.fillStyle = layer.color ?? '#ffffff'
    shapePath(ctx, layer.shape ?? 'circle', r)
    ctx.fill()
  } else if (layer.type === 'image' && layer.src) {
    const img = images.get(layer.src)
    if (img && img.complete && img.naturalWidth > 0) {
      const box = (layer.scale ?? 0.8) * size
      const ar = img.naturalWidth / img.naturalHeight
      let w = box
      let h = box
      if (ar > 1) h = box / ar
      else w = box * ar
      if (layer.rounding && layer.rounding > 0) {
        roundRectPath(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * layer.rounding)
        ctx.clip()
      }
      ctx.drawImage(img, -w / 2, -h / 2, w, h)
    }
  } else if (layer.type === 'text') {
    const px = (layer.size ?? 0.4) * size
    ctx.fillStyle = layer.color ?? '#ffffff'
    ctx.font = `${layer.weight ?? 700} ${px}px ${layer.font ?? 'system-ui'}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(layer.text ?? '', 0, 0)
  }
  ctx.restore()
}

// Fraction of the adaptive icon the launcher always shows (72dp of 108dp). The
// foreground is drawn inside this zone so no launcher mask clips it.
const ANDROID_SAFE_ZONE = 72 / 108

// Paint the Android adaptive composition: the background layers fill the tile,
// the foreground layers are scaled into the safe zone, and the whole thing is
// clipped to the launcher's circle mask. A dashed ring marks the safe zone.
function paintAndroidAdaptive(
  canvas: HTMLCanvasElement | null,
  size: number,
  layers: Layer[],
  images: Map<string, HTMLImageElement>,
) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const half = size / 2
  const background = layers.filter((l) => l.type === 'background')
  const foreground = layers.filter((l) => l.type !== 'background')

  ctx.clearRect(0, 0, size, size)
  ctx.save()
  ctx.beginPath()
  ctx.arc(half, half, half, 0, Math.PI * 2)
  ctx.clip()

  if (background.length === 0) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, size, size)
  }
  for (const layer of background) paintLayer(ctx, size, layer, images)

  ctx.save()
  ctx.translate(half, half)
  ctx.scale(ANDROID_SAFE_ZONE, ANDROID_SAFE_ZONE)
  ctx.translate(-half, -half)
  for (const layer of foreground) paintLayer(ctx, size, layer, images)
  ctx.restore()
  ctx.restore()

  ctx.save()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)'
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(half, half, half * ANDROID_SAFE_ZONE, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
}

// Composite every layer into a context of the given pixel size, optionally
// clipped to a platform mask.
function paintAll(
  canvas: HTMLCanvasElement | null,
  size: number,
  layers: Layer[],
  images: Map<string, HTMLImageElement>,
  mask: string | null,
) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, size, size)
  ctx.save()
  if (mask) clipMask(ctx, mask, size)
  for (const layer of layers) paintLayer(ctx, size, layer, images)
  ctx.restore()
}

const MASTER_SIZE = 1024
const EDIT_SIZE = 448
const PREVIEW_SIZE = 168

let idCounter = 0
function nextId(): string {
  idCounter += 1
  return `layer-${idCounter}`
}

function defaultLayers(initial: string): Layer[] {
  return [
    {
      id: nextId(),
      type: 'background',
      name: 'Background',
      fill: 'gradient',
      color: '#6d5efc',
      color2: '#a48bff',
      angle: 135,
    },
    {
      id: nextId(),
      type: 'text',
      name: 'Text',
      text: initial,
      color: '#ffffff',
      size: 0.46,
      weight: 700,
      font: 'system-ui',
      offsetX: 0,
      offsetY: 0,
    },
  ]
}

// Re-key a loaded layer stack with fresh ids.
function adopt(stack: Record<string, unknown>[]): Layer[] {
  return stack.map((l) => ({ ...(l as Layer), id: nextId() }))
}

// Strip the runtime id before persisting a layer stack.
function strip(layers: Layer[]): Record<string, unknown>[] {
  return layers.map(({ id: _id, ...rest }) => rest)
}

export function IconBuilder({ root, onClose }: { root: string; onClose: () => void }) {
  // The shared base design, plus a distinct layer stack per platform that
  // overrides it. A platform with no entry inherits the base.
  const [base, setBase] = useState<Layer[]>([])
  const [overrides, setOverrides] = useState<Partial<Record<IconPlatform, Layer[]>>>({})
  const [target, setTarget] = useState<Target>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [tick, setTick] = useState(0)

  const imagesRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const editRef = useRef<HTMLCanvasElement | null>(null)
  const previewRefs = useRef<Record<string, HTMLCanvasElement | null>>({})
  const fileRef = useRef<HTMLInputElement | null>(null)

  // The layers a platform ships: its override when present, else the base.
  const effectiveLayers = (platform: IconPlatform): Layer[] => overrides[platform] ?? base
  // The stack the current target edits, and whether it is editable. A platform
  // with no override shows the base read-only until it is customized.
  const activeLayers = target === 'all' ? base : overrides[target] ?? base
  const editable = target === 'all' || overrides[target] !== undefined

  // Apply an update to the current target's layer stack.
  function setActiveLayers(updater: (prev: Layer[]) => Layer[]) {
    if (target === 'all') {
      setBase(updater)
    } else {
      const key = target
      setOverrides((prev) => ({ ...prev, [key]: updater(prev[key] ?? []) }))
    }
  }

  // Load a saved document to reopen, otherwise seed a default from the project
  // name's initial.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const doc = await loadIconDoc(root)
      if (cancelled) return
      if (doc && doc.layers.length > 0) {
        setBase(adopt(doc.layers))
        const loadedOverrides: Partial<Record<IconPlatform, Layer[]>> = {}
        for (const platform of ICON_PLATFORMS) {
          const stack = doc.overrides?.[platform]
          if (stack && stack.length > 0) loadedOverrides[platform] = adopt(stack)
        }
        setOverrides(loadedOverrides)
        setSelectedId(null)
        return
      }
      const manifest = await loadManifest(root)
      if (cancelled) return
      const initial = (manifest?.name ?? 'P').trim().charAt(0).toUpperCase() || 'P'
      const seed = defaultLayers(initial)
      setBase(seed)
      setSelectedId(seed[seed.length - 1].id)
    })()
    return () => {
      cancelled = true
    }
  }, [root])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Ensure a decoded image exists for every image layer; a load bumps the tick
  // so the affected canvases repaint.
  function ensureImage(src: string) {
    if (imagesRef.current.has(src)) return
    const img = new Image()
    img.onload = () => setTick((t) => t + 1)
    img.src = src
    imagesRef.current.set(src, img)
  }

  // Repaint the editor canvas (the active target) and every platform preview
  // (each platform's effective layers). Images across the base and all overrides
  // are decoded so every preview paints.
  useEffect(() => {
    for (const layer of base) {
      if (layer.type === 'image' && layer.src) ensureImage(layer.src)
    }
    for (const platform of ICON_PLATFORMS) {
      for (const layer of overrides[platform] ?? []) {
        if (layer.type === 'image' && layer.src) ensureImage(layer.src)
      }
    }
    const images = imagesRef.current
    paintAll(editRef.current, EDIT_SIZE, activeLayers, images, null)
    for (const mask of MASKS) {
      const canvas = previewRefs.current[mask.key] ?? null
      const platform = mask.key as IconPlatform
      const layers = effectiveLayers(platform)
      // The Android preview shows the real adaptive composition; the others mask
      // the flat master to the platform shape.
      if (platform === 'android') {
        paintAndroidAdaptive(canvas, PREVIEW_SIZE, layers, images)
      } else {
        paintAll(canvas, PREVIEW_SIZE, layers, images, platform)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, overrides, target, tick])

  const selected = activeLayers.find((l) => l.id === selectedId) ?? null

  function updateLayer(id: string, patch: Partial<Layer>) {
    setActiveLayers((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  // Start a per-platform override from a copy of the base design.
  function customize(platform: IconPlatform) {
    setOverrides((prev) => ({ ...prev, [platform]: base.map((l) => ({ ...l, id: nextId() })) }))
    setSelectedId(null)
  }

  // Drop a platform's override so it falls back to the shared base.
  function clearOverride(platform: IconPlatform) {
    setOverrides((prev) => {
      const next = { ...prev }
      delete next[platform]
      return next
    })
    setSelectedId(null)
  }

  function addLayer(type: LayerType) {
    let layer: Layer
    if (type === 'background') {
      layer = { id: nextId(), type, name: 'Background', fill: 'solid', color: '#101426' }
    } else if (type === 'shape') {
      layer = {
        id: nextId(),
        type,
        name: 'Shape',
        shape: 'circle',
        color: '#ffd166',
        scale: 0.6,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
      }
    } else if (type === 'text') {
      layer = {
        id: nextId(),
        type,
        name: 'Text',
        text: 'A',
        color: '#ffffff',
        size: 0.4,
        weight: 700,
        font: 'system-ui',
        offsetX: 0,
        offsetY: 0,
      }
    } else {
      fileRef.current?.click()
      return
    }
    setActiveLayers((prev) => [...prev, layer])
    setSelectedId(layer.id)
  }

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const src = String(reader.result)
      const layer: Layer = {
        id: nextId(),
        type: 'image',
        name: file.name.replace(/\.[^.]+$/, '') || 'Image',
        src,
        scale: 0.8,
        offsetX: 0,
        offsetY: 0,
        rotation: 0,
        rounding: 0,
      }
      setActiveLayers((prev) => [...prev, layer])
      setSelectedId(layer.id)
    }
    reader.readAsDataURL(file)
  }

  function removeLayer(id: string) {
    setActiveLayers((prev) => prev.filter((l) => l.id !== id))
    if (selectedId === id) setSelectedId(null)
  }

  // Move a layer one step toward the top (later in the draw order).
  function move(id: string, dir: 1 | -1) {
    setActiveLayers((prev) => {
      const i = prev.findIndex((l) => l.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  // Composite a subset of layers into a fresh master-size canvas and return its
  // PNG as base64. `whiteBase` fills an opaque white backdrop first, used for
  // the Android background layer when the design has no background of its own.
  function renderBase64(subset: Layer[], whiteBase: boolean): string {
    const canvas = document.createElement('canvas')
    canvas.width = MASTER_SIZE
    canvas.height = MASTER_SIZE
    const ctx = canvas.getContext('2d')
    if (ctx) {
      if (whiteBase) {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, MASTER_SIZE, MASTER_SIZE)
      }
      for (const layer of subset) paintLayer(ctx, MASTER_SIZE, layer, imagesRef.current)
    }
    const dataUrl = canvas.toDataURL('image/png')
    return dataUrl.slice(dataUrl.indexOf(',') + 1)
  }

  async function save() {
    setSaving(true)
    setError('')
    setStatus('')

    const master = renderBase64(base, false)

    // Android adaptive split: background layers form the background, everything
    // else the foreground the launcher keeps in the safe zone. The Android
    // override supplies these when present, otherwise the base does.
    const androidSource = overrides.android ?? base
    const androidBackground = androidSource.filter((l) => l.type === 'background')
    const androidForeground = androidSource.filter((l) => l.type !== 'background')

    // A flat PNG and stored stack for each platform that has an override.
    const overridePngs: Partial<Record<IconPlatform, string>> = {}
    const docOverrides: Partial<Record<IconPlatform, Record<string, unknown>[]>> = {}
    for (const platform of ICON_PLATFORMS) {
      const stack = overrides[platform]
      if (stack && stack.length > 0) {
        overridePngs[platform] = renderBase64(stack, false)
        docOverrides[platform] = strip(stack)
      }
    }

    const artifacts: IconArtifacts = {
      master,
      androidForeground: renderBase64(androidForeground, false),
      androidBackground: renderBase64(androidBackground, androidBackground.length === 0),
      overrides: overridePngs,
      doc: { version: 2, layers: strip(base), overrides: docOverrides },
    }
    const err = await saveIcon(root, artifacts)
    setSaving(false)
    if (err) {
      setError(err)
      return
    }
    setStatus('Saved. The next build uses these icons.')
  }

  return (
    <div
      className="icon-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="icon-card" role="dialog" aria-label="Icon builder">
        <div className="icon-head">
          <h2>App Icon Builder</h2>
          <button type="button" className="settings-x" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="icon-targets">
          <button
            type="button"
            className={`icon-target${target === 'all' ? ' active' : ''}`}
            onClick={() => {
              setTarget('all')
              setSelectedId(null)
            }}
          >
            All Platforms
          </button>
          {MASKS.map((m) => {
            const platform = m.key as IconPlatform
            return (
              <button
                key={m.key}
                type="button"
                className={`icon-target${target === platform ? ' active' : ''}${
                  overrides[platform] ? ' customized' : ''
                }`}
                title={
                  overrides[platform]
                    ? `${m.label} has a custom icon`
                    : `${m.label} uses the shared design`
                }
                onClick={() => {
                  setTarget(platform)
                  setSelectedId(null)
                }}
              >
                {m.label}
                {overrides[platform] && <span className="icon-target-dot" />}
              </button>
            )
          })}
        </div>

        {target !== 'all' && (
          <div className="icon-override-banner">
            {editable ? (
              <>
                <span>Custom {MASKS.find((m) => m.key === target)?.label} icon.</span>
                <button type="button" onClick={() => clearOverride(target)}>
                  Reset to shared design
                </button>
              </>
            ) : (
              <>
                <span>{MASKS.find((m) => m.key === target)?.label} uses the shared design.</span>
                <button type="button" onClick={() => customize(target)}>
                  Customize for {MASKS.find((m) => m.key === target)?.label}
                </button>
              </>
            )}
          </div>
        )}

        <div className="icon-body">
          <div className="icon-layers">
            <div className="icon-add">
              <button type="button" disabled={!editable} onClick={() => addLayer('background')} title="Add a background">
                Background
              </button>
              <button type="button" disabled={!editable} onClick={() => addLayer('shape')} title="Add a shape">
                Shape
              </button>
              <button type="button" disabled={!editable} onClick={() => addLayer('image')} title="Add an image">
                Image
              </button>
              <button type="button" disabled={!editable} onClick={() => addLayer('text')} title="Add text">
                Text
              </button>
            </div>
            <ul className="icon-layer-list">
              {[...activeLayers]
                .map((l, i) => ({ l, i }))
                .reverse()
                .map(({ l, i }) => (
                  <li
                    key={l.id}
                    className={`icon-layer-row${l.id === selectedId ? ' selected' : ''}`}
                    onClick={() => setSelectedId(l.id)}
                  >
                    <button
                      type="button"
                      className="icon-eye"
                      title={l.hidden ? 'Show layer' : 'Hide layer'}
                      disabled={!editable}
                      onClick={(e) => {
                        e.stopPropagation()
                        updateLayer(l.id, { hidden: !l.hidden })
                      }}
                    >
                      {l.hidden ? '○' : '●'}
                    </button>
                    <span className="icon-layer-name">{l.name}</span>
                    <span className="icon-layer-type">{l.type}</span>
                    <button
                      type="button"
                      className="icon-mini"
                      title="Move up"
                      disabled={!editable || i === activeLayers.length - 1}
                      onClick={(e) => {
                        e.stopPropagation()
                        move(l.id, 1)
                      }}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="icon-mini"
                      title="Move down"
                      disabled={!editable || i === 0}
                      onClick={(e) => {
                        e.stopPropagation()
                        move(l.id, -1)
                      }}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="icon-mini icon-del"
                      title="Delete layer"
                      disabled={!editable}
                      onClick={(e) => {
                        e.stopPropagation()
                        removeLayer(l.id)
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
            </ul>
          </div>

          <div className="icon-stage">
            <canvas
              ref={editRef}
              width={EDIT_SIZE}
              height={EDIT_SIZE}
              className="icon-edit-canvas"
            />
            <div className="icon-previews">
              {MASKS.map((m) => (
                <div key={m.key} className="icon-preview">
                  <canvas
                    ref={(el) => {
                      previewRefs.current[m.key] = el
                    }}
                    width={PREVIEW_SIZE}
                    height={PREVIEW_SIZE}
                  />
                  <span>{m.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="icon-props">
            {!editable ? (
              <p className="icon-empty">Customize this platform to edit its layers.</p>
            ) : selected ? (
              <LayerProps layer={selected} onChange={(patch) => updateLayer(selected.id, patch)} />
            ) : (
              <p className="icon-empty">Select a layer to edit its properties.</p>
            )}
          </div>
        </div>

        <div className="icon-foot">
          {error && <span className="settings-error">{error}</span>}
          {status && <span className="icon-status">{status}</span>}
          <span className="settings-actions-spacer" />
          <button type="button" className="settings-cancel" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="settings-save"
            disabled={saving || base.length === 0}
            onClick={save}
          >
            {saving ? 'Saving...' : 'Save Icon'}
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onPickImage}
        />
      </div>
    </div>
  )
}

function Range({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <label className="icon-range">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="icon-color">
      <span>{label}</span>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function LayerProps({ layer, onChange }: { layer: Layer; onChange: (patch: Partial<Layer>) => void }) {
  return (
    <div className="icon-prop-panel">
      <label className="icon-name-field">
        <span>Name</span>
        <input value={layer.name} onChange={(e) => onChange({ name: e.target.value })} />
      </label>

      {layer.type === 'background' && (
        <>
          <label className="icon-select">
            <span>Fill</span>
            <select
              value={layer.fill ?? 'solid'}
              onChange={(e) => onChange({ fill: e.target.value as 'solid' | 'gradient' })}
            >
              <option value="solid">Solid</option>
              <option value="gradient">Gradient</option>
            </select>
          </label>
          <ColorField label="Color" value={layer.color ?? '#000000'} onChange={(v) => onChange({ color: v })} />
          {layer.fill === 'gradient' && (
            <>
              <ColorField
                label="Color 2"
                value={layer.color2 ?? '#ffffff'}
                onChange={(v) => onChange({ color2: v })}
              />
              <Range
                label="Angle"
                value={layer.angle ?? 90}
                min={0}
                max={360}
                step={1}
                onChange={(v) => onChange({ angle: v })}
              />
            </>
          )}
        </>
      )}

      {layer.type === 'shape' && (
        <>
          <label className="icon-select">
            <span>Shape</span>
            <select value={layer.shape ?? 'circle'} onChange={(e) => onChange({ shape: e.target.value })}>
              {SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <ColorField label="Color" value={layer.color ?? '#ffffff'} onChange={(v) => onChange({ color: v })} />
          <Range label="Size" value={layer.scale ?? 0.6} min={0.1} max={1.2} step={0.01} onChange={(v) => onChange({ scale: v })} />
          <Range label="Rotation" value={layer.rotation ?? 0} min={0} max={360} step={1} onChange={(v) => onChange({ rotation: v })} />
          <Range label="Offset X" value={layer.offsetX ?? 0} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ offsetX: v })} />
          <Range label="Offset Y" value={layer.offsetY ?? 0} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ offsetY: v })} />
        </>
      )}

      {layer.type === 'image' && (
        <>
          <Range label="Size" value={layer.scale ?? 0.8} min={0.1} max={1.2} step={0.01} onChange={(v) => onChange({ scale: v })} />
          <Range label="Corner" value={layer.rounding ?? 0} min={0} max={0.5} step={0.01} onChange={(v) => onChange({ rounding: v })} />
          <Range label="Rotation" value={layer.rotation ?? 0} min={0} max={360} step={1} onChange={(v) => onChange({ rotation: v })} />
          <Range label="Offset X" value={layer.offsetX ?? 0} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ offsetX: v })} />
          <Range label="Offset Y" value={layer.offsetY ?? 0} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ offsetY: v })} />
        </>
      )}

      {layer.type === 'text' && (
        <>
          <label className="icon-name-field">
            <span>Text</span>
            <input value={layer.text ?? ''} onChange={(e) => onChange({ text: e.target.value })} />
          </label>
          <ColorField label="Color" value={layer.color ?? '#ffffff'} onChange={(v) => onChange({ color: v })} />
          <label className="icon-select">
            <span>Font</span>
            <select value={layer.font ?? 'system-ui'} onChange={(e) => onChange({ font: e.target.value })}>
              {FONTS.map((f) => (
                <option key={f} value={f}>
                  {f.split(',')[0]}
                </option>
              ))}
            </select>
          </label>
          <label className="icon-select">
            <span>Weight</span>
            <select value={layer.weight ?? 700} onChange={(e) => onChange({ weight: Number(e.target.value) })}>
              {WEIGHTS.map((w) => (
                <option key={w.value} value={w.value}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <Range label="Size" value={layer.size ?? 0.4} min={0.1} max={0.9} step={0.01} onChange={(v) => onChange({ size: v })} />
          <Range label="Offset X" value={layer.offsetX ?? 0} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ offsetX: v })} />
          <Range label="Offset Y" value={layer.offsetY ?? 0} min={-0.5} max={0.5} step={0.01} onChange={(v) => onChange({ offsetY: v })} />
        </>
      )}
    </div>
  )
}
