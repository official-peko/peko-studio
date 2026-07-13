import { useEffect, useState } from 'react'
import { peko } from '@peko/client'
import type { PekoPlatform } from '@peko/client'

// A safe default for a plain browser (no native host).
const DEFAULT_PLATFORM: PekoPlatform = {
  os: 'unknown',
  mobile: false,
  desktop: true,
  frameless: true,
  nativeControls: false,
  windowControls: true,
  titlebarInset: 0,
  nativeMenu: false,
}

/// The platform the app is running on, updated once the bridge is ready.
// Falls back to DEFAULT_PLATFORM synchronously so first render has valid values before peko.ready resolves.
export function usePlatform(): PekoPlatform {
  const [platform, setPlatform] = useState<PekoPlatform>(peko.platform ?? DEFAULT_PLATFORM)

  useEffect(() => {
    let cancelled = false
    peko.ready
      .then(() => {
        if (!cancelled && peko.platform) setPlatform(peko.platform)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return platform
}
