import { useEffect, useState } from 'react'
import { imageMime, readImageDataUrl } from '../ide/workspace'

/// Renders an image file (png/jpg/gif/webp/...) read from the host as a base64
/// data URL, centered on a checkerboard so transparency is visible, with its
/// natural pixel dimensions.
export function ImageViewer({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setFailed(false)
    setDimensions(null)
    const mime = imageMime(path)
    if (!mime) {
      setFailed(true)
      return
    }
    void (async () => {
      const url = await readImageDataUrl(path, mime)
      if (cancelled) return
      if (url) setSrc(url)
      else setFailed(true)
    })()
    return () => {
      cancelled = true
    }
  }, [path])

  const name = path.split('/').pop() ?? path

  return (
    <div className="image-viewer">
      <div className="image-stage">
        {failed && <div className="image-message">Could not load image</div>}
        {src && (
          <img
            className="image-canvas"
            src={src}
            alt={name}
            onLoad={(event) =>
              setDimensions({
                w: event.currentTarget.naturalWidth,
                h: event.currentTarget.naturalHeight,
              })
            }
          />
        )}
      </div>
      <div className="image-info">
        <span>{name}</span>
        {dimensions && (
          <span className="image-dims">
            {dimensions.w} &#xD7; {dimensions.h}
          </span>
        )}
      </div>
    </div>
  )
}
