/**
 * Pure logic for the Play-Along "chord tones on fretboard" panel: turn a chord
 * (root pitch class + quality) plus a `Tuning` and fret range into fretboard
 * markers for every chord-tone position, each tagged with a bass-friendly
 * chord-degree label (`R`, `b3`, `3`, `5`, `b7`, `7`, …), a key-spelled note
 * name, and whether it is the root (so the UI can emphasise roots).
 *
 * Framework-free and node-safe (no `window`/`document`, no Web Audio), so it is
 * fully unit-testable. Works for any fretted instrument — string count and
 * pitches come entirely from the `Tuning` (never hardcoded to 4 strings/EADG).
 */

import type { ChordQuality } from './theory/chords.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { mod12, pcToName, type PitchClass } from './theory/notes.ts'
import { prefersFlats } from './theory/spell.ts'

/**
 * Chord-degree shorthand for each semitone within an octave. Uses the label a
 * player building a bass line expects (chromatic degrees with accidentals),
 * rather than the interval short names (`m3`, `P5`, …) used elsewhere.
 */
const SIMPLE_DEGREE_LABELS: Record<number, string> = {
  0: 'R',
  1: 'b2',
  2: '2',
  3: 'b3',
  4: '3',
  5: '4',
  6: 'b5',
  7: '5',
  8: '#5',
  9: '6',
  10: 'b7',
  11: '7',
}

/**
 * Bass-friendly chord-degree label for an interval measured in semitones above
 * the root. Compound intervals (an octave or more) bump the degree number by 7
 * per octave, so `add9`'s 14 semitones reads `9`; the octave of the root stays
 * `R`. Throws on a negative interval.
 */
export function chordDegreeLabel(semitones: number): string {
  if (semitones < 0) throw new Error(`chordDegreeLabel: negative interval ${semitones}`)
  const octaves = Math.floor(semitones / 12)
  const simple = semitones - octaves * 12
  const base = SIMPLE_DEGREE_LABELS[simple]!
  if (octaves === 0 || base === 'R') return base
  const match = /^([#b]*)(\d+)$/.exec(base)
  if (!match) return base
  const [, accidental, numberStr] = match
  return `${accidental}${Number(numberStr) + 7 * octaves}`
}

/** A chord-tone position on the neck, ready to drive a `Fretboard` marker. */
export interface ChordToneMarker {
  /** String index, 0 = lowest-pitched string. */
  string: number
  /** Fret number, 0 = open string. */
  fret: number
  /** `'root'` for the chord root (visually emphasised), else `'default'`. */
  variant: 'root' | 'default'
  /** Chord-degree label, e.g. `'R'`, `'b3'`, `'5'`, `'b7'`. */
  degree: string
  /** Key-spelled note name, e.g. `'Eb'` in a flat key, `'F#'` in a sharp key. */
  note: string
  /** Whether this position sounds the chord root. */
  isRoot: boolean
}

/** The chord a marker set is built for: a root pitch class + a quality. */
export interface ChordToneInput {
  root: PitchClass
  quality: ChordQuality
}

/**
 * Every chord-tone position for `chord` across all strings of `tuning`, within
 * the inclusive fret range (clipped to the board — no negative frets, and the
 * range is normalised if passed reversed). Note names are spelled with the
 * selected key's accidental preference so a flat key shows `Bb`, not `A#`.
 * Root positions get the `'root'` variant; every other tone gets `'default'`.
 */
export function buildChordToneMarkers(
  chord: ChordToneInput,
  tuning: Tuning,
  fromFret: number,
  toFret: number,
  keyRootPc: PitchClass,
): ChordToneMarker[] {
  const prefer = prefersFlats(mod12(keyRootPc)) ? 'flat' : 'sharp'
  const rootPc = mod12(chord.root)

  // Map each chord-tone pitch class to its lowest defining interval, root
  // first, so degree labels stay stable regardless of the octave a position
  // lands in.
  const intervalByPc = new Map<PitchClass, number>()
  for (const semitones of chord.quality.intervals) {
    const pc = mod12(chord.root + semitones)
    if (!intervalByPc.has(pc)) intervalByPc.set(pc, semitones)
  }

  const lo = Math.max(0, Math.min(fromFret, toFret))
  const hi = Math.max(0, Math.max(fromFret, toFret))
  const markers: ChordToneMarker[] = []
  for (let s = 0; s < tuning.strings.length; s++) {
    for (let fret = lo; fret <= hi; fret++) {
      const pc = mod12(fretMidi(tuning, s, fret))
      const semitones = intervalByPc.get(pc)
      if (semitones === undefined) continue
      const isRoot = pc === rootPc
      markers.push({
        string: s,
        fret,
        variant: isRoot ? 'root' : 'default',
        degree: chordDegreeLabel(semitones),
        note: pcToName(pc, prefer),
        isRoot,
      })
    }
  }
  return markers
}
