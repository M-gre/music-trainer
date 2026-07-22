/**
 * React binding for the global default instrument (`src/lib/settings.ts`).
 * Reads the persisted tuning id once, resolves it to a `Tuning` (falling
 * back to the default for an invalid/stale id), and persists any change.
 *
 * Kept as a thin wrapper: all fallback/persistence logic lives in
 * `settings.ts` and is unit-tested there without rendering React.
 */

import { useCallback, useState } from 'react'
import { instrumentSettingsStore, resolveTuningId, type InstrumentSettings } from '../lib/settings.ts'
import type { Tuning } from '../lib/theory/instruments.ts'

export interface UseInstrumentSettings {
  /** The resolved current default tuning. */
  tuning: Tuning
  /** Change the default tuning and persist it. */
  setTuningId: (tuningId: string) => void
}

export function useInstrumentSettings(): UseInstrumentSettings {
  const [settings, setSettings] = useState<InstrumentSettings>(() => instrumentSettingsStore.get())

  const setTuningId = useCallback((tuningId: string) => {
    const next: InstrumentSettings = { tuningId }
    instrumentSettingsStore.set(next)
    setSettings(next)
  }, [])

  return { tuning: resolveTuningId(settings.tuningId), setTuningId }
}
