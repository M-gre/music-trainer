/**
 * Core pitch representation.
 *
 * Two levels are used throughout the app:
 *  - `Midi` (number): a concrete pitch, e.g. 60 = middle C (C4).
 *  - `PitchClass` (0–11): a pitch regardless of octave, 0 = C.
 *
 * Spelling (whether pc 1 is written C# or Db) is a separate concern handled
 * by spell.ts, because the correct name depends on musical context (key).
 */

export type Midi = number
export type PitchClass = number

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const
export type Letter = (typeof LETTERS)[number]

/** Pitch class of each natural letter. */
export const LETTER_PC: Record<Letter, PitchClass> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
}

export function mod12(n: number): PitchClass {
  return ((n % 12) + 12) % 12
}

export function midiToPc(midi: Midi): PitchClass {
  return mod12(midi)
}

/** Octave using scientific pitch notation (midi 60 = C4). */
export function midiToOctave(midi: Midi): number {
  return Math.floor(midi / 12) - 1
}

/**
 * Parse a note name like "C", "F#", "Bb", "C##", "Abb" into a pitch class.
 * Throws on invalid input.
 */
export function nameToPc(name: string): PitchClass {
  const match = /^([A-Ga-g])(#{1,2}|b{1,2})?$/.exec(name.trim())
  if (!match) throw new Error(`Invalid note name: "${name}"`)
  const letter = match[1]!.toUpperCase() as Letter
  const accidental = match[2] ?? ''
  const offset = accidental.startsWith('#') ? accidental.length : -accidental.length
  return mod12(LETTER_PC[letter] + offset)
}

/**
 * Parse a full note like "C4", "Bb2", "F#3" into a midi number.
 */
export function nameToMidi(name: string): Midi {
  const match = /^([A-Ga-g](?:#{1,2}|b{1,2})?)(-?\d+)$/.exec(name.trim())
  if (!match) throw new Error(`Invalid note: "${name}"`)
  const octave = parseInt(match[2]!, 10)
  // Reconstruct relative to the natural letter so e.g. B#3 = midi of C4.
  const letter = match[1]![0]!.toUpperCase() as Letter
  const naturalMidi = (octave + 1) * 12 + LETTER_PC[letter]
  const accidental = match[1]!.slice(1)
  const offset = accidental.startsWith('#') ? accidental.length : -accidental.length
  return naturalMidi + offset
}

/** Simple name for a pitch class, choosing sharp or flat spelling. */
export function pcToName(pc: PitchClass, prefer: 'sharp' | 'flat' = 'sharp'): string {
  const names = prefer === 'sharp' ? SHARP_NAMES : FLAT_NAMES
  return names[mod12(pc)]!
}

/** Simple name with octave for a midi pitch, e.g. 60 -> "C4". */
export function midiToName(midi: Midi, prefer: 'sharp' | 'flat' = 'sharp'): string {
  return pcToName(midiToPc(midi), prefer) + midiToOctave(midi)
}

/** Frequency in Hz using equal temperament, A4 = 440. */
export function midiToFreq(midi: Midi): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}
