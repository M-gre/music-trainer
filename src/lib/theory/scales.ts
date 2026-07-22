import { mod12, type PitchClass } from './notes.ts'

/** A scale is defined by its interval pattern in semitones from the root. */
export interface Scale {
  id: string
  name: string
  intervals: number[]
}

export const SCALES: Scale[] = [
  { id: 'major', name: 'Major (Ionian)', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'dorian', name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', name: 'Phrygian', intervals: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', name: 'Lydian', intervals: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'minor', name: 'Natural Minor (Aeolian)', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'locrian', name: 'Locrian', intervals: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonic-minor', name: 'Harmonic Minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic-minor', name: 'Melodic Minor', intervals: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'major-pentatonic', name: 'Major Pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', name: 'Minor Pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'chromatic', name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
]

/** The seven modes of the major scale, in degree order. */
export const MODE_IDS = ['major', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'minor', 'locrian'] as const

export function getScale(id: string): Scale {
  const scale = SCALES.find((s) => s.id === id)
  if (!scale) throw new Error(`Unknown scale: "${id}"`)
  return scale
}

/** Pitch classes of a scale built on the given root. */
export function scalePcs(root: PitchClass, scale: Scale): PitchClass[] {
  return scale.intervals.map((i) => mod12(root + i))
}

/**
 * Circle of fifths as pitch classes starting from C going clockwise
 * (C, G, D, ... F). Index = number of sharps for major keys 0–6.
 */
export const CIRCLE_OF_FIFTHS: PitchClass[] = Array.from({ length: 12 }, (_, i) => mod12(i * 7))

/**
 * Number of sharps (positive) or flats (negative) in the major key
 * of the given root, choosing the spelling with fewer accidentals.
 * E.g. G -> 1, F -> -1, F#/Gb -> ±6 (returns -6, preferring Gb).
 */
export function majorKeySignature(root: PitchClass): number {
  const position = CIRCLE_OF_FIFTHS.indexOf(mod12(root))
  // Positions 0..6 are sharp keys (C..F#), 7..11 flat keys (Db..F).
  return position <= 5 ? position : position - 12
}
