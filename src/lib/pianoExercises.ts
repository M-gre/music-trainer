/**
 * Piano dexterity exercises (M5) — a keyboard-flavoured analog of the fretted
 * `exercises.ts` engine: pure, framework-free generators that expand a chosen
 * root/quality/hand into a concrete sequence of `PianoStep`s (a midi pitch, a
 * finger 1..5, and which hand plays it) for rendering on the shared `Keyboard`
 * component and driving the same metronome scheduler.
 *
 * Two families are shipped:
 *
 *  1. **Five-finger patterns** — the first five scale degrees of a major or
 *     minor key, played in a fixed five-finger hand position (no thumb
 *     crossing). Three classic variations: a straight up-and-down run, broken
 *     thirds within the box, and a Hanon-No.1-style looping figure. Fingering
 *     is mechanical here: with no thumb-under, RH finger = degree + 1 and LH
 *     finger = 5 − degree, so it needs no lookup table.
 *
 *  2. **Scale fingerings** — one- and two-octave MAJOR scales with the standard
 *     conservatory fingerings, encoded as an explicit per-key table (see
 *     `MAJOR_SCALE_FINGERINGS`) rather than derived heuristically. The
 *     one-octave table is the source of truth; multi-octave sequences are
 *     assembled from it with a single, citable octave-boundary rule (see
 *     `scaleFingers`). Minor-scale full fingerings are intentionally NOT
 *     shipped — the five-finger family already covers minor keys, and the
 *     many black-key minor fingering exceptions are left for a later item.
 *
 * Fingering source of truth: piano.org "Piano Fingering Charts — All Major and
 * Minor Scale Fingerings" (https://piano.org/theory/piano-fingering/), which
 * matches the standard Hanon/conservatory one-octave fingerings taught in
 * method books. Finger numbers are 1 = thumb … 5 = pinky.
 *
 * Everything here is pure and unit-tested under the `node` environment; the
 * `Direction` type is reused from `exercises.ts` so the page's existing
 * forward / reverse / forward-then-reverse control applies to piano steps too.
 */

import type { Direction } from './exercises.ts'
import { mod12, type Midi, type PitchClass } from './theory/notes.ts'

/** A piano finger: 1 = thumb, 2 = index, 3 = middle, 4 = ring, 5 = pinky. */
export type PianoFinger = 1 | 2 | 3 | 4 | 5

/** Which hand plays a step. */
export type Hand = 'left' | 'right'

export const HANDS: readonly Hand[] = ['right', 'left']

/** One concrete note of a piano exercise: pitch + finger + hand. */
export interface PianoStep {
  /** Midi pitch of the note. */
  midi: Midi
  /** Fingering, 1 (thumb) .. 5 (pinky). */
  finger: PianoFinger
  /** Hand that plays it. */
  hand: Hand
}

// --- Octave / root helpers ---------------------------------------------------

/** Lowest and highest root octave (scientific pitch, C4 = middle C) offered. */
export const MIN_PIANO_OCTAVE = 1
export const MAX_PIANO_OCTAVE = 6

/** Clamp a root octave into `[MIN_PIANO_OCTAVE, MAX_PIANO_OCTAVE]`. */
export function clampPianoOctave(octave: number): number {
  if (!Number.isFinite(octave)) return 4
  return Math.min(MAX_PIANO_OCTAVE, Math.max(MIN_PIANO_OCTAVE, Math.round(octave)))
}

/** Midi of a pitch class at a scientific-pitch octave (C4 = 60). */
export function rootMidi(pc: PitchClass, octave: number): Midi {
  return (octave + 1) * 12 + mod12(pc)
}

// --- Five-finger patterns ----------------------------------------------------

export type FiveFingerQuality = 'major' | 'minor'

export const FIVE_FINGER_QUALITIES: readonly FiveFingerQuality[] = ['major', 'minor']

/** Semitone offsets of the five-finger box's degrees 1..5 from the root. */
const FIVE_FINGER_INTERVALS: Record<FiveFingerQuality, readonly number[]> = {
  // Major: 1-2-3-4-5 = whole, whole, half, whole (C D E F G).
  major: [0, 2, 4, 5, 7],
  // Minor: flattened third (C D Eb F G).
  minor: [0, 2, 3, 5, 7],
}

export type FiveFingerPatternId = 'up-down' | 'broken-thirds' | 'hanon-1'

export interface FiveFingerPatternDef {
  id: FiveFingerPatternId
  name: string
  description: string
  /**
   * The box degrees (0..4 = degrees 1..5) in play order. Each degree maps to a
   * fixed finger by the hand rule, so this is all a variation needs.
   */
  degrees: readonly number[]
}

export const FIVE_FINGER_PATTERNS: readonly FiveFingerPatternDef[] = [
  {
    id: 'up-down',
    name: 'Up & down',
    description:
      'The five notes of the position played straight up then back down (fingers 1-2-3-4-5-4-3-2-1). The staple warm-up for even tone and finger independence.',
    degrees: [0, 1, 2, 3, 4, 3, 2, 1, 0],
  },
  {
    id: 'broken-thirds',
    name: 'Broken thirds',
    description:
      'Thirds within the five-finger box — 1-3, 2-4, 3-5 ascending then back down. Trains skipping a finger cleanly and the "over-and-under" feel of thirds.',
    degrees: [0, 2, 1, 3, 2, 4, 3, 1, 2, 0],
  },
  {
    id: 'hanon-1',
    name: 'Hanon No.1 figure',
    description:
      'The Hanon Exercise No.1 cell in one position: up to the pinky and back to the index (fingers 1-2-3-4-5-4-3-2), looping without resolving to the root. Builds endurance and evenness.',
    degrees: [0, 1, 2, 3, 4, 3, 2, 1],
  },
]

export const DEFAULT_FIVE_FINGER_PATTERN_ID: FiveFingerPatternId = 'up-down'

export function isFiveFingerPatternId(value: unknown): value is FiveFingerPatternId {
  return value === 'up-down' || value === 'broken-thirds' || value === 'hanon-1'
}

export function isFiveFingerQuality(value: unknown): value is FiveFingerQuality {
  return value === 'major' || value === 'minor'
}

export function isHand(value: unknown): value is Hand {
  return value === 'left' || value === 'right'
}

export function getFiveFingerPattern(id: string): FiveFingerPatternDef {
  return FIVE_FINGER_PATTERNS.find((p) => p.id === id) ?? FIVE_FINGER_PATTERNS[0]!
}

/**
 * The finger for a five-finger-box degree (0..4). There is no thumb crossing in
 * a five-finger pattern, so the mapping is fixed: the right hand runs thumb→
 * pinky up the notes (finger = degree + 1) and the left hand runs pinky→thumb
 * (finger = 5 − degree, so its thumb sits on the highest note).
 */
export function fiveFingerFinger(degree: number, hand: Hand): PianoFinger {
  const f = hand === 'right' ? degree + 1 : 5 - degree
  return f as PianoFinger
}

export interface FiveFingerOptions {
  /** Root pitch class 0..11. */
  root: PitchClass
  /** Octave of the root (scientific pitch). */
  octave: number
  quality: FiveFingerQuality
  patternId: FiveFingerPatternId
  hand: Hand
}

/** Expand a five-finger pattern into an ascending-order `PianoStep[]`. */
export function buildFiveFinger(opts: FiveFingerOptions): PianoStep[] {
  const intervals = FIVE_FINGER_INTERVALS[opts.quality]
  const base = rootMidi(opts.root, opts.octave)
  const pattern = getFiveFingerPattern(opts.patternId)
  return pattern.degrees.map((degree) => ({
    midi: base + (intervals[degree] ?? 0),
    finger: fiveFingerFinger(degree, opts.hand),
    hand: opts.hand,
  }))
}

// --- Major scale fingerings --------------------------------------------------

/** One-octave ascending fingerings (8 entries, tonic → octave) for a hand. */
interface OneOctaveFingering {
  rh: readonly PianoFinger[]
  lh: readonly PianoFinger[]
}

/**
 * Standard one-octave major-scale fingerings, keyed by the tonic's pitch class.
 * Source: piano.org fingering charts (matches Hanon/conservatory standard).
 * Each array is tonic→octave ascending; the descending fingering is the same
 * numbers reversed (the hand retraces its steps).
 *
 * Notable exceptions encoded here:
 *  - F major RH crosses the thumb after the 4th finger: 1-2-3-4-1-2-3-4.
 *  - B major LH uses 4-3-2-1-4-3-2-1 (not the 5-4-3-2-1-3-2-1 white-key form).
 *  - The five black-key tonics (Db, Eb, Gb, Ab, Bb) start on 2, 3 or 4 because
 *    the thumb never plays a black key; Gb's LH (4-3-2-1-3-2-1-4) differs from
 *    the other black-key LH form (3-2-1-4-3-2-1-3).
 */
const MAJOR_SCALE_FINGERINGS: Record<number, OneOctaveFingering> = {
  0: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // C
  1: { rh: [2, 3, 1, 2, 3, 4, 1, 2], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // Db
  2: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // D
  3: { rh: [3, 1, 2, 3, 4, 1, 2, 3], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // Eb
  4: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // E
  5: { rh: [1, 2, 3, 4, 1, 2, 3, 4], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // F
  6: { rh: [2, 3, 4, 1, 2, 3, 1, 2], lh: [4, 3, 2, 1, 3, 2, 1, 4] }, // Gb / F#
  7: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // G
  8: { rh: [3, 4, 1, 2, 3, 1, 2, 3], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // Ab
  9: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [5, 4, 3, 2, 1, 3, 2, 1] }, // A
  10: { rh: [4, 1, 2, 3, 1, 2, 3, 4], lh: [3, 2, 1, 4, 3, 2, 1, 3] }, // Bb
  11: { rh: [1, 2, 3, 1, 2, 3, 4, 5], lh: [4, 3, 2, 1, 4, 3, 2, 1] }, // B
}

/** Pitch classes with a natural (white-key) tonic — for the boundary rule. */
const WHITE_KEY_PCS = new Set([0, 2, 4, 5, 7, 9, 11])

/** Major intervals (Ionian) used to place scale pitches. */
const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11] as const

/** Number of octaves offered for a scale drill. */
export const SCALE_OCTAVE_OPTIONS = [1, 2] as const

export type ScaleOctaves = (typeof SCALE_OCTAVE_OPTIONS)[number]

export function isScaleOctaves(value: unknown): value is ScaleOctaves {
  return value === 1 || value === 2
}

/** True when a standard fingering exists for a major scale on this pitch class. */
export function hasMajorScaleFingering(pc: PitchClass): boolean {
  return mod12(pc) in MAJOR_SCALE_FINGERINGS
}

/**
 * The ascending finger sequence for `octaves` octaves of a major scale on the
 * given hand. Built from the one-octave table with a single octave-boundary
 * rule, so every internal boundary is fingered consistently and no two
 * consecutive notes share the thumb:
 *
 *  - The very first (lowest) note uses the table's starting finger.
 *  - At every internal octave boundary the tonic is re-fingered: the thumb (1)
 *    for a white-key tonic, otherwise the table's starting finger again (the
 *    thumb can't play a black key, so the black-key start finger recurs).
 *  - Degrees 2..7 within every octave repeat the table's fingers for those
 *    degrees.
 *  - The final (highest) tonic uses the table's terminal (8th) finger.
 *
 * For the right hand the starting finger already equals the boundary finger in
 * every key, so RH octaves are identical repeats; the left hand differs only in
 * that its white-key scales start on the pinky (5 or 4) but cross to the thumb
 * at each internal boundary.
 */
export function scaleFingers(pc: PitchClass, hand: Hand, octaves: number): PianoFinger[] {
  const fingering = MAJOR_SCALE_FINGERINGS[mod12(pc)]
  if (!fingering) return []
  const oneOctave = hand === 'right' ? fingering.rh : fingering.lh
  const n = Math.max(1, Math.floor(octaves))
  const start = oneOctave[0]!
  const terminal = oneOctave[7]!
  const boundary: PianoFinger = hand === 'right' ? start : WHITE_KEY_PCS.has(mod12(pc)) ? 1 : start
  const body = oneOctave.slice(1, 7) // degrees 2..7 within an octave

  const result: PianoFinger[] = [start, ...body]
  for (let k = 1; k < n; k += 1) result.push(boundary, ...body)
  result.push(terminal)
  return result
}

/** Ascending midi pitches for `octaves` octaves of a major scale from a root. */
export function scaleMidis(root: PitchClass, octave: number, octaves: number): Midi[] {
  const base = rootMidi(root, octave)
  const n = Math.max(1, Math.floor(octaves))
  const total = 7 * n
  const out: Midi[] = []
  for (let i = 0; i <= total; i += 1) {
    out.push(base + 12 * Math.floor(i / 7) + MAJOR_INTERVALS[i % 7]!)
  }
  return out
}

export interface ScaleOptions {
  /** Tonic pitch class 0..11. */
  root: PitchClass
  /** Octave of the tonic (scientific pitch). */
  octave: number
  octaves: number
  hand: Hand
}

/**
 * Expand a major-scale fingering into an ascending-order `PianoStep[]`. Returns
 * an empty array if no standard fingering is tabulated for the tonic (never the
 * case for the twelve chromatic pitch classes, all of which are covered).
 */
export function buildScale(opts: ScaleOptions): PianoStep[] {
  const fingers = scaleFingers(opts.root, opts.hand, opts.octaves)
  const midis = scaleMidis(opts.root, opts.octave, opts.octaves)
  const steps: PianoStep[] = []
  for (let i = 0; i < midis.length; i += 1) {
    const finger = fingers[i]
    const midi = midis[i]
    if (finger === undefined || midi === undefined) continue
    steps.push({ midi, finger, hand: opts.hand })
  }
  return steps
}

// --- Direction (reuses the exercises.ts Direction vocabulary) ----------------

/**
 * Apply a playback `Direction` to an ascending piano step sequence — the same
 * transform `applyDirection` performs for fretted `ExerciseStep`s, so the page
 * can drive both with one control. `forward-reverse` plays up then down without
 * repeating the turnaround note, retracing the fingering exactly.
 */
export function applyPianoDirection(steps: readonly PianoStep[], direction: Direction): PianoStep[] {
  switch (direction) {
    case 'forward':
      return [...steps]
    case 'reverse':
      return [...steps].reverse()
    case 'forward-reverse': {
      if (steps.length <= 1) return [...steps]
      const back = steps.slice(0, -1).reverse()
      return [...steps, ...back]
    }
  }
}

// --- Exercise-kind catalog ---------------------------------------------------

export type PianoExerciseKind = 'five-finger' | 'scale'

export const PIANO_EXERCISE_KINDS: readonly { id: PianoExerciseKind; name: string; tagline: string }[] = [
  { id: 'five-finger', name: 'Five-finger patterns', tagline: 'First five scale degrees — no thumb crossing' },
  { id: 'scale', name: 'Scale fingerings', tagline: 'Major scales with standard 1–2 octave fingerings' },
]

export const DEFAULT_PIANO_EXERCISE_KIND: PianoExerciseKind = 'five-finger'

export function isPianoExerciseKind(value: unknown): value is PianoExerciseKind {
  return value === 'five-finger' || value === 'scale'
}
