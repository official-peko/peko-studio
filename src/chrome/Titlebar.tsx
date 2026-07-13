import { peko } from '@peko/client'
import { usePlatform } from './usePlatform'

/// The window titlebar over the editor column. It is the drag region and draws
/// its own minimize/maximize/close where the OS draws none (Windows/Linux).
/// On macOS the OS traffic lights live over the sidebar top instead.
export function Titlebar({ file }: { file: string }) {
  const platform = usePlatform()

  return (
    <header className="titlebar" data-peko-drag>
      <span className="titlebar-file">{file}</span>
      <div className="titlebar-spacer" />
      {platform.windowControls && (
        <div className="window-controls" data-peko-no-drag>
          <button
            className="wc wc-min"
            onClick={() => peko.window.minimize()}
            aria-label="Minimize"
          />
          <button
            className="wc wc-max"
            onClick={() => peko.window.maximize()}
            aria-label="Maximize"
          />
          <button className="wc wc-close" onClick={() => peko.window.close()} aria-label="Close" />
        </div>
      )}
    </header>
  )
}
