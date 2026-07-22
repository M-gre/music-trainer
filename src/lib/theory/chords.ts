import { mod12, type PitchClass } from './notes.ts'
import { getScale, scalePcs, type Scale } from './scales.ts'

export interface ChordQuality {
  id: string
  name: string
  /** Suffix used in chord symbols, e.g. "m7" in "Am7". */
  symbol: string
  intervals: number[]
}

export const CHORD_QUALITIES: ChordQuality[] = [
  { id: 'maj', name: 'Major', symbol: '', intervals: [0, 4, 7] },
  { id: 'min', name: 'Minor', symbol: 'm', intervals: [0, 3, 7] },
  { id: 'dim', name: 'Diminished', symbol: 'dim', intervals: [0, 3, 6] },
  { id: 'aug', name: 'Augmented', symbol: 'aug', intervals: [0, 4, 8] },
  { id: 'sus2', name: 'Suspended 2nd', symbol: 'sus2', intervals: [0, 2, 7] },
  { id: 'sus4', name: 'Suspended 4th', symbol: 'sus4', intervals: [0, 5, 7] },
  { id: 'maj7', name: 'Major 7th', symbol: 'maj7', intervals: [0, 4, 7, 11] },
  { id: 'min7', name: 'Minor 7th', symbol: 'm7', intervals: [0, 3, 7, 10] },
  { id: 'dom7', name: 'Dominant 7th', symbol: '7', intervals: [0, 4, 7, 10] },
  { id: 'min7b5', name: 'Half-Diminished', symbol: 'm7b5', intervals: [0, 3, 6, 10] },
  { id: 'dim7', name: 'Diminished 7th', symbol: 'dim7', intervals: [0, 3, 6, 9] },
  { id: 'maj6', name: 'Major 6th', symbol: '6', intervals: [0, 4, 7, 9] },
  { id: 'min6', name: 'Minor 6th', symbol: 'm6', intervals: [0, 3, 7, 9] },
  { id: 'add9', name: 'Added 9th', symbol: 'add9', intervals: [0, 4, 7, 14] },
]

export function getChordQuality(id: string): ChordQuality {
  const quality = CHORD_QUALITIES.find((q) => q.id === id)
  if (!quality) throw new Error(`Unknown chord quality: "${id}"`)
  return quality
}

/** Pitch classes of a chord built on the given root. */
export function chordPcs(root: PitchClass, quality: ChordQuality): PitchClass[] {
  return quality.intervals.map((i) => mod12(root + i))
}

export interface DiatonicChord {
  /** Scale degree, 1-based (1 = tonic). */
  degree: number
  root: PitchClass
  quality: ChordQuality
  /** Roman numeral, cased by quality, e.g. "ii", "V", "vii°". */
  numeral: string
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'] as const

/**
 * Diatonic triads of a 7-note scale: stack thirds within the scale and
 * classify each resulting triad.
 */
export function diatonicTriads(root: PitchClass, scale: Scale = getScale('major')): DiatonicChord[] {
  const pcs = scalePcs(root, scale)
  if (pcs.length !== 7) throw new Error(`Diatonic chords require a 7-note scale, got ${pcs.length}`)

  return pcs.map((chordRoot, i) => {
    const third = mod12(pcs[(i + 2) % 7]! - chordRoot)
    const fifth = mod12(pcs[(i + 4) % 7]! - chordRoot)
    const quality = classifyTriad(third, fifth)
    const base = ROMAN[i]!
    let numeral: string
    switch (quality.id) {
      case 'maj':
        numeral = base
        break
      case 'aug':
        numeral = base + '+'
        break
      case 'min':
        numeral = base.toLowerCase()
        break
      default:
        numeral = base.toLowerCase() + '°'
    }
    return { degree: i + 1, root: chordRoot, quality, numeral }
  })
}

function classifyTriad(third: number, fifth: number): ChordQuality {
  if (third === 4 && fifth === 7) return getChordQuality('maj')
  if (third === 3 && fifth === 7) return getChordQuality('min')
  if (third === 3 && fifth === 6) return getChordQuality('dim')
  if (third === 4 && fifth === 8) return getChordQuality('aug')
  throw new Error(`Unclassifiable triad: third=${third}, fifth=${fifth}`)
}

/**
 * Parse a progression like "1-5-6-4" or "2-5-1" into diatonic chords of the
 * given major key. Degrees are 1–7.
 */
export function progressionChords(root: PitchClass, degrees: number[]): DiatonicChord[] {
  const chords = diatonicTriads(root)
  return degrees.map((d) => {
    const chord = chords[d - 1]
    if (!chord) throw new Error(`Invalid scale degree: ${d}`)
    return chord
  })
}
