/**
 * Pure, framework-free geometry and note-placement math for the `Staff` SVG
 * component. Nothing here touches `window`/`document`, so it is fully
 * unit-testable in the node test environment.
 *
 * Two layers, matching the `keyboardGeometry.ts` / `fretboardGeometry.ts`
 * pattern:
 *
 *  1. Musical placement — given a midi pitch, a clef, and a preferred
 *     accidental spelling, work out which diatonic staff step the notehead
 *     sits on, whether it needs an accidental, and which ledger lines are
 *     required. This is the "midi + clef + spelling → step/ledger/accidental"
 *     core the tests exercise directly.
 *  2. Pixel layout — turn a config (line gap, paddings) into concrete SVG
 *     coordinates, and map a staff position to a y coordinate.
 *
 * Vertical model: a staff position is an integer counting diatonic steps from
 * the clef's bottom staff line. Position 0 is the bottom line, 8 the top line;
 * even positions are lines, odd positions are the spaces between. Higher
 * position = higher pitch = smaller y (further up the SVG).
 */

import { LETTERS, midiToOctave, midiToPc, pcToName, type Letter } from '../lib/theory/notes.ts'
import { majorKeySignature } from '../lib/theory/scales.ts'
import { prefersFlats } from '../lib/theory/spell.ts'

export type Clef = 'treble' | 'bass'
export type Accidental = 'sharp' | 'flat'

/** Diatonic index of each natural letter within an octave (C = 0 … B = 6). */
export const LETTER_STEP: Record<Letter, number> = {
  C: 0,
  D: 1,
  E: 2,
  F: 3,
  G: 4,
  A: 5,
  B: 6,
}

/**
 * Absolute diatonic step of a lettered note in a given (scientific) octave.
 * C4 = 4 * 7 + 0 = 28, E4 = 30, G2 = 18. Monotonic in pitch by letter/octave.
 */
export function diatonicStep(letter: Letter, octave: number): number {
  return octave * 7 + LETTER_STEP[letter]
}

/**
 * Absolute diatonic step of the note sitting on each clef's bottom staff line:
 * treble bottom line = E4, bass bottom line = G2. A note's staff *position* is
 * its diatonic step minus this reference.
 */
export const CLEF_BOTTOM_STEP: Record<Clef, number> = {
  treble: diatonicStep('E', 4),
  bass: diatonicStep('G', 2),
}

/** A note resolved for drawing on a staff. */
export interface StaffNote {
  midi: number
  /** Natural letter the notehead is drawn on (C…B). */
  letter: Letter
  /** Scientific octave of that letter. */
  octave: number
  /** Accidental to draw, or null for a natural. */
  accidental: Accidental | null
  /** Absolute diatonic step (octave-independent reference). */
  step: number
  /** Staff position: diatonic steps above the clef's bottom line. */
  position: number
}

/**
 * Resolve a midi pitch to a staff note for the given clef, spelling accidentals
 * with sharps or flats as asked. Uses the plain sharp/flat name tables, which
 * never spell across an octave boundary (no B# / Cb), so the drawn octave is
 * simply the pitch's octave.
 */
export function midiToStaffNote(
  midi: number,
  clef: Clef,
  prefer: Accidental = 'sharp',
): StaffNote {
  const name = pcToName(midiToPc(midi), prefer)
  const letter = name[0] as Letter
  const accidental: Accidental | null = name.includes('#')
    ? 'sharp'
    : name.includes('b')
      ? 'flat'
      : null
  const octave = midiToOctave(midi)
  const step = diatonicStep(letter, octave)
  const position = step - CLEF_BOTTOM_STEP[clef]
  return { midi, letter, octave, accidental, step, position }
}

/**
 * Even staff positions (lines) that must be drawn as ledger lines for a note
 * at `position`, ascending. Notes above the top line (position > 8) get ledger
 * lines at 10, 12, …; notes below the bottom line (position < 0) at -2, -4, ….
 * A note sitting in the space immediately above/below the staff needs none.
 */
export function ledgerLines(position: number): number[] {
  const lines: number[] = []
  if (position <= -2) {
    for (let e = -2; e >= position; e -= 2) lines.push(e)
    lines.reverse()
  } else if (position >= 10) {
    for (let e = 10; e <= position; e += 2) lines.push(e)
  }
  return lines
}

/**
 * Preferred accidental spelling for a major key: flat keys (F, Bb, …) spell
 * with flats, sharp keys with sharps. Lets the quiz name notes in a way that
 * matches the drawn key context.
 */
export function preferForKey(majorRoot: number): Accidental {
  return prefersFlats(majorRoot) ? 'flat' : 'sharp'
}

/** Signed accidental count of a major key, re-exported for convenience. */
export function keySignatureCount(majorRoot: number): number {
  return majorKeySignature(majorRoot)
}

/** Tunable pixel metrics for the SVG staff layout. */
export interface StaffLayoutConfig {
  /** Vertical distance between two adjacent staff lines. */
  lineGap: number
  /** Horizontal padding at each end of the staff lines. */
  marginX: number
  /** Length of the drawn staff lines. */
  staffLength: number
  /** Vertical padding above/below the staff, leaving room for ledger lines. */
  padY: number
}

export const DEFAULT_STAFF_LAYOUT: StaffLayoutConfig = {
  lineGap: 14,
  marginX: 10,
  staffLength: 240,
  padY: 52,
}

/** Fully-resolved staff layout: derived pixel coordinates for one config. */
export interface StaffLayout {
  config: StaffLayoutConfig
  width: number
  height: number
  /** y of the top line (position 8). */
  topLineY: number
  /** y of the bottom line (position 0). */
  bottomLineY: number
  /** y of each of the five staff lines, top to bottom. */
  lineYs: number[]
  /** Left x of the staff lines. */
  staffLeft: number
  /** Right x of the staff lines. */
  staffRight: number
  /** x where the clef glyph is centred. */
  clefX: number
  /** x where the notehead is centred. */
  noteX: number
  /** x where an accidental glyph is centred. */
  accidentalX: number
  /** Notehead horizontal radius. */
  noteRx: number
  /** Notehead vertical radius. */
  noteRy: number
  /** Half-length of a ledger line. */
  ledgerHalf: number
}

/** Compute SVG coordinates for a config. Pure: same input → same output. */
export function computeStaffLayout(
  config: StaffLayoutConfig = DEFAULT_STAFF_LAYOUT,
): StaffLayout {
  const { lineGap, marginX, staffLength, padY } = config
  const topLineY = padY
  const bottomLineY = topLineY + 4 * lineGap
  const lineYs = [0, 1, 2, 3, 4].map((i) => topLineY + i * lineGap)
  const staffLeft = marginX
  const staffRight = marginX + staffLength
  const width = staffRight + marginX
  const height = bottomLineY + padY
  const clefX = staffLeft + lineGap * 1.6
  const noteX = staffLeft + staffLength * 0.66
  const noteRx = lineGap * 0.62
  const noteRy = lineGap * 0.5
  const accidentalX = noteX - noteRx - lineGap * 0.7
  const ledgerHalf = noteRx * 1.7
  return {
    config,
    width,
    height,
    topLineY,
    bottomLineY,
    lineYs,
    staffLeft,
    staffRight,
    clefX,
    noteX,
    accidentalX,
    noteRx,
    noteRy,
    ledgerHalf,
  }
}

/** y coordinate of a staff position (0 = bottom line, higher = further up). */
export function yForPosition(layout: StaffLayout, position: number): number {
  return layout.bottomLineY - position * (layout.config.lineGap / 2)
}

/** The natural letters in ascending diatonic order, re-exported for callers. */
export const STAFF_LETTERS = LETTERS
