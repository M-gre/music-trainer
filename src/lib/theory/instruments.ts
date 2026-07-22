import { nameToMidi, type Midi } from './notes.ts'

/** A fretted string instrument tuning, low string first. */
export interface Tuning {
  id: string
  name: string
  /** Open-string midi pitches, lowest string first. */
  strings: Midi[]
}

export const BASS_TUNINGS: Tuning[] = [
  { id: 'bass-4', name: '4-String Bass (EADG)', strings: ['E1', 'A1', 'D2', 'G2'].map(nameToMidi) },
  { id: 'bass-5', name: '5-String Bass (BEADG)', strings: ['B0', 'E1', 'A1', 'D2', 'G2'].map(nameToMidi) },
]

export const DEFAULT_FRET_COUNT = 24

/** Midi pitch at a given string (0 = lowest) and fret (0 = open). */
export function fretMidi(tuning: Tuning, string: number, fret: number): Midi {
  const open = tuning.strings[string]
  if (open === undefined) throw new Error(`String ${string} out of range for ${tuning.id}`)
  if (fret < 0) throw new Error(`Invalid fret: ${fret}`)
  return open + fret
}

/** Standard 88-key piano range. */
export const PIANO_RANGE = { lowest: nameToMidi('A0'), highest: nameToMidi('C8') }
