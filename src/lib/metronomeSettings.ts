/**
 * Persisted metronome preferences (tempo, meter, subdivision, click voice, and
 * the per-beat accent pattern), shared across visits via the `Store` wrapper in
 * `src/lib/storage.ts`. Mirrors the shape of `settings.ts`: a factory (tests
 * inject `memoryBackend()`), a ready-made localStorage-backed store, and a pure
 * `normalizeMetronomeSettings` that coerces any loaded/typed value into the
 * ranges the UI supports — kept pure so it is unit-tested without rendering
 * React.
 *
 * v2 added `soundId` (selectable click voice) and `accents` (per-beat accent
 * level, length === `beatsPerBar`); v1 data is migrated by filling those in.
 */

import {
  ACCENT_LEVELS,
  DEFAULT_CLICK_VOICE_ID,
  isAccentLevel,
  isClickVoiceId,
  type AccentLevel,
  type ClickVoiceId,
} from './audio/clickVoices.ts'
import { Store, type StorageBackend } from './storage.ts'

export interface MetronomeSettings {
  /** Tempo in beats per minute. */
  bpm: number
  /** Beats per bar (time-signature numerator). */
  beatsPerBar: number
  /** Grid steps per beat: 1 quarters, 2 eighths, 3 triplets, 4 sixteenths. */
  subdivisionsPerBeat: number
  /** Selected click voice. */
  soundId: ClickVoiceId
  /** Per-beat accent level; length always equals `beatsPerBar`. */
  accents: AccentLevel[]
}

/** Tempo range offered by the UI slider/steppers. */
export const MIN_TEMPO = 30
export const MAX_TEMPO = 240

/** Selectable beats-per-bar values. */
export const BEATS_PER_BAR_OPTIONS = [2, 3, 4, 5, 6, 7] as const
/** Selectable subdivisions with labels for the UI. */
export const SUBDIVISION_OPTIONS = [1, 2, 3, 4] as const

/** Accent applied to beat 1 by default (a strong downbeat). */
export const DEFAULT_DOWNBEAT_ACCENT: AccentLevel = 'high'
/** Accent applied to every other beat by default, and to newly-added beats. */
export const DEFAULT_BEAT_ACCENT: AccentLevel = 'mid'

/**
 * The default accent pattern for a bar: a strong downbeat, everything else at
 * the mid level.
 */
export function defaultAccents(beatsPerBar: number): AccentLevel[] {
  const beats = Math.max(1, Math.floor(beatsPerBar))
  return Array.from({ length: beats }, (_, i) =>
    i === 0 ? DEFAULT_DOWNBEAT_ACCENT : DEFAULT_BEAT_ACCENT,
  )
}

/**
 * Resize an accent array to `beatsPerBar`, preserving existing beats and filling
 * any new ones with the default beat accent. Extra beats are dropped. Non-array
 * or invalid entries fall back to a fresh default pattern / the default accent.
 */
export function resizeAccents(current: unknown, beatsPerBar: number): AccentLevel[] {
  const beats = Math.max(1, Math.floor(beatsPerBar))
  if (!Array.isArray(current)) return defaultAccents(beats)
  return Array.from({ length: beats }, (_, i) => {
    const value: unknown = current[i]
    // Preserve valid existing beats; fill new (or invalid) slots with the default.
    return isAccentLevel(value) ? value : DEFAULT_BEAT_ACCENT
  })
}

export const DEFAULT_METRONOME_SETTINGS: MetronomeSettings = {
  bpm: 120,
  beatsPerBar: 4,
  subdivisionsPerBeat: 1,
  soundId: DEFAULT_CLICK_VOICE_ID,
  accents: defaultAccents(4),
}

/** Clamp a tempo into `[MIN_TEMPO, MAX_TEMPO]`; NaN falls back to the default. */
export function clampTempo(bpm: number): number {
  if (Number.isNaN(bpm)) return DEFAULT_METRONOME_SETTINGS.bpm
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, Math.round(bpm)))
}

/**
 * Coerce arbitrary (persisted, hand-edited, or typed) data into a valid
 * `MetronomeSettings`, falling back per-field to the defaults for anything
 * missing or out of range. The accent array is always resized to match the
 * resolved `beatsPerBar`.
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
  const soundId = isClickVoiceId(v.soundId) ? v.soundId : DEFAULT_METRONOME_SETTINGS.soundId
  const accents = Array.isArray(v.accents)
    ? resizeAccents(v.accents, beatsPerBar)
    : defaultAccents(beatsPerBar)
  return { bpm, beatsPerBar, subdivisionsPerBeat, soundId, accents }
}

function pickOption(value: unknown, options: readonly number[], fallback: number): number {
  return typeof value === 'number' && options.includes(value) ? value : fallback
}

/**
 * Migrate persisted data from an older schema version. v1 lacked `soundId` and
 * `accents`; `normalizeMetronomeSettings` fills them from the defaults (default
 * voice + a default accent pattern sized to the stored meter).
 */
export function migrateMetronomeSettings(oldData: unknown): MetronomeSettings {
  return normalizeMetronomeSettings(oldData)
}

/** Build a metronome-settings store (tests pass `memoryBackend()`). */
export function createMetronomeSettingsStore(backend?: StorageBackend): Store<MetronomeSettings> {
  return new Store<MetronomeSettings>(
    {
      key: 'settings:metronome',
      version: 2,
      defaultValue: DEFAULT_METRONOME_SETTINGS,
      migrate: migrateMetronomeSettings,
    },
    backend,
  )
}

/** The app-wide metronome settings store (localStorage-backed). */
export const metronomeSettingsStore = createMetronomeSettingsStore()

// Re-export the accent-level enum so callers can import it alongside settings.
export { ACCENT_LEVELS, type AccentLevel, type ClickVoiceId }
