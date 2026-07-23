/**
 * Pure logic for the Diatonic Chords tool: for a key (root + scale), build the
 * seven diatonic triads (I–vii°) with roman numerals, correctly spelled chord
 * tones, and playable keyboard voicings — plus a scheduler for quick-play
 * chord progressions. Framework-free and fully unit-tested; the React page
 * (`src/pages/DiatonicChords.tsx`) is a thin shell over this plus the shared
 * audio engine, `chordExplorer.ts`'s voicing/marker helpers, and the
 * `Fretboard`/`Keyboard` components.
 */

import { diatonicTriads, type ChordQuality } from './theory/chords.ts'
import { mod12, type Midi, type PitchClass } from './theory/notes.ts'
import { getScale } from './theory/scales.ts'
import { prefersFlats, spellScale } from './theory/spell.ts'
import { voicingMidis, VOICING_BASE_MIDI } from './chordExplorer.ts'
import { Store, type StorageBackend } from './storage.ts'

// --- Key / scale selection ----------------------------------------------------

/** The three 7-note scales this tool offers as a "key" for diatonic harmony. */
export type DiatonicScaleId = 'major' | 'minor' | 'harmonic-minor'

export interface DiatonicScaleOption {
  id: DiatonicScaleId
  name: string
}

export const DIATONIC_SCALE_OPTIONS: DiatonicScaleOption[] = [
  { id: 'major', name: 'Major' },
  { id: 'minor', name: 'Natural Minor' },
  { id: 'harmonic-minor', name: 'Harmonic Minor' },
]

export function isDiatonicScaleId(value: unknown): value is DiatonicScaleId {
  return typeof value === 'string' && DIATONIC_SCALE_OPTIONS.some((s) => s.id === value)
}

/**
 * Whether the key reads with flats. Major keys use their own signature;
 * minor keys (natural or harmonic) borrow the signature of their relative
 * major (a minor third up), matching conventional key-signature practice
 * (e.g. E minor reads with sharps, like its relative G major).
 */
export function keyPrefersFlats(rootPc: PitchClass, scaleId: DiatonicScaleId): boolean {
  const majorRootPc = scaleId === 'major' ? rootPc : mod12(rootPc + 3)
  return prefersFlats(majorRootPc)
}

// --- Diatonic chord cards -----------------------------------------------------

export interface DiatonicChordCard {
  /** Scale degree, 1-based (1 = tonic). */
  degree: number
  /** Roman numeral, cased by quality, e.g. "ii", "V", "vii°". */
  numeral: string
  root: PitchClass
  quality: ChordQuality
  /** Chord symbol using key-appropriate spelling, e.g. "Dm", "G", "F#dim". */
  symbol: string
  /** The chord's tones (root, 3rd, 5th), spelled with the key's letters. */
  toneNames: string[]
}

/**
 * The seven diatonic triads of a key, each with a roman numeral, a
 * key-spelled chord symbol, and spelled chord tones. Chord tones are read
 * directly off the key's consecutive-letter scale spelling (each triad tone
 * is one of the seven scale degrees), so e.g. in F major the ii chord (Dm)
 * spells as D, F, A rather than D, F, A# or similar enharmonic slips.
 */
export function buildDiatonicChordCards(rootPc: PitchClass, scaleId: DiatonicScaleId): DiatonicChordCard[] {
  const scale = getScale(scaleId)
  const triads = diatonicTriads(rootPc, scale)
  const scaleLetters = spellScale(rootPc, scale.intervals)

  return triads.map((triad, i) => {
    const toneNames = [scaleLetters[i]!, scaleLetters[(i + 2) % 7]!, scaleLetters[(i + 4) % 7]!]
    return {
      degree: triad.degree,
      numeral: triad.numeral,
      root: triad.root,
      quality: triad.quality,
      symbol: toneNames[0] + triad.quality.symbol,
      toneNames,
    }
  })
}

// --- Voicing selection ---------------------------------------------------------

/** A sensible standalone (root position) voicing for a single card, anchored around `baseMidi` (default C4). */
export function cardVoicing(card: DiatonicChordCard, baseMidi: Midi = VOICING_BASE_MIDI): Midi[] {
  return voicingMidis(card.root, card.quality, 0, baseMidi)
}

function averageMidi(midis: readonly Midi[]): number {
  return midis.reduce((sum, m) => sum + m, 0) / midis.length
}

/**
 * The inversion of `root`/`quality` (anchored around `baseMidi`) whose
 * average pitch lands closest to `previous`'s average pitch — smooth voice
 * leading between consecutive progression chords. Falls back to root
 * position when there is no previous chord.
 */
export function nearestVoicing(
  root: PitchClass,
  quality: ChordQuality,
  previous: readonly Midi[] | null,
  baseMidi: Midi = VOICING_BASE_MIDI,
): Midi[] {
  const n = quality.intervals.length
  if (!previous || previous.length === 0) return voicingMidis(root, quality, 0, baseMidi)

  const targetCenter = averageMidi(previous)
  let best = voicingMidis(root, quality, 0, baseMidi)
  let bestDist = Math.abs(averageMidi(best) - targetCenter)
  for (let inv = 1; inv < n; inv++) {
    const candidate = voicingMidis(root, quality, inv, baseMidi)
    const dist = Math.abs(averageMidi(candidate) - targetCenter)
    if (dist < bestDist) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}

// --- Progressions ---------------------------------------------------------------

export interface DiatonicProgression {
  id: string
  /** Display label, e.g. "I – IV – V – I". */
  label: string
  /** Scale degrees (1–7) to play in order. */
  degrees: number[]
}

/** Common diatonic progressions, expressed as scale degrees so they follow whatever key/scale is selected. */
export const COMMON_PROGRESSIONS: DiatonicProgression[] = [
  { id: 'I-IV-V-I', label: 'I – IV – V – I', degrees: [1, 4, 5, 1] },
  { id: 'I-V-vi-IV', label: 'I – V – vi – IV', degrees: [1, 5, 6, 4] },
  { id: 'ii-V-I', label: 'ii – V – I', degrees: [2, 5, 1] },
]

/** Tempo/duration for progression playback: ~80 BPM, each chord held for 2 beats (a half note). */
export const PROGRESSION_BPM = 80
export const PROGRESSION_BEATS_PER_CHORD = 2

/** Seconds one chord is held for, given a tempo and beats-per-chord. */
export function chordDurationSeconds(
  bpm: number = PROGRESSION_BPM,
  beatsPerChord: number = PROGRESSION_BEATS_PER_CHORD,
): number {
  return (60 / bpm) * beatsPerChord
}

export interface ProgressionStep {
  /** Index into the `cards` array this step plays (`degree - 1`). */
  cardIndex: number
  midis: Midi[]
  /** Absolute schedule time (seconds), relative to whatever clock `startTime` is on. */
  when: number
  /** Seconds this chord is held for. */
  duration: number
}

export interface ScheduleProgressionOptions {
  bpm?: number
  beatsPerChord?: number
  /** Absolute start time (e.g. `engine.currentTime`). Default 0. */
  startTime?: number
  baseMidi?: Midi
}

/**
 * Build a timed sequence of chord-voicing steps for a progression: each
 * scale degree resolved against `cards`, voice-led from the previous chord
 * via `nearestVoicing`, spaced `chordDurationSeconds` apart starting at
 * `startTime`. Pure and clock-agnostic — the caller feeds each step's `midis`
 * and `when` to the audio engine.
 */
export function scheduleProgression(
  cards: readonly DiatonicChordCard[],
  degrees: readonly number[],
  opts: ScheduleProgressionOptions = {},
): ProgressionStep[] {
  const bpm = opts.bpm ?? PROGRESSION_BPM
  const beatsPerChord = opts.beatsPerChord ?? PROGRESSION_BEATS_PER_CHORD
  const duration = chordDurationSeconds(bpm, beatsPerChord)
  const startTime = opts.startTime ?? 0
  const baseMidi = opts.baseMidi ?? VOICING_BASE_MIDI

  let previous: Midi[] | null = null
  return degrees.map((degree, i) => {
    const card = cards[degree - 1]
    if (!card) throw new Error(`Invalid scale degree: ${degree}`)
    const midis = nearestVoicing(card.root, card.quality, previous, baseMidi)
    previous = midis
    return { cardIndex: degree - 1, midis, when: startTime + i * duration, duration }
  })
}

// --- Persisted settings ---------------------------------------------------------

export interface DiatonicChordsSettings {
  /** Key root pitch class, 0–11 (0 = C). */
  rootPc: PitchClass
  scaleId: DiatonicScaleId
}

export const DEFAULT_DIATONIC_CHORDS_SETTINGS: DiatonicChordsSettings = {
  rootPc: 0,
  scaleId: 'major',
}

/** Coerce arbitrary (persisted, hand-edited, or typed) data into valid settings. */
export function normalizeDiatonicChordsSettings(value: unknown): DiatonicChordsSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof DiatonicChordsSettings, unknown>
  >
  const rootPc =
    typeof v.rootPc === 'number' && Number.isFinite(v.rootPc)
      ? mod12(Math.round(v.rootPc))
      : DEFAULT_DIATONIC_CHORDS_SETTINGS.rootPc
  const scaleId = isDiatonicScaleId(v.scaleId) ? v.scaleId : DEFAULT_DIATONIC_CHORDS_SETTINGS.scaleId
  return { rootPc, scaleId }
}

/** Build a diatonic-chords-settings store (tests pass `memoryBackend()`). */
export function createDiatonicChordsSettingsStore(backend?: StorageBackend): Store<DiatonicChordsSettings> {
  return new Store<DiatonicChordsSettings>(
    {
      key: 'settings:diatonic-chords',
      version: 1,
      defaultValue: DEFAULT_DIATONIC_CHORDS_SETTINGS,
    },
    backend,
  )
}

/** The app-wide diatonic-chords settings store (localStorage-backed). */
export const diatonicChordsSettingsStore = createDiatonicChordsSettingsStore()
