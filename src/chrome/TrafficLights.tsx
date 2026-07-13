import { peko } from '@peko/client'

/// macOS-style window controls drawn by the web UI (the native traffic lights
/// are hidden). Left to right: close, minimize, zoom, matching the OS order.
/// The glyphs are SVG so they center exactly and their weight is precise; they
/// appear on hover of the group, like the real controls.
export function TrafficLights() {
  return (
    <div className="traffic-lights" data-peko-no-drag>
      <button className="tl tl-close" onClick={() => peko.window.close()} aria-label="Close">
        <svg className="tl-glyph tl-glyph-stroke" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.7 2.7 7.3 7.3M7.3 2.7 2.7 7.3" />
        </svg>
      </button>
      <button className="tl tl-min" onClick={() => peko.window.minimize()} aria-label="Minimize">
        <svg className="tl-glyph tl-glyph-stroke" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2.3 5H7.7" />
        </svg>
      </button>
      <button className="tl tl-max" onClick={() => peko.window.maximize()} aria-label="Zoom">
        <svg className="tl-glyph tl-glyph-zoom" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.6 1.6H7.7L1.6 7.7Z" />
          <path d="M8.4 8.4H2.3L8.4 2.3Z" />
        </svg>
      </button>
    </div>
  )
}
