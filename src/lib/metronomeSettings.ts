/**
 * Persisted metronome preferences (tempo, meter, subdivision), shared across
 * visits via the `Store` wrapper in `src/lib/storage.ts`. Mirrors the shape of
 * `settings.ts`: a factory (tests inject `memoryBackend()`), a ready-made
 * localStorage-backed store, and a pure `normalizeMetronomeSettings` that
 * clamps any loaded/typed value into the ranges the UI supports — kept pure so
 * it is unit-tested without rendering React.
 */

import { Store, type StorageBackend } from './storage.ts'

export interface MetronomeSettings {
  /** Tempo in beats per minute. */
  bpm: number
  /** Beats per bar (time-signature numerator). */
  beatsPerBar: number
  /** Grid steps per beat: 1 quarters, 2 eighths, 3 triplets, 4 sixteenths. */
  subdivisionsPerBeat: number
}

/** Tempo range offered by the UI slider/steppers. */
export const MIN_TEMPO = 30
export const MAX_TEMPO = 240

/** Selectable beats-per-bar values. */
export const BEATS_PER_BAR_OPTIONS = [2, 3, 4, 5, 6, 7] as const
/** Selectable subdivisions with labels for the UI. */
export const SUBDIVISION_OPTIONS = [1, 2, 3, 4] as const

export const DEFAULT_METRONOME_SETTINGS: MetronomeSettings = {
  bpm: 120,
  beatsPerBar: 4,
  subdivisionsPerBeat: 1,
}

/** Clamp a tempo into `[MIN_TEMPO, MAX_TEMPO]`; NaN falls back to the default. */
export function clampTempo(bpm: number): number {
  if (Number.isNaN(bpm)) return DEFAULT_METRONOME_SETTINGS.bpm
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(bpm)))
}

/**
 * Coerce arbitrary (persisted, hand-edited, or typed) data into a valid
 * `MetronomeSettings`, falling back per-field to the defaults for anything
 * missing or out of range.
 */
export function normalizeMetronomeSettings(value: unknown): MetronomeSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof MetronomeSettings, unknown>
  >
  const bpm = typeof v.bpm === 'number' ? clampTempo(v.bpm) : DEFAULT_METRONOME_SETTINGS.bpm
  const beatsPerBar = pickOption(
    v.beatsPerBar,
    BEATS_PER_BAR_OPTIONS,
    DEFAULT_METRONOME_SETTINGS.beatsPerBar,
  )
  const subdivisionsPerBeat = pickOption(
    v.subdivisionsPerBeat,
    SUBDIVISION_OPTIONS,
    DEFAULT_METRONOME_SETTINGS.subdivisionsPerBeat,
  )
  return { bpm, beatsPerBar, subdivisionsPerBeat }
}

function pickOption(value: unknown, options: readonly number[], fallback: number): number {
  return typeof value === 'number' && options.includes(value) ? value : fallback
}

/** Build a metronome-settings store (tests pass `memoryBackend()`). */
export function createMetronomeSettingsStore(backend?: StorageBackend): Store<MetronomeSettings> {
  return new Store<MetronomeSettings>(
    {
      key: 'settings:metronome',
      version: 1,
      defaultValue: DEFAULT_METRONOME_SETTINGS,
    },
    backend,
  )
}

/** The app-wide metronome settings store (localStorage-backed). */
export const metronomeSettingsStore = createMetronomeSettingsStore()
