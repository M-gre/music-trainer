/**
 * Global default fretted-instrument selection (instrument + tuning), shared
 * by every fretboard tool via `InstrumentPicker` / `useInstrumentSettings`.
 * Persisted through the `Store` wrapper in `src/lib/storage.ts` so it
 * survives reloads and new tools get a sensible default with zero wiring.
 */

import { Store, type StorageBackend } from './storage.ts'
import { getTuning, type Tuning } from './theory/instruments.ts'

/** Default tuning for a brand-new visitor (and the fallback for stale ids). */
export const DEFAULT_TUNING_ID = 'bass-4'

export interface InstrumentSettings {
  tuningId: string
}

const defaultInstrumentSettings: InstrumentSettings = { tuningId: DEFAULT_TUNING_ID }

/**
 * Build a settings store. Tests inject `memoryBackend()`; the app uses the
 * default (localStorage-backed) store below.
 */
export function createInstrumentSettingsStore(backend?: StorageBackend): Store<InstrumentSettings> {
  return new Store<InstrumentSettings>(
    {
      key: 'settings:instrument',
      version: 1,
      defaultValue: defaultInstrumentSettings,
    },
    backend,
  )
}

/** The app-wide instrument settings store (localStorage-backed). */
export const instrumentSettingsStore = createInstrumentSettingsStore()

/**
 * Resolve a persisted tuning id to a `Tuning`, falling back to the default
 * tuning when the id is invalid or stale (e.g. a tuning removed or renamed
 * in a later release, or hand-edited storage).
 */
export function resolveTuningId(tuningId: string): Tuning {
  try {
    return getTuning(tuningId)
  } catch {
    return getTuning(DEFAULT_TUNING_ID)
  }
}
