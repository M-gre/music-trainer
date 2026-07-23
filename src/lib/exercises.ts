/**
 * Exercise engine (M5) — a tuning-aware pattern format for fretted-instrument
 * dexterity drills, plus a pure generator that expands a compact pattern
 * *template* into a concrete sequence of fret/finger steps for a given tuning
 * and neck position.
 *
 * The format is intentionally small and composable so later roadmap items
 * (spider-walk variants, the 24-permutation generator, string-crossing and
 * position-shift drills) can define new patterns on top of it without touching
 * the engine:
 *
 *  - A `PatternCell` is one note of a repeating *motif*, expressed relative to
 *    the current traversal string and the position's base fret:
 *    `{ fret, finger, stringOffset?, duration? }`. Frets are relative to a
 *    position; strings are relative to the string the motif currently sits on
 *    (so a cell can cross to an adjacent string). Fingers are 1..4.
 *  - An `ExercisePattern` is `{ id, name, description, motif, traversal }`.
 *    `traversal` says how the motif repeats across the strings.
 *  - `expandPattern(pattern, { tuning, position })` turns that into absolute
 *    `ExerciseStep`s (`{ string, fret, finger, duration, midi }`), skipping any
 *    cell that would fall off the board — pure and fully unit-tested.
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
 */
export function expandPattern(pattern: ExercisePattern, opts: ExpandOptions): ExerciseStep[] {
  const { tuning, position } = opts
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

// --- Built-in patterns ------------------------------------------------------

/** Spider walk 1-2-3-4, up then down across every string — the staple warm-up. */
export const SPIDER_1234_UPDOWN: ExercisePattern = {
  id: 'spider-1234-updown',
  name: 'Spider Walk 1-2-3-4 (up & down)',
  description:
    'One finger per fret, 1-2-3-4 ascending across every string then 4-3-2-1 back down. Builds finger independence and left-hand economy.',
  motif: spiderMotif([1, 2, 3, 4]),
  traversal: 'ascending-descending',
}

/** Reverse spider 4-3-2-1, up and down — trains the weaker pinky-led ordering. */
export const SPIDER_4321_UPDOWN: ExercisePattern = {
  id: 'spider-4321-updown',
  name: 'Reverse Spider 4-3-2-1 (up & down)',
  description:
    'Pinky-led 4-3-2-1 across the strings and back. Strengthens the ring and pinky fingers that the plain 1-2-3-4 lets coast.',
  motif: spiderMotif([4, 3, 2, 1]),
  traversal: 'ascending-descending',
}

/** Chromatic four-notes-per-string run, ascending only. */
export const CHROMATIC_4NPS: ExercisePattern = {
  id: 'chromatic-4nps',
  name: 'Chromatic 4-Notes-Per-String',
  description:
    'A straight chromatic run — four notes per string, low string to high, one finger per fret. A clean picking / fretting-hand sync drill.',
  motif: spiderMotif([1, 2, 3, 4]),
  traversal: 'ascending',
}

/** All shipped patterns, in picker order. */
export const BUILTIN_PATTERNS: readonly ExercisePattern[] = [
  SPIDER_1234_UPDOWN,
  SPIDER_4321_UPDOWN,
  CHROMATIC_4NPS,
]

export const DEFAULT_PATTERN_ID = SPIDER_1234_UPDOWN.id

/** Look up a pattern by id, falling back to the default for unknown ids. */
export function getPattern(id: string): ExercisePattern {
  return BUILTIN_PATTERNS.find((p) => p.id === id) ?? SPIDER_1234_UPDOWN
}
