/**
 * Persisted Circle of Fifths preferences (last selected key), shared across
 * visits via the `Store` wrapper in `src/lib/storage.ts`. Mirrors the shape of
 * `metronomeSettings.ts`: a factory (tests inject `memoryBackend()`), a
 * ready-made localStorage-backed store, and a pure normalizer that clamps any
 * loaded/typed value into range — kept pure so it is unit-tested without
 * rendering React.
 */

import { Store, type StorageBackend } from './storage.ts'
import { CIRCLE_SEGMENT_COUNT } from '../components/circleGeometry.ts'

export interface CircleOfFifthsSettings {
  /** Selected circle position, 0–11 (0 = C). */
  selectedIndex: number
  /** Which scale the instrument views (fretboard/keyboard) highlight: the key's major scale or its relative natural minor. */
  scaleView: 'major' | 'minor'
}

export const DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS: CircleOfFifthsSettings = {
  selectedIndex: 0,
  scaleView: 'major',
}

/** Clamp/round a selected index into the valid `[0, CIRCLE_SEGMENT_COUNT)` range. */
export function clampCircleIndex(index: number): number {
  if (Number.isNaN(index)) return DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS.selectedIndex
  const rounded = Math.round(index)
  return Math.min(CIRCLE_SEGMENT_COUNT - 1, Math.max(0, rounded))
}

/**
 * Coerce arbitrary (persisted, hand-edited, or typed) data into a valid
 * `CircleOfFifthsSettings`, falling back to the default for anything missing
 * or out of range.
 */
export function normalizeCircleOfFifthsSettings(value: unknown): CircleOfFifthsSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof CircleOfFifthsSettings, unknown>
  >
  const selectedIndex =
    typeof v.selectedIndex === 'number'
      ? clampCircleIndex(v.selectedIndex)
      : DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS.selectedIndex
  const scaleView: CircleOfFifthsSettings['scaleView'] =
    v.scaleView === 'major' || v.scaleView === 'minor'
      ? v.scaleView
      : DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS.scaleView
  return { selectedIndex, scaleView }
}

/** Build a circle-of-fifths-settings store (tests pass `memoryBackend()`). */
export function createCircleOfFifthsSettingsStore(
  backend?: StorageBackend,
): Store<CircleOfFifthsSettings> {
  return new Store<CircleOfFifthsSettings>(
    {
      key: 'settings:circle-of-fifths',
      version: 1,
      defaultValue: DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS,
    },
    backend,
  )
}

/** The app-wide circle-of-fifths settings store (localStorage-backed). */
export const circleOfFifthsSettingsStore = createCircleOfFifthsSettingsStore()
