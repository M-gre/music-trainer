/**
 * Persisted Dexterity-tool preferences (chosen pattern, starting fret, tempo,
 * notes-per-beat, the auto-advance range, and playback direction). Mirrors
 * `metronomeSettings.ts`: a versioned `Store`, a factory (tests inject
 * `memoryBackend()`), and a pure `normalizeDexteritySettings` that coerces any
 * loaded/typed value into the ranges the UI supports — kept pure so it is
 * unit-tested without React.
 *
 * v2 added `direction` (forward / reverse / forward-then-reverse playback,
 * independent of a pattern's own traversal); v1 data is migrated by filling
 * it in with the default (`normalizeDexteritySettings` handles this).
 */

import {
  BUILTIN_PATTERNS,
  clampInt,
  DEFAULT_DIRECTION,
  DEFAULT_PATTERN_ID,
  DIRECTIONS,
  type Direction,
} from './exercises.ts'
import { isPermutationId } from './permutations.ts'
import { Store, type StorageBackend } from './storage.ts'

/** Tempo range offered by the slider/steppers (beats per minute). */
export const MIN_BPM = 30
export const MAX_BPM = 240

/** Fret range the position selector + auto-advance span operate within. */
export const MIN_FRET = 0
export const MAX_FRET = 22

/** Selectable notes-per-beat (metronome subdivisions driving step advancement). */
export const NOTES_PER_BEAT_OPTIONS = [1, 2, 3, 4] as const

export interface DexteritySettings {
  /** Chosen pattern id. */
  patternId: string
  /** Starting fret (the position's base/index fret). */
  position: number
  /** Tempo in beats per minute. */
  bpm: number
  /** Steps advanced per beat (== metronome subdivisions per beat). */
  notesPerBeat: number
  /** Advance the position +1 fret each loop, within `[advanceMin, advanceMax]`. */
  autoAdvance: boolean
  /** Lowest fret of the auto-advance span. */
  advanceMin: number
  /** Highest fret of the auto-advance span. */
  advanceMax: number
  /** Playback direction: forward, reverse, or forward-then-reverse. */
  direction: Direction
}

export const DEFAULT_DEXTERITY_SETTINGS: DexteritySettings = {
  patternId: DEFAULT_PATTERN_ID,
  position: 5,
  bpm: 80,
  notesPerBeat: 1,
  autoAdvance: false,
  advanceMin: 1,
  advanceMax: 12,
  direction: DEFAULT_DIRECTION,
}

/** Clamp a tempo into `[MIN_BPM, MAX_BPM]`; NaN falls back to the default. */
export function clampBpm(bpm: number): number {
  if (Number.isNaN(bpm)) return DEFAULT_DEXTERITY_SETTINGS.bpm
  return Math.min(MAX_BPM, Math.max(MIN_BPM, Math.round(bpm)))
}

/** Clamp a fret into `[MIN_FRET, MAX_FRET]`; NaN falls back to the default. */
export function clampFret(fret: number): number {
  if (Number.isNaN(fret)) return DEFAULT_DEXTERITY_SETTINGS.position
  return clampInt(fret, MIN_FRET, MAX_FRET)
}

/**
 * Coerce arbitrary (persisted, hand-edited, or typed) data into a valid
 * `DexteritySettings`, falling back per-field to the defaults. The auto-advance
 * span is normalized so `advanceMin <= advanceMax`.
 */
export function normalizeDexteritySettings(value: unknown): DexteritySettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof DexteritySettings, unknown>
  >
  const patternId =
    typeof v.patternId === 'string' &&
    (BUILTIN_PATTERNS.some((p) => p.id === v.patternId) || isPermutationId(v.patternId))
      ? v.patternId
      : DEFAULT_DEXTERITY_SETTINGS.patternId
  const position = typeof v.position === 'number' ? clampFret(v.position) : DEFAULT_DEXTERITY_SETTINGS.position
  const bpm = typeof v.bpm === 'number' ? clampBpm(v.bpm) : DEFAULT_DEXTERITY_SETTINGS.bpm
  const notesPerBeat =
    typeof v.notesPerBeat === 'number' && NOTES_PER_BEAT_OPTIONS.includes(v.notesPerBeat as 1 | 2 | 3 | 4)
      ? v.notesPerBeat
      : DEFAULT_DEXTERITY_SETTINGS.notesPerBeat
  const autoAdvance = typeof v.autoAdvance === 'boolean' ? v.autoAdvance : DEFAULT_DEXTERITY_SETTINGS.autoAdvance

  const rawMin = typeof v.advanceMin === 'number' ? clampFret(v.advanceMin) : DEFAULT_DEXTERITY_SETTINGS.advanceMin
  const rawMax = typeof v.advanceMax === 'number' ? clampFret(v.advanceMax) : DEFAULT_DEXTERITY_SETTINGS.advanceMax
  const advanceMin = Math.min(rawMin, rawMax)
  const advanceMax = Math.max(rawMin, rawMax)

  const direction: Direction =
    typeof v.direction === 'string' && (DIRECTIONS as readonly string[]).includes(v.direction)
      ? (v.direction as Direction)
      : DEFAULT_DEXTERITY_SETTINGS.direction

  return { patternId, position, bpm, notesPerBeat, autoAdvance, advanceMin, advanceMax, direction }
}

/**
 * Migrate persisted data from an older schema version. v1 lacked `direction`;
 * `normalizeDexteritySettings` fills it in with the default (`forward`).
 */
export function migrateDexteritySettings(oldData: unknown): DexteritySettings {
  return normalizeDexteritySettings(oldData)
}

/** Build a dexterity-settings store (tests pass `memoryBackend()`). */
export function createDexteritySettingsStore(backend?: StorageBackend): Store<DexteritySettings> {
  return new Store<DexteritySettings>(
    {
      key: 'settings:dexterity',
      version: 2,
      defaultValue: DEFAULT_DEXTERITY_SETTINGS,
      migrate: migrateDexteritySettings,
    },
    backend,
  )
}

/** The app-wide dexterity settings store (localStorage-backed). */
export const dexteritySettingsStore = createDexteritySettingsStore()
