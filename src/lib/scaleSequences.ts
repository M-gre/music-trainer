/**
 * Scale-sequence drills (M5) — run any scale through a melodic sequence pattern
 * (diatonic 3rds/4ths, groups-of-3, groups-of-4, up-and-back) inside a fret
 * *position*, on any tuning. Pure and framework-free, like the rest of
 * `src/lib/`; the Dexterity page feeds the output straight into the same
 * rendering / metronome pipeline the built-in `exercises.ts` patterns use.
 *
 * Unlike an `ExercisePattern` template (fret *offsets* repeated across strings),
 * a scale can't be described by a fixed box — the frets a scale tone lands on
 * differ per string whenever adjacent strings aren't a uniform interval apart
 * (e.g. guitar's major-third G→B pair). So this module works in real pitch
 * space: every candidate fret's midi is derived from the tuning's actual
 * open-string pitch and tested against the scale's pitch-class set. The result
 * is emitted as the SAME `ExerciseStep[]` shape `expandPattern` produces, so
 * the page's numbering, marker building, direction toggle (`applyDirection`),
 * and scheduler sync all work unchanged.
 *
 * Position model — for a tuning, root pc, scale, and an `anchor` fret, the
 * "position" is the fret window `[anchor, anchor + span - 1]` (same window on
 * every string, `span` defaulting to `POSITION_SPAN`). The position's ordered
 * scale tones are every in-window scale tone, walked string-by-string low→high
 * and, within each string, fret ascending ("ascending across strings"). This
 * string-major order is exactly how a scale is played in a position.
 *
 * Finger rule — `finger = clamp(fret - anchor + 1, 1, 4)`: the index finger
 * (1) anchors the window's first fret, and each fret higher steps to the next
 * finger, so a note reached by stretching past the pinky's home fret is played
 * with the pinky (4) rather than an impossible 5th finger.
 */

import { type ExerciseStep, type Finger } from './exercises.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { mod12, type Midi, type PitchClass } from './theory/notes.ts'
import { type Scale, scalePcs } from './theory/scales.ts'

/** Default position-window width, in frets (a classic four-fret box). */
export const POSITION_SPAN = 4

/** One scale tone placed in a position: its board cell, finger, and pitch. */
export interface PositionTone {
  /** Absolute string index, 0 = lowest-pitched string. */
  string: number
  /** Absolute fret, 0 = open. */
  fret: number
  /** Fretting finger, 1..4. */
  finger: Finger
  /** Midi pitch of the tone. */
  midi: Midi
}

/** Clamp any offset into a valid fretting finger, 1..4. */
function clampFinger(value: number): Finger {
  return Math.min(4, Math.max(1, value)) as Finger
}

/**
 * The ordered scale tones of a position: every scale tone whose fret lies in
 * the window `[anchor, anchor + span - 1]`, walked string-by-string low→high
 * and fret-ascending within each string. Frets below the nut (< 0) are
 * skipped, so the window clips cleanly near the top of the neck. Each tone's
 * pitch comes from the tuning's real open-string pitch, never a copied fret
 * offset — so a major-third string boundary (guitar G→B) lands its tones on
 * the correct frets automatically.
 */
export function positionScaleTones(
  tuning: Tuning,
  root: PitchClass,
  scale: Scale,
  anchor: number,
  span: number = POSITION_SPAN,
): PositionTone[] {
  const pcs = new Set(scalePcs(root, scale))
  const tones: PositionTone[] = []
  const top = anchor + Math.max(1, Math.floor(span)) - 1
  for (let string = 0; string < tuning.strings.length; string += 1) {
    for (let fret = anchor; fret <= top; fret += 1) {
      if (fret < 0) continue
      const midi = fretMidi(tuning, string, fret)
      if (pcs.has(mod12(midi))) {
        tones.push({ string, fret, finger: clampFinger(fret - anchor + 1), midi })
      }
    }
  }
  return tones
}

/** Identifier of a melodic sequence pattern applied to a position's scale tones. */
export type SequencePatternId =
  | 'diatonic-3rds'
  | 'diatonic-4ths'
  | 'groups-of-3'
  | 'groups-of-4'
  | 'up-and-back'

/** A selectable sequence pattern for the picker. */
export interface SequencePattern {
  id: SequencePatternId
  name: string
  description: string
}

export const SEQUENCE_PATTERNS: readonly SequencePattern[] = [
  {
    id: 'diatonic-3rds',
    name: 'Diatonic 3rds',
    description:
      'Pairs a scale degree with the one two steps above it: 1-3, 2-4, 3-5 … climbing the position a degree at a time.',
  },
  {
    id: 'diatonic-4ths',
    name: 'Diatonic 4ths',
    description:
      'Pairs a scale degree with the one three steps above it: 1-4, 2-5, 3-6 … a wider interval workout than the 3rds.',
  },
  {
    id: 'groups-of-3',
    name: 'Groups of 3',
    description:
      'Three consecutive scale degrees starting on each degree in turn: 1-2-3, 2-3-4, 3-4-5 … the classic triplet run.',
  },
  {
    id: 'groups-of-4',
    name: 'Groups of 4',
    description:
      'Four consecutive scale degrees starting on each degree in turn: 1-2-3-4, 2-3-4-5 … a sixteenth-note run.',
  },
  {
    id: 'up-and-back',
    name: 'Up and back',
    description:
      'A three-note climb that turns back on the middle note, starting on each degree: 1-2-3-2, 2-3-4-3 … drills the turnaround.',
  },
]

export const DEFAULT_SEQUENCE_ID: SequencePatternId = 'diatonic-3rds'

/** Whether `id` is a known sequence-pattern id. */
export function isSequencePatternId(id: string): id is SequencePatternId {
  return SEQUENCE_PATTERNS.some((p) => p.id === id)
}

/** Look up a sequence pattern by id, falling back to the default for unknown ids. */
export function getSequencePattern(id: string): SequencePattern {
  return SEQUENCE_PATTERNS.find((p) => p.id === id) ?? SEQUENCE_PATTERNS[0]!
}

/**
 * The flat list of scale-tone *indices* a pattern visits over `n` ordered
 * tones. Each pattern slides a small window one degree at a time for as long
 * as the window fits, so a pattern that reaches beyond the last tone simply
 * stops (and returns `[]` when the position has too few tones for even one
 * group). Canonical group definitions (indices are 0-based; degree = index+1):
 *
 *  - `diatonic-3rds`  → `i, i+2` for each `i` (1-3, 2-4, 3-5 …)
 *  - `diatonic-4ths`  → `i, i+3` for each `i` (1-4, 2-5, 3-6 …)
 *  - `groups-of-3`    → `i, i+1, i+2` for each `i` (1-2-3, 2-3-4 …)
 *  - `groups-of-4`    → `i, i+1, i+2, i+3` for each `i` (1-2-3-4, 2-3-4-5 …)
 *  - `up-and-back`    → `i, i+1, i+2, i+1` for each `i` (1-2-3-2, 2-3-4-3 …)
 */
export function sequenceIndices(patternId: SequencePatternId, n: number): number[] {
  const out: number[] = []
  switch (patternId) {
    case 'diatonic-3rds':
      for (let i = 0; i + 2 < n; i += 1) out.push(i, i + 2)
      break
    case 'diatonic-4ths':
      for (let i = 0; i + 3 < n; i += 1) out.push(i, i + 3)
      break
    case 'groups-of-3':
      for (let i = 0; i + 2 < n; i += 1) out.push(i, i + 1, i + 2)
      break
    case 'groups-of-4':
      for (let i = 0; i + 3 < n; i += 1) out.push(i, i + 1, i + 2, i + 3)
      break
    case 'up-and-back':
      for (let i = 0; i + 2 < n; i += 1) out.push(i, i + 1, i + 2, i + 1)
      break
  }
  return out
}

/** Everything needed to expand a scale-sequence drill in a position. */
export interface ScaleSequenceConfig {
  /** The instrument tuning (drives string count + pitches). */
  tuning: Tuning
  /** Root pitch class, 0–11 (0 = C). */
  root: PitchClass
  /** The scale whose intervals define the tone set. */
  scale: Scale
  /** Which melodic sequence to run through the position. */
  patternId: SequencePatternId
  /** Position anchor: the window's first (index-finger) fret. */
  anchor: number
  /** Window width in frets; defaults to `POSITION_SPAN`. */
  span?: number
}

/**
 * Expand a scale-sequence drill into a concrete step sequence — the same
 * `ExerciseStep[]` shape `expandPattern` produces, so it drops straight into
 * the Dexterity page's rendering + scheduler pipeline (and can be run through
 * `applyDirection` for the forward/reverse/forward-reverse toggle). Mirrors
 * `expandPattern`'s `(config, anchor)` call shape via the `anchor` field so
 * the page's per-loop position advance (`positionForLoop`) works unchanged.
 */
export function expandScaleSequence(config: ScaleSequenceConfig): ExerciseStep[] {
  const { tuning, root, scale, patternId, anchor, span } = config
  const tones = positionScaleTones(tuning, root, scale, anchor, span)
  return sequenceIndices(patternId, tones.length).map((idx) => {
    const tone = tones[idx]!
    return { string: tone.string, fret: tone.fret, finger: tone.finger, duration: 1, midi: tone.midi }
  })
}
