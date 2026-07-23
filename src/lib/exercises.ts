/**
 * Exercise engine (M5) — a tuning-aware pattern format for fretted-instrument
 * dexterity drills, plus a pure generator that expands a compact pattern
 * *template* into a concrete sequence of fret/finger steps for a given tuning
 * and neck position.
 *
 * The format is intentionally small and composable, so this module now
 * defines a curated set of built-in patterns on top of it without touching
 * the engine: spider-walk finger-order permutations, string-crossing drills
 * (adjacent-pair walking, skip-string sixths, a raking arpeggio), and
 * position-shift drills (including a `continuous` chromatic run — see
 * `expandContinuousChromatic`). The 24-permutation generator (every spider
 * ordering, not just this curated ~6) is still a separate, later roadmap item.
 *
 *  - A `PatternCell` is one note of a repeating *motif*, expressed relative to
 *    the current traversal string and the position's base fret:
 *    `{ fret, finger, stringOffset?, duration? }`. Frets are relative to a
 *    position; strings are relative to the string the motif currently sits on
 *    (so a cell can cross to an adjacent string). Fingers are 1..4.
 *  - An `ExercisePattern` is `{ id, name, description, motif, traversal,
 *    category, continuous? }`. `traversal` says how the motif repeats across
 *    the strings; `category` groups patterns for the picker.
 *  - `expandPattern(pattern, { tuning, position })` turns that into absolute
 *    `ExerciseStep`s (`{ string, fret, finger, duration, midi }`), skipping any
 *    cell that would fall off the board — pure and fully unit-tested.
 *  - `applyDirection(steps, direction)` is an orthogonal playback transform
 *    (forward / reverse / forward-then-reverse) applied on top of any
 *    pattern's expansion, independent of that pattern's own `traversal`.
 *
 * Playback sequencing (mapping a metronome grid-step counter to a pattern step,
 * looping, and the classic +1-fret-per-loop position advance) also lives here
 * as pure functions, so the `Dexterity` page component stays thin and the
 * timing logic is testable under the `node` environment with no Web Audio.
 */

import { fretMidi, type Tuning } from './theory/instruments.ts'
import type { Midi } from './theory/notes.ts'

/** Fretting-hand finger: 1 = index .. 4 = pinky. */
export type Finger = 1 | 2 | 3 | 4

export const FINGERS: readonly Finger[] = [1, 2, 3, 4]

/** How a motif repeats across the instrument's strings. */
export type Traversal = 'ascending' | 'descending' | 'ascending-descending'

/** Picker grouping for a pattern (spider-walk permutation, string-crossing drill, or position shift). */
export type PatternCategory = 'spider' | 'crossing' | 'shift'

/**
 * One note of a repeating motif, relative to the current traversal string and
 * the position's base fret. This is the "step" of a pattern *template*; it
 * becomes a concrete `ExerciseStep` once expanded onto a tuning + position.
 */
export interface PatternCell {
  /** Fret offset from the position's base fret (0 = the base/index fret). */
  fret: number
  /** Fretting finger, 1..4. */
  finger: Finger
  /** String offset from the motif's current string (0 = same string). Default 0. */
  stringOffset?: number
  /** Length in metronome grid steps. Default 1. */
  duration?: number
}

/** A reusable exercise pattern template. */
export interface ExercisePattern {
  /** Stable id (used for persistence + the picker). */
  id: string
  /** Human-readable name. */
  name: string
  /** One-line description of what the drill trains / how it moves. */
  description: string
  /** The repeating motif played on each string, in play order. */
  motif: PatternCell[]
  /** How the motif traverses the strings. */
  traversal: Traversal
  /** Picker grouping. */
  category: PatternCategory
  /**
   * When true, `expandPattern` ignores each cell's absolute `fret` and instead
   * climbs a single continuous pitch cursor by one semitone per motif slot,
   * carrying across string boundaries (see `expandPattern`'s doc comment).
   * Used for chromatic runs that must shift position at every string
   * crossing rather than repeat the same box. Only meaningful with an
   * `ascending` traversal; defaults to false.
   */
  continuous?: boolean
}

/** A concrete, expanded step: an absolute board position + its finger + pitch. */
export interface ExerciseStep {
  /** Absolute string index, 0 = lowest-pitched string. */
  string: number
  /** Absolute fret, 0 = open. */
  fret: number
  /** Fretting finger, 1..4. */
  finger: Finger
  /** Length in metronome grid steps, >= 1. */
  duration: number
  /** Midi pitch of the note. */
  midi: Midi
}

export interface ExpandOptions {
  /** The instrument tuning (drives string count + pitches). */
  tuning: Tuning
  /** Base fret of the position (the fret the index finger anchors on). */
  position: number
}

/**
 * Build a spider-walk motif from a finger order. Each finger anchors on its
 * natural fret (finger `n` → fret offset `n - 1`), and they are played in the
 * given order — so `[1,2,3,4]` is the classic ascending 1-2-3-4 and `[4,3,2,1]`
 * its reverse. Feeding any permutation of `[1,2,3,4]` yields one of the 24
 * spider-walk orderings the permutation generator (next roadmap item) needs.
 */
export function spiderMotif(fingerOrder: readonly Finger[]): PatternCell[] {
  return fingerOrder.map((finger) => ({ fret: finger - 1, finger }))
}

/**
 * The base-string play order for a traversal, given a string count. Strings are
 * 0 = lowest. `ascending` walks low→high with the motif forward; `descending`
 * walks high→low with the motif reversed; `ascending-descending` concatenates
 * the two (a full up-and-down loop).
 */
interface TraversalPass {
  /** Base string the motif sits on for this pass. */
  string: number
  /** Whether to play the motif reversed (high fret → low fret). */
  reversed: boolean
}

function traversalPasses(traversal: Traversal, stringCount: number): TraversalPass[] {
  const low = Array.from({ length: stringCount }, (_, i) => i)
  const asc: TraversalPass[] = low.map((s) => ({ string: s, reversed: false }))
  const desc: TraversalPass[] = [...low].reverse().map((s) => ({ string: s, reversed: true }))
  switch (traversal) {
    case 'ascending':
      return asc
    case 'descending':
      return desc
    case 'ascending-descending':
      return [...asc, ...desc]
  }
}

/**
 * Expand a pattern template into a concrete step sequence for a tuning at a
 * given position. Cells that would fall off the board (string out of range or
 * negative fret) are skipped, so a pattern renders on any string count.
 *
 * `continuous` patterns (see `ExercisePattern.continuous`) are expanded
 * differently: instead of applying each cell's fixed fret offset on every
 * string, `expandContinuousChromatic` walks a single absolute-pitch cursor
 * that climbs one semitone per motif slot, carrying across string
 * boundaries. That makes the run genuinely continuous (no repeated or
 * skipped semitones) on *any* tuning, including ones where adjacent strings
 * aren't a uniform interval apart (e.g. guitar's major-third G-B pair) —
 * every fret is derived from the tuning's real open-string pitch, never
 * assumed.
 */
export function expandPattern(pattern: ExercisePattern, opts: ExpandOptions): ExerciseStep[] {
  const { tuning, position } = opts
  if (pattern.continuous) return expandContinuousChromatic(pattern, tuning, position)

  const stringCount = tuning.strings.length
  const steps: ExerciseStep[] = []

  for (const pass of traversalPasses(pattern.traversal, stringCount)) {
    const cells = pass.reversed ? [...pattern.motif].reverse() : pattern.motif
    for (const cell of cells) {
      const string = pass.string + (cell.stringOffset ?? 0)
      const fret = position + cell.fret
      if (string < 0 || string >= stringCount || fret < 0) continue
      steps.push({
        string,
        fret,
        finger: cell.finger,
        duration: Math.max(1, Math.floor(cell.duration ?? 1)),
        midi: fretMidi(tuning, string, fret),
      })
    }
  }

  return steps
}

/**
 * Expand a `continuous` pattern: one absolute-pitch cursor climbs by exactly
 * one semitone per motif slot (`pattern.motif.length` slots per string),
 * moving to the next string once the current one is exhausted. Each cell's
 * `finger` is kept (the fingering cycle), but its `fret` is ignored — the
 * fret is always derived as `cursor - openStringPitch`, so the pattern shifts
 * position by whatever the tuning's actual interval demands at every string
 * crossing instead of repeating a fixed box. A slot is dropped (cursor still
 * advances) when it would land below the nut, e.g. near the very bottom of
 * the neck or right after an unusually wide string interval.
 */
function expandContinuousChromatic(pattern: ExercisePattern, tuning: Tuning, position: number): ExerciseStep[] {
  const stringCount = tuning.strings.length
  const notesPerString = pattern.motif.length
  const steps: ExerciseStep[] = []
  const open0 = tuning.strings[0]
  let midi: Midi = (open0 ?? 0) + position

  for (let s = 0; s < stringCount; s += 1) {
    const open = tuning.strings[s]
    if (open === undefined) continue
    for (let i = 0; i < notesPerString; i += 1) {
      const cell = pattern.motif[i]
      if (!cell) continue
      const fret = midi - open
      if (fret >= 0) {
        steps.push({
          string: s,
          fret,
          finger: cell.finger,
          duration: Math.max(1, Math.floor(cell.duration ?? 1)),
          midi,
        })
      }
      midi += 1
    }
  }

  return steps
}

// --- Playback sequencing (pure) ---------------------------------------------

/**
 * The grid-step onset of every step within one loop, plus the loop's total
 * length in grid steps. Durations are cumulative, so a step with `duration: 2`
 * occupies two metronome grid steps before the next note sounds.
 */
export interface StepTiming {
  /** Grid-step offset at which each step begins, within one loop. */
  onsets: number[]
  /** Total grid steps spanned by one loop. */
  totalGridSteps: number
}

export function stepTimings(steps: readonly Pick<ExerciseStep, 'duration'>[]): StepTiming {
  const onsets: number[] = []
  let cursor = 0
  for (const step of steps) {
    onsets.push(cursor)
    cursor += Math.max(1, Math.floor(step.duration))
  }
  return { onsets, totalGridSteps: cursor }
}

/** Where an absolute grid step lands within the looping pattern. */
export interface StepLocation {
  /** Which loop iteration (0-based). */
  loop: number
  /** Index of the active step within the pattern. */
  stepIndex: number
  /** True when this grid step is the note's onset (play audio only then). */
  isOnset: boolean
}

/**
 * Map an absolute metronome grid-step counter (the scheduler's `event.step`) to
 * a location in the looping pattern. Returns `null` for an empty pattern.
 */
export function locateStep(gridStep: number, timing: StepTiming): StepLocation | null {
  const { onsets, totalGridSteps } = timing
  if (onsets.length === 0 || totalGridSteps <= 0) return null
  const g = Math.max(0, Math.floor(gridStep))
  const loop = Math.floor(g / totalGridSteps)
  const within = g - loop * totalGridSteps

  // Largest onset <= within.
  let stepIndex = 0
  for (let i = 0; i < onsets.length; i += 1) {
    if (onsets[i]! <= within) stepIndex = i
    else break
  }
  return { loop, stepIndex, isOnset: onsets[stepIndex] === within }
}

/** Clamp a value into an inclusive integer range. */
export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * The base fret to use for a given loop of the classic +1-fret-per-loop
 * practice flow. With no range (auto-advance off) the position never moves;
 * with a range it advances one fret per loop, wrapping back to `min` after
 * `max`. `start` is clamped into the range first.
 */
export function positionForLoop(
  loop: number,
  start: number,
  range?: { min: number; max: number },
): number {
  if (!range) return start
  const { min, max } = range
  if (max <= min) return min
  const span = max - min + 1
  const base = clampInt(start, min, max)
  const offset = ((Math.floor(loop) % span) + span) % span
  return min + ((base - min + offset) % span)
}

/**
 * Playback direction applied to an already-`expandPattern`ed step sequence,
 * independent of the pattern's own `traversal`. `forward` plays the steps as
 * expanded; `reverse` plays them back-to-front; `forward-reverse` plays the
 * whole sequence forward then immediately backward. This is orthogonal to a
 * pattern's own up/down traversal — it works uniformly on top of whatever
 * `expandPattern` produces for any pattern.
 */
export type Direction = 'forward' | 'reverse' | 'forward-reverse'

export const DIRECTIONS: readonly Direction[] = ['forward', 'reverse', 'forward-reverse']

export const DEFAULT_DIRECTION: Direction = 'forward'

/**
 * Apply a playback `Direction` to an expanded step sequence. `forward` is the
 * sequence unchanged; `reverse` is the sequence reversed; `forward-reverse`
 * concatenates the sequence with its own reverse *without* repeating the
 * turnaround (last) step twice in a row — e.g. `[A,B,C,D]` becomes
 * `[A,B,C,D,C,B,A]`, not `[A,B,C,D,D,C,B,A]`.
 */
export function applyDirection(steps: readonly ExerciseStep[], direction: Direction): ExerciseStep[] {
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

// --- Built-in patterns ------------------------------------------------------

/** Spider walk 1-2-3-4, up then down across every string — the staple warm-up. */
export const SPIDER_1234_UPDOWN: ExercisePattern = {
  id: 'spider-1234-updown',
  name: 'Spider Walk 1-2-3-4 (up & down)',
  description:
    'One finger per fret, 1-2-3-4 ascending across every string then 4-3-2-1 back down. Builds finger independence and left-hand economy.',
  motif: spiderMotif([1, 2, 3, 4]),
  traversal: 'ascending-descending',
  category: 'spider',
}

/**
 * A genuinely continuous chromatic run: the absolute pitch climbs by exactly
 * one semitone per note, carrying the cursor across string boundaries instead
 * of repeating the same 4-fret box on every string (which would just be
 * `SPIDER_1234_UPDOWN` again — a duplicate exercise). See `continuous` below.
 */
export const CHROMATIC_POSITION_SHIFT: ExercisePattern = {
  id: 'chromatic-4nps',
  name: 'Continuous Chromatic Run',
  description:
    'One unbroken chromatic scale across the whole neck: the position shifts by a fret (or more) at every string crossing so pitches never repeat or skip — unlike a same-box run, this covers new ground on every string.',
  motif: spiderMotif([1, 2, 3, 4]),
  traversal: 'ascending',
  category: 'shift',
  continuous: true,
}

/**
 * Non-sequential spider-walk permutations. A curated set (not all 24 — the
 * full permutation generator is a separate later roadmap item), chosen for
 * jumps that break the straight ascending/descending habit and force the
 * fretting hand to plan ahead independently of finger order.
 */
export const SPIDER_1324_UPDOWN: ExercisePattern = {
  id: 'spider-1324-updown',
  name: 'Spider Walk 1-3-2-4 (up & down)',
  description:
    'Index-ring-middle-pinky order across the strings and back. The 3-then-2 jump trains the middle finger to release and re-plant out of sequence.',
  motif: spiderMotif([1, 3, 2, 4]),
  traversal: 'ascending-descending',
  category: 'spider',
}

export const SPIDER_2413_UPDOWN: ExercisePattern = {
  id: 'spider-2413-updown',
  name: 'Spider Walk 2-4-1-3 (up & down)',
  description:
    'Starts on the middle finger and leaps to the pinky before returning to index-ring. Builds independence for the fingers that usually lead (1) or trail (4).',
  motif: spiderMotif([2, 4, 1, 3]),
  traversal: 'ascending-descending',
  category: 'spider',
}

export const SPIDER_4231_UPDOWN: ExercisePattern = {
  id: 'spider-4231-updown',
  name: 'Spider Walk 4-2-3-1 (up & down)',
  description:
    'Pinky-first, index-last ordering with the middle pair reversed in between. A demanding pattern for pinky control and finger-to-finger accuracy.',
  motif: spiderMotif([4, 2, 3, 1]),
  traversal: 'ascending-descending',
  category: 'spider',
}

export const SPIDER_3142_UPDOWN: ExercisePattern = {
  id: 'spider-3142-updown',
  name: 'Spider Walk 3-1-4-2 (up & down)',
  description:
    'Ring-index-pinky-middle order across the strings and back. Every consecutive pair skips a finger, drilling non-adjacent finger transitions.',
  motif: spiderMotif([3, 1, 4, 2]),
  traversal: 'ascending-descending',
  category: 'spider',
}

/**
 * String-crossing drills. These move the motif itself across strings (via
 * `stringOffset`) rather than relying only on the traversal's per-string
 * repetition, so each pass plants notes on more than one string at once —
 * the hallmark of a crossing exercise.
 */

/** Alternating adjacent strings, two notes (fingers 1-2) per string. */
export const STRING_CROSSING_12: ExercisePattern = {
  id: 'string-crossing-12',
  name: 'String Crossing: 1-2 Walk',
  description:
    'Fingers 1-2 on one string, then 1-2 on the next, up then down every string. Trains clean, controlled string changes for the plucking/picking hand.',
  motif: [
    { fret: 0, finger: 1 },
    { fret: 1, finger: 2 },
  ],
  traversal: 'ascending-descending',
  category: 'crossing',
}

/** Skip-a-string dyads (root paired with a note two strings up) — a sixths-style crossing drill. */
export const SIXTHS_SKIP_STRING: ExercisePattern = {
  id: 'sixths-skip-string',
  name: 'Skip-String Sixths',
  description:
    'A root (finger 1) paired with a note two strings up (finger 4), skipping the string in between — the classic sixths-style skip-string crossing.',
  motif: [
    { fret: 0, finger: 1 },
    { fret: 2, finger: 4, stringOffset: 2 },
  ],
  traversal: 'ascending',
  category: 'crossing',
}

/** Diagonal raking arpeggio shape using stringOffset to cross four strings per pass. */
export const RAKE_ARPEGGIO: ExercisePattern = {
  id: 'rake-arpeggio',
  name: 'Raking Arpeggio Crossing',
  description:
    'A four-note diagonal shape, one fret and one string higher with each note, fingers 1-2-3-4. Trains raking smoothly across strings instead of picking each one separately.',
  motif: [
    { fret: 0, finger: 1 },
    { fret: 1, finger: 2, stringOffset: 1 },
    { fret: 2, finger: 3, stringOffset: 2 },
    { fret: 3, finger: 4, stringOffset: 3 },
  ],
  traversal: 'ascending',
  category: 'crossing',
}

/**
 * Position-shift drills. Motifs whose fret offsets go beyond the plain
 * 4-fret box (0..3) to make the hand shift mid-pattern, expressed with the
 * existing `PatternCell.fret` field — no format changes needed, since `fret`
 * is already an arbitrary offset from the position rather than a 0..3 index.
 */

/** 1-2-3-4 in position, then the hand shifts up one fret and repeats 1-2-3-4. */
export const POSITION_SHIFT_1234: ExercisePattern = {
  id: 'position-shift-1234',
  name: 'Position Shift 1-2-3-4',
  description:
    '1-2-3-4 in position, then the hand shifts up one fret and repeats 1-2-3-4 on the same string before moving on. Trains smooth mid-phrase position shifts.',
  motif: [
    { fret: 0, finger: 1 },
    { fret: 1, finger: 2 },
    { fret: 2, finger: 3 },
    { fret: 3, finger: 4 },
    { fret: 1, finger: 1 },
    { fret: 2, finger: 2 },
    { fret: 3, finger: 3 },
    { fret: 4, finger: 4 },
  ],
  traversal: 'ascending',
  category: 'shift',
}

/** Three notes per string, each string's run starting two frets higher than the last — a 3-notes-per-string shifting run. */
export const THREE_NPS_SHIFT: ExercisePattern = {
  id: '3nps-shift-run',
  name: '3-Notes-Per-String Shifting Run',
  description:
    'Three notes per string (fingers 1-3-4), each string starting two frets higher than the one before — a moving-position run like a 3nps scale shape.',
  motif: [
    { fret: 0, finger: 1 },
    { fret: 2, finger: 3 },
    { fret: 4, finger: 4 },
    { fret: 2, finger: 1, stringOffset: 1 },
    { fret: 4, finger: 3, stringOffset: 1 },
    { fret: 6, finger: 4, stringOffset: 1 },
    { fret: 4, finger: 1, stringOffset: 2 },
    { fret: 6, finger: 3, stringOffset: 2 },
    { fret: 8, finger: 4, stringOffset: 2 },
  ],
  traversal: 'ascending',
  category: 'shift',
}

/** All shipped patterns, in picker order (grouped by category). */
export const BUILTIN_PATTERNS: readonly ExercisePattern[] = [
  SPIDER_1234_UPDOWN,
  SPIDER_1324_UPDOWN,
  SPIDER_2413_UPDOWN,
  SPIDER_4231_UPDOWN,
  SPIDER_3142_UPDOWN,
  STRING_CROSSING_12,
  SIXTHS_SKIP_STRING,
  RAKE_ARPEGGIO,
  CHROMATIC_POSITION_SHIFT,
  POSITION_SHIFT_1234,
  THREE_NPS_SHIFT,
]

/** Picker group labels, in display order. */
export const PATTERN_CATEGORY_LABELS: Record<PatternCategory, string> = {
  spider: 'Spider walks',
  crossing: 'String crossing',
  shift: 'Position shifts',
}

/** Builtin patterns grouped by category, in `PATTERN_CATEGORY_LABELS` order. */
export function patternsByCategory(): { category: PatternCategory; label: string; patterns: ExercisePattern[] }[] {
  return (Object.keys(PATTERN_CATEGORY_LABELS) as PatternCategory[]).map((category) => ({
    category,
    label: PATTERN_CATEGORY_LABELS[category],
    patterns: BUILTIN_PATTERNS.filter((p) => p.category === category),
  }))
}

export const DEFAULT_PATTERN_ID = SPIDER_1234_UPDOWN.id

/** Look up a pattern by id, falling back to the default for unknown ids. */
export function getPattern(id: string): ExercisePattern {
  return BUILTIN_PATTERNS.find((p) => p.id === id) ?? SPIDER_1234_UPDOWN
}
