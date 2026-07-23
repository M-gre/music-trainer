/**
 * Arpeggio drills (M5) — run a triad or 7th-chord arpeggio across the strings
 * inside a fret *position*, in any inversion, on any tuning. Pure and
 * framework-free like the rest of `src/lib/`; the Dexterity page feeds the
 * output straight into the same rendering / metronome pipeline the built-in
 * `exercises.ts` patterns and the `scaleSequences.ts` drills use.
 *
 * Like `scaleSequences.ts`, this works in real pitch space rather than copying
 * a fixed fret box: every candidate fret's midi is derived from the tuning's
 * actual open-string pitch and tested against the chord's pitch-class set, so a
 * major-third string boundary (guitar's G→B pair) lands its tones on the
 * correct frets automatically. The result is emitted as the SAME
 * `ExerciseStep[]` shape `expandPattern` / `expandScaleSequence` produce, so the
 * page's numbering, marker building, direction toggle (`applyDirection`), and
 * scheduler sync all work unchanged.
 *
 * Position model — for a tuning, chord (root pc + intervals), and an `anchor`
 * fret, the "position" is the fret window `[anchor, anchor + span - 1]` (same
 * window on every string, `span` defaulting to `ARPEGGIO_SPAN`, slightly wider
 * than a scale box so the sparse chord tones and inversion stretches fit). The
 * position's ordered chord tones are every in-window chord tone, walked
 * string-by-string low→high and, within each string, fret ascending
 * ("ascending across strings") — the way an arpeggio is played in position.
 *
 * Inversion rule (the exact behavior shipped) — the collected window tones are
 * in string-major (≈ pitch-ascending) order. An inversion selects a *bass
 * degree*, the chord tone that must sound lowest: root position → the root
 * (interval index 0), 1st inversion → the 3rd (index 1), 2nd inversion → the
 * 5th (index 2), 3rd inversion → the 7th (index 3, 7th chords only). The drill
 * begins on the FIRST (lowest) window tone whose pitch class equals that bass
 * degree and then continues through every remaining window tone in order; tones
 * below that starting tone are dropped. If the window contains no tone of the
 * bass degree, or the requested inversion has no chord tone (e.g. a 3rd
 * inversion of a triad), the result is empty.
 *
 * Finger rule — `finger = clamp(fret - anchor + 1, 1, 4)`, identical to the
 * scale-sequence drills: the index finger (1) anchors the window's first fret,
 * each higher fret steps to the next finger, and a stretch past the pinky's
 * home fret is played with the pinky (4).
 */

import { type ExerciseStep, type Finger } from './exercises.ts'
import { type PositionTone } from './scaleSequences.ts'
import { CHORD_QUALITIES, type ChordQuality, getChordQuality } from './theory/chords.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { mod12, type PitchClass } from './theory/notes.ts'

/**
 * Default position-window width, in frets. One fret wider than the scale-box
 * span so an arpeggio's sparse chord tones (and the extra reach an inversion's
 * bass note can demand) still fill a playable shape.
 */
export const ARPEGGIO_SPAN = 5

/** Clamp any offset into a valid fretting finger, 1..4. */
function clampFinger(value: number): Finger {
  return Math.min(4, Math.max(1, value)) as Finger
}

/**
 * The ordered chord tones of a position: every chord tone whose fret lies in
 * the window `[anchor, anchor + span - 1]`, walked string-by-string low→high
 * and fret-ascending within each string. Frets below the nut (< 0) are skipped,
 * so the window clips cleanly near the top of the neck. Each tone's pitch comes
 * from the tuning's real open-string pitch, never a copied fret offset — so a
 * major-third string boundary (guitar G→B) lands its tones on the correct
 * frets automatically.
 */
export function positionChordTones(
  tuning: Tuning,
  root: PitchClass,
  intervals: readonly number[],
  anchor: number,
  span: number = ARPEGGIO_SPAN,
): PositionTone[] {
  const pcs = new Set(intervals.map((i) => mod12(root + i)))
  const tones: PositionTone[] = []
  const top = anchor + Math.max(1, Math.floor(span)) - 1
  for (let string = 0; string < tuning.strings.length; string += 1) {
    for (let fret = anchor; fret <= top; fret += 1) {
      if (fret < 0) continue
      const midi = fretMidi(tuning, string, fret)
      if (pcs.has(mod12(midi))) {
        tones.push({ string, fret, finger: clampFinger(fret - anchor + 1), midi })
      }
    }
  }
  return tones
}

/** A chord inversion: which chord tone sounds in the bass. */
export type Inversion = 'root' | 'first' | 'second' | 'third'

export const DEFAULT_INVERSION: Inversion = 'root'

/** A selectable inversion for the picker, plus the chord-tone index it puts in the bass. */
export interface InversionOption {
  id: Inversion
  name: string
  /** Index into the chord's interval list of the bass chord tone (0 = root). */
  degreeIndex: number
}

export const INVERSIONS: readonly InversionOption[] = [
  { id: 'root', name: 'Root position', degreeIndex: 0 },
  { id: 'first', name: '1st inversion', degreeIndex: 1 },
  { id: 'second', name: '2nd inversion', degreeIndex: 2 },
  { id: 'third', name: '3rd inversion', degreeIndex: 3 },
]

/** The chord-tone (interval) index an inversion places in the bass. */
export function inversionDegreeIndex(inversion: Inversion): number {
  return INVERSIONS.find((i) => i.id === inversion)?.degreeIndex ?? 0
}

/** Whether `id` is a known inversion id. */
export function isInversion(id: string): id is Inversion {
  return INVERSIONS.some((i) => i.id === id)
}

/** The inversions available for a chord with `count` tones (hides 3rd inversion for triads). */
export function inversionsForIntervals(count: number): InversionOption[] {
  return INVERSIONS.filter((i) => i.degreeIndex < count)
}

// --- Chord-quality registry for the picker ----------------------------------

/** Triad qualities offered by the arpeggio picker, in display order. */
export const ARPEGGIO_TRIAD_IDS = ['maj', 'min', 'dim', 'aug'] as const

/** 7th-chord qualities offered by the arpeggio picker, in display order. */
export const ARPEGGIO_SEVENTH_IDS = ['maj7', 'min7', 'dom7', 'min7b5', 'dim7'] as const

/** All chord-quality ids the arpeggio drills support. */
export const ARPEGGIO_QUALITY_IDS: readonly string[] = [...ARPEGGIO_TRIAD_IDS, ...ARPEGGIO_SEVENTH_IDS]

export const DEFAULT_ARPEGGIO_QUALITY_ID: string = ARPEGGIO_TRIAD_IDS[0]

/** Whether `id` is a chord quality the arpeggio drills support. */
export function isArpeggioQualityId(id: string): boolean {
  return ARPEGGIO_QUALITY_IDS.includes(id)
}

/** A picker group of chord qualities (triads vs 7th chords). */
export interface ArpeggioQualityGroup {
  label: string
  qualities: ChordQuality[]
}

/** Chord qualities grouped for the picker (triads first, then 7th chords). */
export function arpeggioQualityGroups(): ArpeggioQualityGroup[] {
  return [
    { label: 'Triads', qualities: ARPEGGIO_TRIAD_IDS.map((id) => getChordQuality(id)) },
    { label: '7th chords', qualities: ARPEGGIO_SEVENTH_IDS.map((id) => getChordQuality(id)) },
  ]
}

/** Look up a supported arpeggio chord quality by id, falling back to the default. */
export function getArpeggioQuality(id: string): ChordQuality {
  const found = CHORD_QUALITIES.find((q) => q.id === id && isArpeggioQualityId(q.id))
  return found ?? getChordQuality(DEFAULT_ARPEGGIO_QUALITY_ID)
}

// --- Drill expansion --------------------------------------------------------

/** Everything needed to expand an arpeggio drill in a position. */
export interface ArpeggioDrillConfig {
  /** The instrument tuning (drives string count + pitches). */
  tuning: Tuning
  /** Chord root pitch class, 0–11 (0 = C). */
  root: PitchClass
  /** The chord quality's intervals (semitones above the root, root first). */
  intervals: readonly number[]
  /** Which chord tone sounds in the bass (root position / 1st / 2nd / 3rd). */
  inversion: Inversion
  /** Position anchor: the window's first (index-finger) fret. */
  anchor: number
  /** Window width in frets; defaults to `ARPEGGIO_SPAN`. */
  span?: number
}

/**
 * Expand an arpeggio drill into a concrete step sequence — the same
 * `ExerciseStep[]` shape `expandPattern` produces, so it drops straight into the
 * Dexterity page's rendering + scheduler pipeline (and can be run through
 * `applyDirection` for the forward/reverse/forward-reverse toggle).
 *
 * The inversion picks the bass degree; the drill starts on the lowest window
 * tone of that pitch class and runs every remaining window tone in order (see
 * the module doc comment). Returns `[]` when the inversion has no chord tone
 * (e.g. a 3rd inversion of a triad) or the window holds no tone of the bass
 * degree.
 */
export function expandArpeggio(config: ArpeggioDrillConfig): ExerciseStep[] {
  const { tuning, root, intervals, inversion, anchor, span } = config
  const bassInterval = intervals[inversionDegreeIndex(inversion)]
  if (bassInterval === undefined) return []
  const bassPc = mod12(root + bassInterval)

  const tones = positionChordTones(tuning, root, intervals, anchor, span)
  const start = tones.findIndex((t) => mod12(t.midi) === bassPc)
  if (start < 0) return []

  return tones.slice(start).map((tone) => ({
    string: tone.string,
    fret: tone.fret,
    finger: tone.finger,
    duration: 1,
    midi: tone.midi,
  }))
}
