import { nameToMidi, type Midi } from './notes.ts'

export type FrettedInstrument = 'bass' | 'guitar'

/** A fretted string instrument tuning, low string first. */
export interface Tuning {
  id: string
  name: string
  instrument: FrettedInstrument
  /** Open-string midi pitches, lowest string first. */
  strings: Midi[]
}

function tuning(id: string, name: string, instrument: FrettedInstrument, notes: string[]): Tuning {
  return { id, name, instrument, strings: notes.map(nameToMidi) }
}

export const TUNINGS: Tuning[] = [
  tuning('bass-4', '4-String Standard (EADG)', 'bass', ['E1', 'A1', 'D2', 'G2']),
  tuning('bass-4-drop-d', '4-String Drop D (DADG)', 'bass', ['D1', 'A1', 'D2', 'G2']),
  tuning('bass-5', '5-String Standard (BEADG)', 'bass', ['B0', 'E1', 'A1', 'D2', 'G2']),
  tuning('bass-6', '6-String Standard (BEADGC)', 'bass', ['B0', 'E1', 'A1', 'D2', 'G2', 'C3']),
  tuning('guitar-6', '6-String Standard (EADGBE)', 'guitar', ['E2', 'A2', 'D3', 'G3', 'B3', 'E4']),
  tuning('guitar-6-drop-d', '6-String Drop D (DADGBE)', 'guitar', ['D2', 'A2', 'D3', 'G3', 'B3', 'E4']),
  tuning('guitar-6-dadgad', '6-String DADGAD', 'guitar', ['D2', 'A2', 'D3', 'G3', 'A3', 'D4']),
  tuning('guitar-7', '7-String Standard (BEADGBE)', 'guitar', ['B1', 'E2', 'A2', 'D3', 'G3', 'B3', 'E4']),
]

export const BASS_TUNINGS: Tuning[] = TUNINGS.filter((t) => t.instrument === 'bass')
export const GUITAR_TUNINGS: Tuning[] = TUNINGS.filter((t) => t.instrument === 'guitar')

export function getTuning(id: string): Tuning {
  const found = TUNINGS.find((t) => t.id === id)
  if (!found) throw new Error(`Unknown tuning: "${id}"`)
  return found
}

/** Tunings for one instrument, grouped for pickers (string count ascending). */
export function tuningsFor(instrument: FrettedInstrument): Tuning[] {
  return TUNINGS.filter((t) => t.instrument === instrument).sort(
    (a, b) => a.strings.length - b.strings.length,
  )
}

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
