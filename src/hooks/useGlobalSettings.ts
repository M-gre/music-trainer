/**
 * React binding for the global cross-tool preferences
 * (`src/lib/globalSettings.ts`): left-handed fretboard flip, accidental
 * spelling preference, and master volume. Reads the persisted value once,
 * normalizes it, and persists any patch.
 *
 * Kept as a thin wrapper: all normalization/persistence logic lives in
 * `globalSettings.ts` and is unit-tested there without rendering React. Each
 * hook instance holds its own snapshot (settings only change on the dedicated
 * settings page, and other pages re-read the store on mount via the router).
 */

import { useCallback, useState } from 'react'
import {
  globalSettingsStore,
  normalizeGlobalSettings,
  type GlobalSettings,
} from '../lib/globalSettings.ts'

export interface UseGlobalSettings {
  /** The current normalized global settings. */
  settings: GlobalSettings
  /** Patch one or more fields and persist the result. */
  update: (patch: Partial<GlobalSettings>) => void
}

export function useGlobalSettings(): UseGlobalSettings {
  const [settings, setSettings] = useState<GlobalSettings>(() =>
    normalizeGlobalSettings(globalSettingsStore.get()),
  )

  const update = useCallback((patch: Partial<GlobalSettings>) => {
    setSettings((prev) => {
      const next = normalizeGlobalSettings({ ...prev, ...patch })
      globalSettingsStore.set(next)
      return next
    })
  }, [])

  return { settings, update }
}
