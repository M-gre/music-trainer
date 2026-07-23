/**
 * Persisted Dexterity-tool preferences (chosen pattern, starting fret, tempo,
 * notes-per-beat, the auto-advance range, and playback direction). Mirrors
 * `metronomeSettings.ts`: a versioned `Store`, a factory (tests inject
 * `memoryBackend()`), and a pure `normalizeDexteritySettings` that coerces any
 * loaded/typed value into the ranges the UI supports — kept pure so it is
 * unit-tested without React.
 *
 * v2 added `direction` (forward / reverse / forward-then-reverse playback,
 * independent of a pattern's own traversal); v3 added the scale-sequence drill
 * fields (`mode`, `scaleRootPc`, `scaleId`, `sequenceId`); v4 added the
 * arpeggio-drill fields (`arpRootPc`, `arpQualityId`, `arpInversion`) and the
 * `'arpeggio'` mode. Older data is migrated by filling any missing field in
 * with its default (`normalizeDexteritySettings` handles every version).
 */

import {
  DEFAULT_ARPEGGIO_QUALITY_ID,
  DEFAULT_INVERSION,
  type Inversion,
  isArpeggioQualityId,
  isInversion,
} from './arpeggioDrills.ts'
import {
  BUILTIN_PATTERNS,
  clampInt,
  DEFAULT_DIRECTION,
  DEFAULT_PATTERN_ID,
  DIRECTIONS,
  type Direction,
} from './exercises.ts'
import { isPermutationId } from './permutations.ts'
import { DEFAULT_SEQUENCE_ID, isSequencePatternId, type SequencePatternId } from './scaleSequences.ts'
import { Store, type StorageBackend } from './storage.ts'
import { mod12 } from './theory/notes.ts'
import { SCALES } from './theory/scales.ts'

/** Tempo range offered by the slider/steppers (beats per minute). */
export const MIN_BPM = 30
export const MAX_BPM = 240

/** Fret range the position selector + auto-advance span operate within. */
export const MIN_FRET = 0
export const MAX_FRET = 22

/** Selectable notes-per-beat (metronome subdivisions driving step advancement). */
export const NOTES_PER_BEAT_OPTIONS = [1, 2, 3, 4] as const

/** Which family of drill the tool is showing: built-in patterns, scale sequences, or arpeggios. */
export type DexterityMode = 'pattern' | 'scale' | 'arpeggio'

export const DEXTERITY_MODES: readonly DexterityMode[] = ['pattern', 'scale', 'arpeggio']

export interface DexteritySettings {
  /** Whether the tool is running a built-in pattern, a scale-sequence, or an arpeggio drill. */
  mode: DexterityMode
  /** Chosen pattern id (used in `mode: 'pattern'`). */
  patternId: string
  /** Scale root pitch class 0–11 (used in `mode: 'scale'`). */
  scaleRootPc: number
  /** Scale id from `SCALES` (used in `mode: 'scale'`). */
  scaleId: string
  /** Sequence pattern id (used in `mode: 'scale'`). */
  sequenceId: SequencePatternId
  /** Arpeggio chord root pitch class 0–11 (used in `mode: 'arpeggio'`). */
  arpRootPc: number
  /** Arpeggio chord-quality id (used in `mode: 'arpeggio'`). */
  arpQualityId: string
  /** Arpeggio inversion (used in `mode: 'arpeggio'`). */
  arpInversion: Inversion
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
  mode: 'pattern',
  patternId: DEFAULT_PATTERN_ID,
  scaleRootPc: 0,
  scaleId: 'major',
  sequenceId: DEFAULT_SEQUENCE_ID,
  arpRootPc: 0,
  arpQualityId: DEFAULT_ARPEGGIO_QUALITY_ID,
  arpInversion: DEFAULT_INVERSION,
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
  const mode: DexterityMode =
    v.mode === 'pattern' || v.mode === 'scale' || v.mode === 'arpeggio'
      ? v.mode
      : DEFAULT_DEXTERITY_SETTINGS.mode
  const patternId =
    typeof v.patternId === 'string' &&
    (BUILTIN_PATTERNS.some((p) => p.id === v.patternId) || isPermutationId(v.patternId))
      ? v.patternId
      : DEFAULT_DEXTERITY_SETTINGS.patternId
  const scaleRootPc =
    typeof v.scaleRootPc === 'number' && Number.isFinite(v.scaleRootPc)
      ? mod12(Math.round(v.scaleRootPc))
      : DEFAULT_DEXTERITY_SETTINGS.scaleRootPc
  const scaleId =
    typeof v.scaleId === 'string' && SCALES.some((s) => s.id === v.scaleId)
      ? v.scaleId
      : DEFAULT_DEXTERITY_SETTINGS.scaleId
  const sequenceId: SequencePatternId =
    typeof v.sequenceId === 'string' && isSequencePatternId(v.sequenceId)
      ? v.sequenceId
      : DEFAULT_DEXTERITY_SETTINGS.sequenceId
  const arpRootPc =
    typeof v.arpRootPc === 'number' && Number.isFinite(v.arpRootPc)
      ? mod12(Math.round(v.arpRootPc))
      : DEFAULT_DEXTERITY_SETTINGS.arpRootPc
  const arpQualityId =
    typeof v.arpQualityId === 'string' && isArpeggioQualityId(v.arpQualityId)
      ? v.arpQualityId
      : DEFAULT_DEXTERITY_SETTINGS.arpQualityId
  const arpInversion: Inversion =
    typeof v.arpInversion === 'string' && isInversion(v.arpInversion)
      ? v.arpInversion
      : DEFAULT_DEXTERITY_SETTINGS.arpInversion
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

  return {
    mode,
    patternId,
    scaleRootPc,
    scaleId,
    sequenceId,
    arpRootPc,
    arpQualityId,
    arpInversion,
    position,
    bpm,
    notesPerBeat,
    autoAdvance,
    advanceMin,
    advanceMax,
    direction,
  }
}

/**
 * Migrate persisted data from an older schema version. v1 lacked `direction`;
 * v2 lacked the scale-sequence fields (`mode`, `scaleRootPc`, `scaleId`,
 * `sequenceId`); v3 lacked the arpeggio fields (`arpRootPc`, `arpQualityId`,
 * `arpInversion`). `normalizeDexteritySettings` fills every missing field in
 * with its default, so a single pass upgrades data from any prior version.
 */
export function migrateDexteritySettings(oldData: unknown): DexteritySettings {
  return normalizeDexteritySettings(oldData)
}

/** Build a dexterity-settings store (tests pass `memoryBackend()`). */
export function createDexteritySettingsStore(backend?: StorageBackend): Store<DexteritySettings> {
  return new Store<DexteritySettings>(
    {
      key: 'settings:dexterity',
      version: 4,
      defaultValue: DEFAULT_DEXTERITY_SETTINGS,
      migrate: migrateDexteritySettings,
    },
    backend,
  )
}

/** The app-wide dexterity settings store (localStorage-backed). */
export const dexteritySettingsStore = createDexteritySettingsStore()
