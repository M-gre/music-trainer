/** Interval definitions: semitone counts and display names. */

export interface Interval {
  semitones: number
  /** Short name, e.g. "P5", "m3". */
  short: string
  /** Full name, e.g. "Perfect Fifth". */
  name: string
}

export const INTERVALS: Interval[] = [
  { semitones: 0, short: 'P1', name: 'Unison' },
  { semitones: 1, short: 'm2', name: 'Minor Second' },
  { semitones: 2, short: 'M2', name: 'Major Second' },
  { semitones: 3, short: 'm3', name: 'Minor Third' },
  { semitones: 4, short: 'M3', name: 'Major Third' },
  { semitones: 5, short: 'P4', name: 'Perfect Fourth' },
  { semitones: 6, short: 'TT', name: 'Tritone' },
  { semitones: 7, short: 'P5', name: 'Perfect Fifth' },
  { semitones: 8, short: 'm6', name: 'Minor Sixth' },
  { semitones: 9, short: 'M6', name: 'Major Sixth' },
  { semitones: 10, short: 'm7', name: 'Minor Seventh' },
  { semitones: 11, short: 'M7', name: 'Major Seventh' },
  { semitones: 12, short: 'P8', name: 'Octave' },
]

export function intervalName(semitones: number): Interval {
  const interval = INTERVALS[semitones]
  if (!interval) throw new Error(`No interval defined for ${semitones} semitones`)
  return interval
}
