/**
 * Pure logic for the Scales & Modes explorer (page in
 * `src/pages/ScalesExplorer.tsx`). Kept framework-free and window-free so it is
 * fully unit-tested in the `node` environment:
 *
 *  - scale-degree labels (1, b3, #4, b7 …) derived from interval semitones,
 *    with correct diatonic spelling for 7-note scales (Lydian #4 vs Locrian b5)
 *    and a chromatic fallback for pentatonic/blues/chromatic scales,
 *  - the step pattern (W-W-H …) and raw semitone steps of a scale,
 *  - marker construction for a `Tuning` + scale (fretboard) and a keyboard
 *    range, matching the `FretboardMarker` / `KeyboardMarker` vocabularies,
 *  - the ascending/descending note sequence played back by the audio engine.
 *
 * Types from the SVG components are imported type-only, so nothing here pulls a
 * `.tsx` module (or the DOM) into the library at runtime.
 */

import type { FretboardMarker, MarkerVariant } from '../components/Fretboard.tsx'
import type { KeyboardMarker } from '../components/Keyboard.tsx'
import { mod12, pcToName, type Midi, type PitchClass } from './theory/notes.ts'
import { prefersFlats, spellScale } from './theory/spell.ts'
import type { Scale } from './theory/scales.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'

/** How marker labels are rendered: note names (C, Eb) or scale degrees (1, b3). */
export type ScaleDisplayMode = 'names' | 'degrees'

/** Accidental spelling passed through to note-name labels. */
export type AccidentalPreference = 'sharp' | 'flat'

/** Semitone offsets of the major scale per degree index (0 = degree 1). */
export const MAJOR_REFERENCE = [0, 2, 4, 5, 7, 9, 11] as const

/** Fixed scale-degree names per semitone, used for non-diatonic scales. */
export const CHROMATIC_DEGREE_LABELS = [
  '1',
  'b2',
  '2',
  'b3',
  '3',
  '4',
  'b5',
  '5',
  'b6',
  '6',
  'b7',
  '7',
] as const

/** Semitone step -> W/H style label. 3 semitones is an augmented second (W½). */
const STEP_LABELS: Record<number, string> = { 1: 'H', 2: 'W', 3: 'W½' }

/**
 * Degree label for a bare semitone interval using the fixed chromatic map
 * (1, b2, 2, b3 …). Context-free — always spells the tritone as b5.
 */
export function degreeLabelFromSemitones(semitones: number): string {
  return CHROMATIC_DEGREE_LABELS[mod12(semitones)]!
}

/**
 * Degree label for a tone at a known diatonic position: the degree number is
 * `degreeIndex + 1` and the accidental is the signed distance from the
 * major-scale tone at that degree. This distinguishes Lydian's #4 (raised 4th)
 * from Locrian's b5 (lowered 5th), which the chromatic map cannot.
 */
export function diatonicDegreeLabel(semitones: number, degreeIndex: number): string {
  const idx = ((degreeIndex % 7) + 7) % 7
  const ref = MAJOR_REFERENCE[idx]!
  const number = idx + 1
  let diff = mod12(semitones) - ref
  if (diff > 6) diff -= 12
  if (diff < -6) diff += 12
  const accidental = diff > 0 ? '#'.repeat(diff) : diff < 0 ? 'b'.repeat(-diff) : ''
  return `${accidental}${number}`
}

/**
 * Degree label for every tone of a scale. 7-note scales use diatonic
 * (position-aware) spelling; all other scales use the chromatic map so
 * pentatonics and the blues scale keep their conventional degrees (1 b3 4 5 b7).
 */
export function scaleDegreeLabels(intervals: number[]): string[] {
  if (intervals.length === 7) return intervals.map((s, i) => diatonicDegreeLabel(s, i))
  return intervals.map((s) => degreeLabelFromSemitones(s))
}

/** Map from each scale tone's semitone offset (0–11) to its degree label. */
export function scaleDegreeLabelMap(intervals: number[]): Map<number, string> {
  const labels = scaleDegreeLabels(intervals)
  const map = new Map<number, string>()
  intervals.forEach((s, i) => map.set(mod12(s), labels[i]!))
  return map
}

/** Semitone gap between each consecutive scale tone, last step wrapping to the octave. */
export function scaleStepsSemitones(intervals: number[]): number[] {
  const steps: number[] = []
  for (let i = 0; i < intervals.length; i++) {
    const current = intervals[i]!
    const next = intervals[i + 1] ?? 12
    steps.push(next - current)
  }
  return steps
}

/** Step pattern as W/H tokens (e.g. major = W W H W W W H). */
export function scaleStepPattern(intervals: number[]): string[] {
  return scaleStepsSemitones(intervals).map((s) => STEP_LABELS[s] ?? `${s}`)
}

/**
 * Marker variant for a scale tone by its interval from the root: the root, the
 * third and fifth (chord skeleton) get emphasis; everything else is plain.
 */
export function markerVariantForInterval(interval: number): MarkerVariant {
  const pc = mod12(interval)
  if (pc === 0) return 'root'
  if (pc === 3 || pc === 4 || pc === 7) return 'accent'
  return 'default'
}

/**
 * Spelled note names of the scale for the info line. 7-note scales use
 * consecutive-letter spelling (F major = F G A Bb C D E); others fall back to
 * simple names in the root's conventional accidental direction.
 */
export function scaleNoteNames(rootPc: PitchClass, scale: Scale): string[] {
  if (scale.intervals.length === 7) return spellScale(rootPc, scale.intervals)
  const prefer: AccidentalPreference = prefersFlats(rootPc) ? 'flat' : 'sharp'
  return scale.intervals.map((i) => pcToName(mod12(rootPc + i), prefer))
}

export interface MarkerBuildOptions {
  display: ScaleDisplayMode
  prefer: AccidentalPreference
}

/**
 * Every position on the neck (within the fret range) whose pitch class belongs
 * to the scale, as `FretboardMarker`s labelled per the display mode.
 */
export function buildFretboardMarkers(
  tuning: Tuning,
  fromFret: number,
  toFret: number,
  rootPc: PitchClass,
  intervals: number[],
  opts: MarkerBuildOptions,
): FretboardMarker[] {
  const labelMap = scaleDegreeLabelMap(intervals)
  const pcSet = new Set(intervals.map((i) => mod12(rootPc + i)))
  const markers: FretboardMarker[] = []
  for (let string = 0; string < tuning.strings.length; string++) {
    for (let fret = fromFret; fret <= toFret; fret++) {
      const pc = mod12(fretMidi(tuning, string, fret))
      if (!pcSet.has(pc)) continue
      const interval = mod12(pc - rootPc)
      markers.push({
        string,
        fret,
        variant: markerVariantForInterval(interval),
        label: opts.display === 'degrees' ? (labelMap.get(interval) ?? '') : pcToName(pc, opts.prefer),
      })
    }
  }
  return markers
}

export interface KeyboardMarkerBuildOptions extends MarkerBuildOptions {
  /** How many octaves of the scale to highlight above the root. Default 2. */
  octaves?: number
}

/**
 * `KeyboardMarker`s highlighting the scale across `octaves` octaves starting at
 * `rootMidi`, plus the top-octave root, so the shape reads across the keybed.
 */
export function buildKeyboardMarkers(
  rootMidi: Midi,
  intervals: number[],
  opts: KeyboardMarkerBuildOptions,
): KeyboardMarker[] {
  const octaves = opts.octaves ?? 2
  const labelMap = scaleDegreeLabelMap(intervals)
  const markers: KeyboardMarker[] = []
  const labelFor = (midi: Midi, interval: number): string =>
    opts.display === 'degrees' ? (labelMap.get(mod12(interval)) ?? '') : pcToName(mod12(midi), opts.prefer)
  for (let octave = 0; octave < octaves; octave++) {
    for (const interval of intervals) {
      const midi = rootMidi + octave * 12 + interval
      markers.push({ midi, variant: markerVariantForInterval(interval), label: labelFor(midi, interval) })
    }
  }
  const topRoot = rootMidi + octaves * 12
  markers.push({ midi: topRoot, variant: 'root', label: labelFor(topRoot, 0) })
  return markers
}

/** Anchor midi for the lowest playable/displayed root (C3), one clear octave for all instruments. */
export const PLAYBACK_ROOT_BASE = 48

/** Sensible playback/display root midi for a pitch class (C3 octave). */
export function playbackRootMidi(rootPc: PitchClass): Midi {
  return PLAYBACK_ROOT_BASE + mod12(rootPc)
}

export type ScaleDirection = 'up' | 'down'

/**
 * The note sequence to play: one octave of the scale from `rootMidi` including
 * the octave at the top, reversed for a descending run.
 */
export function buildScaleSequence(rootMidi: Midi, intervals: number[], direction: ScaleDirection): Midi[] {
  const ascending = [...intervals.map((i) => rootMidi + i), rootMidi + 12]
  return direction === 'down' ? [...ascending].reverse() : ascending
}
