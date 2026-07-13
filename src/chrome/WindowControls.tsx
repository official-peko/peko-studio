import { peko } from '@peko/client'
import { usePlatform } from './usePlatform'

/// Minimize/maximize/close buttons for a frameless window where the OS draws
/// none. The shape follows the platform: Windows draws edge-to-edge square
/// buttons with a red close hover; Linux draws round symbolic buttons. macOS
/// uses the separate traffic lights. The glyphs are drawn in CSS so they stay
/// crisp at any scale.
export function WindowControls() {
  const platform = usePlatform()
  const os = platform.os === 'linux' ? 'linux' : 'windows'
  return (
    <div className={`window-controls os-${os}`} data-peko-no-drag>
      <button className="wc wc-min" onClick={() => peko.window.minimize()} aria-label="Minimize" />
      <button className="wc wc-max" onClick={() => peko.window.maximize()} aria-label="Maximize" />
      <button className="wc wc-close" onClick={() => peko.window.close()} aria-label="Close" />
    </div>
  )
}
