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
 * `'arpeggio'` mode. v5 replaced the `notesPerBeat` subdivision with the richer
 * rhythm-variation layer (`rhythmId`, `accentEveryN`) — a v4 record's old
 * `notesPerBeat` is used to pick the matching even rhythm on migration. v6
 * added the piano-exercise fields (`pianoMode` and the `piano*` choices) for
 * the keyboard drills. Older data is migrated by filling any missing field in
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
import {
  clampPianoOctave,
  DEFAULT_FIVE_FINGER_PATTERN_ID,
  DEFAULT_PIANO_EXERCISE_KIND,
  type FiveFingerPatternId,
  type FiveFingerQuality,
  type Hand,
  isFiveFingerPatternId,
  isFiveFingerQuality,
  isHand,
  isPianoExerciseKind,
  isScaleOctaves,
  type PianoExerciseKind,
  type ScaleOctaves,
} from './pianoExercises.ts'
import {
  type AccentEveryN,
  DEFAULT_RHYTHM_ID,
  isAccentEveryN,
  isRhythmId,
  rhythmForNotesPerBeat,
  type RhythmId,
} from './rhythmVariations.ts'
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
  /** Rhythm pattern applied to the exercise steps (straight, triplets, gallop, …). */
  rhythmId: RhythmId
  /** Accent every Nth note (2/3/4) for displacement drills; 0 = accent layer off. */
  accentEveryN: AccentEveryN
  /** Advance the position +1 fret each loop, within `[advanceMin, advanceMax]`. */
  autoAdvance: boolean
  /** Lowest fret of the auto-advance span. */
  advanceMin: number
  /** Highest fret of the auto-advance span. */
  advanceMax: number
  /** Playback direction: forward, reverse, or forward-then-reverse. */
  direction: Direction
  /** Whether the tool is in piano (keyboard) mode instead of the fretted modes. */
  pianoMode: boolean
  /** Which piano exercise family is showing (five-finger patterns or scales). */
  pianoKind: PianoExerciseKind
  /** Root pitch class 0–11 for the piano exercise. */
  pianoRootPc: number
  /** Root octave (scientific pitch, C4 = middle C) for the piano exercise. */
  pianoOctave: number
  /** Major/minor quality (used by the five-finger patterns). */
  pianoQuality: FiveFingerQuality
  /** Chosen five-finger pattern variation. */
  pianoPatternId: FiveFingerPatternId
  /** Which hand the piano exercise is fingered/played for. */
  pianoHand: Hand
  /** Octave count for the piano scale drill (1 or 2). */
  pianoOctaves: ScaleOctaves
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
  rhythmId: DEFAULT_RHYTHM_ID,
  accentEveryN: 0,
  autoAdvance: false,
  advanceMin: 1,
  advanceMax: 12,
  direction: DEFAULT_DIRECTION,
  pianoMode: false,
  pianoKind: DEFAULT_PIANO_EXERCISE_KIND,
  pianoRootPc: 0,
  pianoOctave: 4,
  pianoQuality: 'major',
  pianoPatternId: DEFAULT_FIVE_FINGER_PATTERN_ID,
  pianoHand: 'right',
  pianoOctaves: 1,
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
  // `notesPerBeat` is a removed v4 field still read for migration (see below).
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof DexteritySettings, unknown>
  > & { notesPerBeat?: unknown }
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
  // Rhythm supersedes the old `notesPerBeat` subdivision; when a v4 (or older)
  // record has no `rhythmId`, derive it from that legacy field so a saved
  // "eighths"/"triplets"/"sixteenths" feel survives the migration.
  const rhythmId: RhythmId = isRhythmId(v.rhythmId) ? v.rhythmId : rhythmForNotesPerBeat(v.notesPerBeat)
  const accentEveryN: AccentEveryN = isAccentEveryN(v.accentEveryN)
    ? v.accentEveryN
    : DEFAULT_DEXTERITY_SETTINGS.accentEveryN
  const autoAdvance = typeof v.autoAdvance === 'boolean' ? v.autoAdvance : DEFAULT_DEXTERITY_SETTINGS.autoAdvance

  const rawMin = typeof v.advanceMin === 'number' ? clampFret(v.advanceMin) : DEFAULT_DEXTERITY_SETTINGS.advanceMin
  const rawMax = typeof v.advanceMax === 'number' ? clampFret(v.advanceMax) : DEFAULT_DEXTERITY_SETTINGS.advanceMax
  const advanceMin = Math.min(rawMin, rawMax)
  const advanceMax = Math.max(rawMin, rawMax)

  const direction: Direction =
    typeof v.direction === 'string' && (DIRECTIONS as readonly string[]).includes(v.direction)
      ? (v.direction as Direction)
      : DEFAULT_DEXTERITY_SETTINGS.direction

  const pianoMode = typeof v.pianoMode === 'boolean' ? v.pianoMode : DEFAULT_DEXTERITY_SETTINGS.pianoMode
  const pianoKind: PianoExerciseKind = isPianoExerciseKind(v.pianoKind)
    ? v.pianoKind
    : DEFAULT_DEXTERITY_SETTINGS.pianoKind
  const pianoRootPc =
    typeof v.pianoRootPc === 'number' && Number.isFinite(v.pianoRootPc)
      ? mod12(Math.round(v.pianoRootPc))
      : DEFAULT_DEXTERITY_SETTINGS.pianoRootPc
  const pianoOctave =
    typeof v.pianoOctave === 'number' ? clampPianoOctave(v.pianoOctave) : DEFAULT_DEXTERITY_SETTINGS.pianoOctave
  const pianoQuality: FiveFingerQuality = isFiveFingerQuality(v.pianoQuality)
    ? v.pianoQuality
    : DEFAULT_DEXTERITY_SETTINGS.pianoQuality
  const pianoPatternId: FiveFingerPatternId = isFiveFingerPatternId(v.pianoPatternId)
    ? v.pianoPatternId
    : DEFAULT_DEXTERITY_SETTINGS.pianoPatternId
  const pianoHand: Hand = isHand(v.pianoHand) ? v.pianoHand : DEFAULT_DEXTERITY_SETTINGS.pianoHand
  const pianoOctaves: ScaleOctaves = isScaleOctaves(v.pianoOctaves)
    ? v.pianoOctaves
    : DEFAULT_DEXTERITY_SETTINGS.pianoOctaves

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
    rhythmId,
    accentEveryN,
    autoAdvance,
    advanceMin,
    advanceMax,
    direction,
    pianoMode,
    pianoKind,
    pianoRootPc,
    pianoOctave,
    pianoQuality,
    pianoPatternId,
    pianoHand,
    pianoOctaves,
  }
}

/**
 * Migrate persisted data from an older schema version. v1 lacked `direction`;
 * v2 lacked the scale-sequence fields (`mode`, `scaleRootPc`, `scaleId`,
 * `sequenceId`); v3 lacked the arpeggio fields (`arpRootPc`, `arpQualityId`,
 * `arpInversion`); v4 used `notesPerBeat` instead of the rhythm layer
 * (`rhythmId`, `accentEveryN`); v5 lacked the piano fields (`pianoMode` and the
 * `piano*` choices). `normalizeDexteritySettings` fills every missing field in
 * with its default (deriving `rhythmId` from a legacy `notesPerBeat`), so a
 * single pass upgrades data from any prior version.
 */
export function migrateDexteritySettings(oldData: unknown): DexteritySettings {
  return normalizeDexteritySettings(oldData)
}

/** Build a dexterity-settings store (tests pass `memoryBackend()`). */
export function createDexteritySettingsStore(backend?: StorageBackend): Store<DexteritySettings> {
  return new Store<DexteritySettings>(
    {
      key: 'settings:dexterity',
      version: 6,
      defaultValue: DEFAULT_DEXTERITY_SETTINGS,
      migrate: migrateDexteritySettings,
    },
    backend,
  )
}

/** The app-wide dexterity settings store (localStorage-backed). */
export const dexteritySettingsStore = createDexteritySettingsStore()
