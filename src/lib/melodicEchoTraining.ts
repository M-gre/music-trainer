/**
 * Pure logic for the melodic-echo ear-training quiz — the fourth quiz mode
 * alongside interval, chord-quality and scale/mode recognition (see the notes
 * atop `src/pages/EarTraining.tsx` and its sibling `src/lib/*Training.ts`
 * files, which this mirrors). The app plays a short diatonic phrase and the
 * player echoes it note-by-note on the on-screen fretboard or keyboard.
 *
 * Framework-free and fully unit-testable (no `window`/`document`, all
 * randomness injected via `Rng`):
 *  - phrase generation (a diatonic phrase in a chosen key/scale, stepwise-biased
 *    with occasional thirds, starting on the tonic or fifth, kept within an
 *    octave-and-a-bit of a comfortable register),
 *  - the concrete note sequence to play for a question (quarter notes at a
 *    fixed tempo),
 *  - note-by-note answer matching + a pure "echo attempt" reducer that tracks
 *    progress, fails an attempt on a wrong note and lets the player retry the
 *    same phrase,
 *  - simple overall stats accumulation (phrases attempted / clean + best
 *    streak), and
 *  - persisted settings/stats stores, following the same shape and
 *    `settings:ear-training:*` / `stats:ear-training:*` naming as its siblings.
 */

import type { Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'
import { midiToPc, mod12, type Midi, type PitchClass } from './theory/notes.ts'
import { getScale } from './theory/scales.ts'

// --- Keys, scales & labels ----------------------------------------------------

/** The two selectable scale flavours for a melodic-echo key. */
export type EchoScaleType = 'major' | 'minor'

/** The theory scale id backing each selectable scale type. */
export function scaleIdFor(scaleType: EchoScaleType): string {
  return scaleType === 'major' ? 'major' : 'minor'
}

/** Selectable roots as pitch classes, C..B in chromatic order. */
export const ALL_ROOT_PCS: readonly PitchClass[] = Array.from({ length: 12 }, (_, i) => i)

// --- Register & range ---------------------------------------------------------

/**
 * Comfortable tonic register: the tonic pitch class is placed in the octave
 * starting at C4 (midi 60), i.e. tonic in `60..71`. The phrase spans scale
 * degrees `DEGREE_MIN..DEGREE_MAX` above the tonic — an octave-and-a-bit (a
 * ninth) — so the highest note ever played sits comfortably in a mid register
 * for the default synth voice.
 */
export const TONIC_OCTAVE_BASE: Midi = 60

/** Lowest scale degree (0 = tonic) a phrase note may use. */
export const DEGREE_MIN = 0
/** Highest scale degree a phrase note may use (8 = the ninth above the tonic). */
export const DEGREE_MAX = 8

/** Phrase-length bounds and default. */
export const MIN_LENGTH = 2
export const MAX_LENGTH = 6
export const DEFAULT_LENGTH = 3

/** Probability that a melodic move is a third (two scale steps) rather than a
 * step; the remaining weight goes to stepwise motion. */
export const THIRD_PROBABILITY = 0.25

/** The midi pitch of the tonic in its comfortable register for a root pc. */
export function tonicMidi(rootPc: PitchClass): Midi {
  return TONIC_OCTAVE_BASE + mod12(rootPc)
}

/**
 * The concrete midi pitch for a diatonic scale `degree` (0 = tonic) above the
 * tonic of `rootPc` in the given scale. Degrees beyond the scale length wrap
 * into the next octave, so e.g. degree 7 is the octave and degree 8 the ninth.
 */
export function degreeToMidi(rootPc: PitchClass, scaleType: EchoScaleType, degree: number): Midi {
  const scale = getScale(scaleIdFor(scaleType))
  const size = scale.intervals.length
  const octave = Math.floor(degree / size)
  const step = ((degree % size) + size) % size
  return tonicMidi(rootPc) + octave * 12 + scale.intervals[step]!
}

// --- Question model -----------------------------------------------------------

export interface MelodicEchoQuestion {
  rootPc: PitchClass
  scaleType: EchoScaleType
  /** The scale degrees (0 = tonic) making up the phrase, in order. */
  degrees: number[]
  /** The concrete phrase pitches (midi), in order — derived from `degrees`. */
  midis: Midi[]
}

/** Inputs the generator reads; supplied live by the page each question. */
export interface MelodicEchoContext {
  /** Phrase length in notes (clamped to `MIN_LENGTH..MAX_LENGTH`). */
  length: number
  rootPc: PitchClass
  scaleType: EchoScaleType
}

/**
 * Generate the sequence of scale degrees for a phrase. The first note starts
 * on the tonic (degree 0) or the fifth (degree 4); each subsequent note moves
 * by a step (one scale degree) most of the time, or by a third (two degrees)
 * with probability `THIRD_PROBABILITY`, in a random direction that is flipped
 * (then clamped) whenever it would leave `DEGREE_MIN..DEGREE_MAX`. Pure given
 * `rng`.
 */
export function generatePhraseDegrees(length: number, rng: Rng): number[] {
  const n = clampLength(length)
  const degrees: number[] = [rng() < 0.5 ? 0 : 4]
  for (let i = 1; i < n; i += 1) {
    const prev = degrees[i - 1]!
    const magnitude = rng() < THIRD_PROBABILITY ? 2 : 1
    let direction = rng() < 0.5 ? 1 : -1
    let next = prev + direction * magnitude
    if (next < DEGREE_MIN || next > DEGREE_MAX) {
      direction = -direction
      next = prev + direction * magnitude
    }
    next = Math.max(DEGREE_MIN, Math.min(DEGREE_MAX, next))
    degrees.push(next)
  }
  return degrees
}

/**
 * Generate the next melodic-echo question. The key/scale come from `ctx`; the
 * phrase degrees are generated fresh (avoiding an exact repeat of the previous
 * phrase's degree sequence when possible). Pure given `rng`.
 */
export function generateMelodicEchoQuestion(
  ctx: MelodicEchoContext,
  previous: MelodicEchoQuestion | null,
  rng: Rng,
): MelodicEchoQuestion {
  const rootPc = mod12(ctx.rootPc)
  const scaleType: EchoScaleType = ctx.scaleType === 'minor' ? 'minor' : 'major'
  const previousKey = previous ? previous.degrees.join(',') : null

  // Try a few fresh phrases so we don't hand back an identical degree sequence
  // twice in a row; fall back to whatever we last produced if we run out.
  let degrees = generatePhraseDegrees(ctx.length, rng)
  for (let attempt = 0; attempt < 8 && degrees.join(',') === previousKey; attempt += 1) {
    degrees = generatePhraseDegrees(ctx.length, rng)
  }

  const midis = degrees.map((d) => degreeToMidi(rootPc, scaleType, d))
  return { rootPc, scaleType, degrees, midis }
}

// --- Playback -----------------------------------------------------------------

/** A single scheduled note: which pitch, and its start offset in seconds. */
export interface EchoStep {
  midi: Midi
  when: number
}

/**
 * Quarter notes at ~90 BPM: 60 / 90 = 0.667s per note — brisk enough to hear
 * the phrase as a melody, slow enough to sing back.
 */
export const DEFAULT_STEP_SECONDS = 60 / 90

/** Timed sequence for a question's phrase, each note spaced by `stepSeconds`. */
export function questionPhraseSteps(
  question: MelodicEchoQuestion,
  stepSeconds: number = DEFAULT_STEP_SECONDS,
  startTime = 0,
): EchoStep[] {
  return question.midis.map((midi, i) => ({ midi, when: startTime + i * stepSeconds }))
}

// --- Note-by-note echo matching ----------------------------------------------

/**
 * How a played note is compared to the expected one: `'exact'` (keyboard —
 * pitch must match octave and all) or `'pitch-class'` (fretboard — any octave
 * of the right pitch class is accepted, since the same note lives at many
 * positions).
 */
export type MatchMode = 'exact' | 'pitch-class'

/** Does `played` satisfy `expected` under the given match mode? */
export function noteMatches(expected: Midi, played: Midi, mode: MatchMode): boolean {
  return mode === 'exact' ? played === expected : midiToPc(played) === midiToPc(expected)
}

/** Progress within a single echo attempt of one phrase. */
export interface EchoState {
  /** How many leading notes have been echoed correctly this run (0..total). */
  matched: number
  /** Wrong notes played on this phrase so far (any ⇒ the phrase isn't clean). */
  mistakes: number
}

export function initialEchoState(): EchoState {
  return { matched: 0, mistakes: 0 }
}

/** The outcome of submitting one played note against the current phrase. */
export interface EchoResult {
  /** The next state after folding in this note. */
  state: EchoState
  /**
   * `'correct'` — matched the next expected note; `'complete'` — matched the
   * final note (phrase done); `'wrong'` — mismatch (attempt resets to the
   * start of the phrase and a mistake is recorded).
   */
  result: 'correct' | 'complete' | 'wrong'
  /** The note that was expected at the current position. */
  expected: Midi
  /** True on the note that completes the phrase. */
  complete: boolean
  /** True when the phrase completed with zero mistakes across the whole attempt. */
  clean: boolean
}

/** Notes in a question's phrase. */
export function phraseLength(question: MelodicEchoQuestion): number {
  return question.midis.length
}

/**
 * Fold one played note into an echo attempt. A correct note advances the
 * `matched` cursor; the note that matches the last position completes the
 * phrase. A wrong note records a mistake and resets `matched` to 0 so the
 * player retries the phrase from the top (the retry counts against a clean
 * finish but never blocks completion). Submitting after completion is a no-op.
 * Pure — never mutates `state`.
 */
export function submitEchoNote(
  question: MelodicEchoQuestion,
  state: EchoState,
  played: Midi,
  mode: MatchMode,
): EchoResult {
  const total = phraseLength(question)
  // Already complete: ignore further input.
  if (state.matched >= total) {
    return { state, result: 'complete', expected: question.midis[total - 1]!, complete: true, clean: state.mistakes === 0 }
  }

  const expected = question.midis[state.matched]!
  if (noteMatches(expected, played, mode)) {
    const matched = state.matched + 1
    const complete = matched >= total
    return {
      state: { matched, mistakes: state.mistakes },
      result: complete ? 'complete' : 'correct',
      expected,
      complete,
      clean: complete && state.mistakes === 0,
    }
  }

  return {
    state: { matched: 0, mistakes: state.mistakes + 1 },
    result: 'wrong',
    expected,
    complete: false,
    clean: false,
  }
}

// --- Stats --------------------------------------------------------------------

/** Overall melodic-echo tallies: phrases attempted, clean finishes, best streak. */
export interface MelodicEchoStats {
  attempts: number
  clean: number
  bestStreak: number
}

export const EMPTY_MELODIC_ECHO_STATS: MelodicEchoStats = { attempts: 0, clean: 0, bestStreak: 0 }

/** Accuracy (clean / attempts) in `[0, 1]`, or `null` with no attempts. */
export function accuracy(stats: MelodicEchoStats): number | null {
  if (stats.attempts === 0) return null
  return stats.clean / stats.attempts
}

/**
 * Return a new `MelodicEchoStats` with one completed phrase folded in: one
 * attempt, one clean finish if `clean`, and `bestStreak` raised to `streak` if
 * it is higher. Never mutates its input.
 */
export function accumulateStat(
  stats: MelodicEchoStats,
  clean: boolean,
  streak: number,
): MelodicEchoStats {
  return {
    attempts: stats.attempts + 1,
    clean: stats.clean + (clean ? 1 : 0),
    bestStreak: Math.max(stats.bestStreak, streak),
  }
}

/** Coerce arbitrary persisted data into valid `MelodicEchoStats`. */
export function normalizeMelodicEchoStats(value: unknown): MelodicEchoStats {
  if (typeof value !== 'object' || value === null) return { ...EMPTY_MELODIC_ECHO_STATS }
  const r = value as Record<string, unknown>
  const attempts = intOrZero(r.attempts)
  const clean = Math.min(attempts, intOrZero(r.clean))
  const bestStreak = intOrZero(r.bestStreak)
  return { attempts, clean, bestStreak }
}

function intOrZero(value: unknown): number {
  return typeof value === 'number' && value >= 0 && Number.isFinite(value) ? Math.floor(value) : 0
}

// --- Settings -----------------------------------------------------------------

/** Which on-screen instrument the phrase is echoed on. */
export type EchoInputMode = 'fretboard' | 'keyboard'

export const INPUT_MODE_OPTIONS: readonly EchoInputMode[] = ['fretboard', 'keyboard']

export interface MelodicEchoSettings {
  /** Phrase length in notes (`MIN_LENGTH..MAX_LENGTH`). */
  length: number
  rootPc: PitchClass
  scaleType: EchoScaleType
  inputMode: EchoInputMode
}

export const DEFAULT_MELODIC_ECHO_SETTINGS: MelodicEchoSettings = {
  length: DEFAULT_LENGTH,
  rootPc: 0,
  scaleType: 'major',
  inputMode: 'fretboard',
}

/** Clamp a phrase length to the allowed range, defaulting invalid input. */
export function clampLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LENGTH
  return Math.max(MIN_LENGTH, Math.min(MAX_LENGTH, Math.floor(value)))
}

/** Coerce arbitrary data into valid `MelodicEchoSettings`. */
export function normalizeMelodicEchoSettings(value: unknown): MelodicEchoSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof MelodicEchoSettings, unknown>
  >
  const rootPc = typeof v.rootPc === 'number' && Number.isFinite(v.rootPc) ? mod12(Math.floor(v.rootPc)) : 0
  const scaleType: EchoScaleType = v.scaleType === 'minor' ? 'minor' : 'major'
  const inputMode: EchoInputMode = v.inputMode === 'keyboard' ? 'keyboard' : 'fretboard'
  return { length: clampLength(v.length), rootPc, scaleType, inputMode }
}

/** Build a melodic-echo settings store (tests pass `memoryBackend()`). */
export function createMelodicEchoSettingsStore(
  backend?: StorageBackend,
): Store<MelodicEchoSettings> {
  return new Store<MelodicEchoSettings>(
    {
      key: 'settings:ear-training:melodic-echo',
      version: 1,
      defaultValue: DEFAULT_MELODIC_ECHO_SETTINGS,
    },
    backend,
  )
}

/** Build a lifetime melodic-echo stats store (tests pass `memoryBackend()`). */
export function createMelodicEchoStatsStore(backend?: StorageBackend): Store<MelodicEchoStats> {
  return new Store<MelodicEchoStats>(
    {
      key: 'stats:ear-training:melodic-echo',
      version: 1,
      defaultValue: EMPTY_MELODIC_ECHO_STATS,
    },
    backend,
  )
}

/** App-wide localStorage-backed stores. */
export const melodicEchoSettingsStore = createMelodicEchoSettingsStore()
export const melodicEchoStatsStore = createMelodicEchoStatsStore()
