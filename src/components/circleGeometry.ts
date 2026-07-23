/**
 * Pure, framework-free geometry and key-naming helpers for the `CircleOfFifths`
 * SVG component. Nothing here touches `window`/`document`, so it is fully
 * unit-testable in the node test environment.
 *
 * Orientation: a clock face. Angle 0 is 12 o'clock (straight up); angle
 * increases clockwise, matching the conventional circle-of-fifths diagram
 * (C at the top, G at 1 o'clock, D at 2 o'clock, ...).
 *
 * All key naming builds on `src/lib/theory/` (`CIRCLE_OF_FIFTHS`,
 * `majorKeySignature`, `spellScale`) rather than re-deriving music theory —
 * this file only adds the letter-per-position table needed to disambiguate
 * enharmonic spellings, plus angle/path math.
 */

import { getScale, majorKeySignature, CIRCLE_OF_FIFTHS } from '../lib/theory/scales.ts'
import { spellScale } from '../lib/theory/spell.ts'
import { LETTERS, mod12, type Letter, type PitchClass } from '../lib/theory/notes.ts'

/** Number of segments drawn on the circle (one per major/relative-minor pair). */
export const CIRCLE_SEGMENT_COUNT = 12

/** Angular width of one segment, in degrees. */
export const SEGMENT_ANGLE_DEG = 360 / CIRCLE_SEGMENT_COUNT

const MAJOR_INTERVALS = getScale('major').intervals
const MINOR_INTERVALS = getScale('minor').intervals

/**
 * Root letter (before accidentals) for the major key at each circle index,
 * in fifths order (C G D A E B F# Db Ab Eb Bb F). Index 6 (F#/Gb) is the
 * only enharmonic position; its alternate flat-side letter is supplied
 * separately below.
 */
const MAJOR_ROOT_LETTER: readonly Letter[] = ['C', 'G', 'D', 'A', 'E', 'B', 'F', 'D', 'A', 'E', 'B', 'F']

/** Index of the enharmonic F#/Gb position. */
const ENHARMONIC_INDEX = 6
/** Alternate (flat-side) root letter at the enharmonic position: Gb. */
const ENHARMONIC_ALT_LETTER: Letter = 'G'

/** A key position on the circle: a major key paired with its relative minor. */
export interface CircleKey {
  /** 0–11, position clockwise from 12 o'clock (0 = C). */
  index: number
  majorPc: PitchClass
  minorPc: PitchClass
  /** Root letter used to spell the major key (before accidentals). */
  rootLetter: Letter
  /** Correctly-spelled major key name, e.g. "F#", "Db". */
  majorName: string
  /** Correctly-spelled relative-minor tonic name, e.g. "D#", "Bb" (uppercase; render lower-case for the minor-key convention). */
  minorName: string
  /** Signed accidental count for the major key: + sharps, − flats. */
  signature: number
  /** Enharmonic alternate spelling, only present at the F#/Gb position. */
  alt?: {
    rootLetter: Letter
    majorName: string
    minorName: string
    signature: number
  }
}

function spellRoot(pc: PitchClass, intervals: number[], letter: Letter): string {
  return spellScale(pc, intervals, letter)[0]!
}

/** The relative-minor's root letter, given the major key's root letter. */
function relativeMinorLetter(majorLetter: Letter): Letter {
  return LETTERS[(LETTERS.indexOf(majorLetter) + 5) % 7]!
}

function buildCircleKey(index: number): CircleKey {
  const majorPc = CIRCLE_OF_FIFTHS[index]!
  const minorPc = mod12(majorPc - 3)
  const rootLetter = MAJOR_ROOT_LETTER[index]!
  const majorName = spellRoot(majorPc, MAJOR_INTERVALS, rootLetter)
  const minorLetter = relativeMinorLetter(rootLetter)
  const minorName = spellRoot(minorPc, MINOR_INTERVALS, minorLetter)
  const signature = majorKeySignature(majorPc)

  const key: CircleKey = { index, majorPc, minorPc, rootLetter, majorName, minorName, signature }

  if (index === ENHARMONIC_INDEX) {
    const altRootLetter = ENHARMONIC_ALT_LETTER
    const altMajorName = spellRoot(majorPc, MAJOR_INTERVALS, altRootLetter)
    const altMinorLetter = relativeMinorLetter(altRootLetter)
    const altMinorName = spellRoot(minorPc, MINOR_INTERVALS, altMinorLetter)
    // majorKeySignature always resolves the tritone position to −6 (flats,
    // i.e. Gb); the sharp-side spelling (F#) is the same magnitude, opposite
    // sign. Both sides have exactly 6 accidentals.
    key.signature = -signature
    key.alt = { rootLetter: altRootLetter, majorName: altMajorName, minorName: altMinorName, signature }
  }

  return key
}

/** All 12 circle positions, in clockwise order starting at C (index 0). */
export const CIRCLE_KEYS: readonly CircleKey[] = Array.from({ length: CIRCLE_SEGMENT_COUNT }, (_, i) =>
  buildCircleKey(i),
)

/** Look up a circle position by its major-key pitch class. */
export function circleKeyForMajorPc(pc: PitchClass): CircleKey {
  const found = CIRCLE_KEYS.find((k) => k.majorPc === mod12(pc))
  if (!found) throw new Error(`No circle key for pitch class ${pc}`)
  return found
}

/** Format a signed accidental count as e.g. "3♯", "2♭", or "0". */
export function signatureLabel(signature: number): string {
  if (signature === 0) return '0'
  return `${Math.abs(signature)}${signature > 0 ? '♯' : '♭'}`
}

/** Conventional order sharps are added to a key signature (F, C, G, D, A, E, B). */
const SHARP_ORDER: readonly Letter[] = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
/** Conventional order flats are added to a key signature (B, E, A, D, G, C, F). */
const FLAT_ORDER: readonly Letter[] = ['B', 'E', 'A', 'D', 'G', 'C', 'F']

/**
 * The specific accidental notes in a key signature, in the conventional
 * order they'd appear on a staff, e.g. `signatureNotes(3)` -> ["F#", "C#",
 * "G#"]; `signatureNotes(-2)` -> ["Bb", "Eb"]; `signatureNotes(0)` -> [].
 */
export function signatureNotes(signature: number): string[] {
  if (signature === 0) return []
  const count = Math.min(Math.abs(signature), 7)
  const order = signature > 0 ? SHARP_ORDER : FLAT_ORDER
  const suffix = signature > 0 ? '#' : 'b'
  return order.slice(0, count).map((letter) => letter + suffix)
}

// --- Angle & coordinate geometry --------------------------------------------

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360
}

/** Angle (degrees, clockwise from 12 o'clock) of the centre of segment `index`. */
export function segmentCenterAngle(index: number): number {
  return normalizeDeg(index * SEGMENT_ANGLE_DEG)
}

/** Starting angle (clockwise edge going counter-clockwise) of segment `index`. */
export function segmentStartAngle(index: number): number {
  return segmentCenterAngle(index) - SEGMENT_ANGLE_DEG / 2
}

/** Ending angle (clockwise edge) of segment `index`. */
export function segmentEndAngle(index: number): number {
  return segmentCenterAngle(index) + SEGMENT_ANGLE_DEG / 2
}

export interface Point {
  x: number
  y: number
}

/**
 * Convert a polar coordinate (radius, angle clockwise from 12 o'clock) around
 * centre `(cx, cy)` to cartesian SVG coordinates.
 */
export function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
}

/**
 * SVG path `d` attribute for an annular (ring) sector: the area between
 * `innerR` and `outerR`, spanning `startAngleDeg` to `endAngleDeg` clockwise.
 */
export function ringSegmentPath(
  cx: number,
  cy: number,
  innerR: number,
  outerR: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const outerStart = polarToCartesian(cx, cy, outerR, startAngleDeg)
  const outerEnd = polarToCartesian(cx, cy, outerR, endAngleDeg)
  const innerEnd = polarToCartesian(cx, cy, innerR, endAngleDeg)
  const innerStart = polarToCartesian(cx, cy, innerR, startAngleDeg)
  const largeArc = endAngleDeg - startAngleDeg > 180 ? 1 : 0

  return [
    `M ${outerStart.x} ${outerStart.y}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${outerEnd.x} ${outerEnd.y}`,
    `L ${innerEnd.x} ${innerEnd.y}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${innerStart.x} ${innerStart.y}`,
    'Z',
  ].join(' ')
}

/** Position for a label centred (radially) within segment `index` at radius `r`. */
export function segmentLabelPosition(cx: number, cy: number, r: number, index: number): Point {
  return polarToCartesian(cx, cy, r, segmentCenterAngle(index))
}
