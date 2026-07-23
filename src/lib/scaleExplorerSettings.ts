/**
 * Persisted Scales & Modes explorer preferences (root, scale, label display,
 * and full-neck toggle), shared across visits via the `Store` wrapper in
 * `src/lib/storage.ts`. Mirrors the shape of `metronomeSettings.ts`: a factory
 * (tests inject `memoryBackend()`), a ready-made localStorage-backed store, and
 * a pure normalizer that coerces any loaded/typed value into range — kept pure
 * so it is unit-tested without rendering React.
 */

import { Store, type StorageBackend } from './storage.ts'
import { mod12 } from './theory/notes.ts'
import { SCALES } from './theory/scales.ts'
import type { ScaleDisplayMode } from './scaleExplorer.ts'

export interface ScaleExplorerSettings {
  /** Root pitch class, 0–11 (0 = C). */
  rootPc: number
  /** Scale id from `SCALES`. */
  scaleId: string
  /** Marker label display mode. */
  display: ScaleDisplayMode
  /** Whether the fretboard shows the full neck (0–24) rather than 0–12. */
  fullRange: boolean
}

export const DEFAULT_SCALE_EXPLORER_SETTINGS: ScaleExplorerSettings = {
  rootPc: 0,
  scaleId: 'major',
  display: 'degrees',
  fullRange: false,
}

/**
 * Coerce arbitrary (persisted, hand-edited, or typed) data into a valid
 * `ScaleExplorerSettings`, falling back per-field to the defaults for anything
 * missing or out of range.
 */
export function normalizeScaleExplorerSettings(value: unknown): ScaleExplorerSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof ScaleExplorerSettings, unknown>
  >
  const rootPc =
    typeof v.rootPc === 'number' && Number.isFinite(v.rootPc)
      ? mod12(Math.round(v.rootPc))
      : DEFAULT_SCALE_EXPLORER_SETTINGS.rootPc
  const scaleId =
    typeof v.scaleId === 'string' && SCALES.some((s) => s.id === v.scaleId)
      ? v.scaleId
      : DEFAULT_SCALE_EXPLORER_SETTINGS.scaleId
  const display: ScaleDisplayMode =
    v.display === 'names' || v.display === 'degrees'
      ? v.display
      : DEFAULT_SCALE_EXPLORER_SETTINGS.display
  const fullRange =
    typeof v.fullRange === 'boolean' ? v.fullRange : DEFAULT_SCALE_EXPLORER_SETTINGS.fullRange
  return { rootPc, scaleId, display, fullRange }
}

/** Build a scale-explorer-settings store (tests pass `memoryBackend()`). */
export function createScaleExplorerSettingsStore(
  backend?: StorageBackend,
): Store<ScaleExplorerSettings> {
  return new Store<ScaleExplorerSettings>(
    {
      key: 'settings:scale-explorer',
      version: 1,
      defaultValue: DEFAULT_SCALE_EXPLORER_SETTINGS,
    },
    backend,
  )
}

/** The app-wide scale-explorer settings store (localStorage-backed). */
export const scaleExplorerSettingsStore = createScaleExplorerSettingsStore()
