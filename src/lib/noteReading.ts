/**
 * Pure logic and persistence for the Note Reading tool: per-clef pitch ranges
 * (with selectable presets and a custom min/max), drawing a random target
 * note, checking answers from each of the three input modes, a pure
 * countdown for Timed mode, and a versioned settings store (mirrors
 * `settings.ts` / `metronomeSettings.ts`). Kept free of React and the DOM so
 * it is unit-tested in the node environment; the page component stays thin.
 *
 * Question generation and answer checking are wired into the shared
 * `QuizSession` (`src/lib/quiz.ts`) by the page: `generateNoteReadingQuestion`
 * matches `QuizSession`'s `generate(previous, rng)` shape and
 * `checkNoteReadingAnswer` (with a small context) matches `check(question,
 * answer)`. That single session also carries score/streak/best-streak for
 * both Practice and Timed mode — only the countdown clock is tool-specific
 * and lives here, pure and separately tested.
 */

import { Store, type StorageBackend } from './storage.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { midiToName, midiToPc, nameToMidi } from './theory/notes.ts'
import type { Rng } from './quiz.ts'
import type { Clef } from '../components/staffGeometry.ts'

export type InputMode = 'name' | 'fretboard' | 'keyboard'

/** Clef *setting*: a fixed clef, or `'both'` to draw a random clef per question. */
export type ClefSetting = Clef | 'both'

export const CLEF_OPTIONS: readonly Clef[] = ['bass', 'treble']
export const CLEF_SETTING_OPTIONS: readonly ClefSetting[] = ['bass', 'treble', 'both']
export const INPUT_MODE_OPTIONS: readonly InputMode[] = ['name', 'fretboard', 'keyboard']

export type RangePreset = 'staff' | 'ledger' | 'custom'
export const RANGE_PRESET_OPTIONS: readonly RangePreset[] = ['staff', 'ledger', 'custom']

/** A pitch range, inclusive at both ends. */
export interface PitchRange {
  low: number
  high: number
}

/**
 * "Staff only": the note sits somewhere between the bottom and top staff
 * lines, no ledger lines needed. Treble bottom/top lines are E4/F5, bass
 * G2/A3.
 */
export const CLEF_STAFF_RANGE: Record<Clef, PitchRange> = {
  bass: { low: nameToMidi('G2'), high: nameToMidi('A3') },
  treble: { low: nameToMidi('E4'), high: nameToMidi('F5') },
}

/**
 * "Staff + ledger" (the original, and still the default): the staff plus a
 * couple of ledger lines each side — bass C2…C4, treble A3…C6.
 */
export const CLEF_RANGE: Record<Clef, PitchRange> = {
  bass: { low: 36, high: 60 },
  treble: { low: 57, high: 84 },
}

/** Ranges for the two non-custom presets, keyed by preset then clef. */
export const RANGE_PRESETS: Record<Exclude<RangePreset, 'custom'>, Record<Clef, PitchRange>> = {
  staff: CLEF_STAFF_RANGE,
  ledger: CLEF_RANGE,
}

/** Absolute bounds offered by the custom-range note pickers (C1…C7). */
export const CUSTOM_RANGE_MIN = nameToMidi('C1')
export const CUSTOM_RANGE_MAX = nameToMidi('C7')

/** Every selectable midi pitch for the custom-range note pickers, low to high. */
export const RANGE_NOTE_OPTIONS: { midi: number; label: string }[] = Array.from(
  { length: CUSTOM_RANGE_MAX - CUSTOM_RANGE_MIN + 1 },
  (_, i) => {
    const midi = CUSTOM_RANGE_MIN + i
    return { midi, label: midiToName(midi, 'sharp') }
  },
)

export type CustomRange = Record<Clef, PitchRange>

/** Starting point for a freshly-selected "custom" preset: today's default range. */
export const DEFAULT_CUSTOM_RANGE: CustomRange = {
  bass: { ...CLEF_RANGE.bass },
  treble: { ...CLEF_RANGE.treble },
}

/** The active pitch range for a clef under the given preset/custom settings. */
export function resolveRange(clef: Clef, preset: RangePreset, custom: CustomRange): PitchRange {
  if (preset === 'custom') return custom[clef]
  return RANGE_PRESETS[preset][clef]
}

/** Resolve a clef *setting* to the concrete clef for one question. */
export function resolveQuestionClef(setting: ClefSetting, rng: Rng = Math.random): Clef {
  if (setting !== 'both') return setting
  return rng() < 0.5 ? 'bass' : 'treble'
}

/**
 * Pick a random midi pitch within `range`. `rng` defaults to `Math.random`;
 * tests inject a deterministic generator. `avoid` re-rolls so the same note
 * is not drawn twice in a row (best-effort, bounded).
 */
export function randomNote(range: PitchRange, rng: () => number = Math.random, avoid?: number): number {
  const { low, high } = range
  const span = high - low + 1
  let pick = low + Math.floor(rng() * span)
  if (pick > high) pick = high
  for (let tries = 0; pick === avoid && tries < 8; tries++) {
    pick = low + Math.floor(rng() * span)
    if (pick > high) pick = high
  }
  return pick
}

/** True when clicking a name (by pitch class) matches the target's pitch class. */
export function checkNameAnswer(chosenPc: number, targetMidi: number): boolean {
  return midiToPc(chosenPc) === midiToPc(targetMidi)
}

/** True when a clicked keyboard key is the exact target pitch. */
export function checkKeyboardAnswer(clickedMidi: number, targetMidi: number): boolean {
  return clickedMidi === targetMidi
}

/**
 * Whether the exact target pitch can be played anywhere on the board within the
 * given fret range for the tuning.
 */
export function pitchOnBoard(
  tuning: Tuning,
  targetMidi: number,
  fromFret: number,
  toFret: number,
): boolean {
  for (let s = 0; s < tuning.strings.length; s++) {
    for (let f = fromFret; f <= toFret; f++) {
      if (fretMidi(tuning, s, f) === targetMidi) return true
    }
  }
  return false
}

/**
 * Grade a fretboard click for staff reading.
 *
 * Design choice: prefer an *exact-pitch* match, but only require it when the
 * target's exact octave is actually reachable on the board. When the drawn
 * note lies outside the board's range (common for high treble notes on a
 * 4-string bass, or notes below the lowest string), demanding the exact octave
 * would be impossible/punishing, so any position of the correct pitch class is
 * accepted. This keeps the drill fair across every tuning without dumbing it
 * down where the exact note is genuinely playable.
 */
export function checkFretboardAnswer(
  tuning: Tuning,
  clickedMidi: number,
  targetMidi: number,
  fromFret: number,
  toFret: number,
): boolean {
  if (clickedMidi === targetMidi) return true
  if (pitchOnBoard(tuning, targetMidi, fromFret, toFret)) return false
  return midiToPc(clickedMidi) === midiToPc(targetMidi)
}

// --- QuizSession wiring -----------------------------------------------------

/** A single Note Reading question: a target pitch drawn on a resolved clef. */
export interface NoteReadingQuestion {
  midi: number
  clef: Clef
}

/** A player's answer, tagged by which input widget produced it. */
export type NoteReadingAnswer =
  | { kind: 'name'; pc: number }
  | { kind: 'keyboard'; midi: number }
  | { kind: 'fretboard'; midi: number }

/** Extra context `checkNoteReadingAnswer` needs beyond the question/answer. */
export interface AnswerContext {
  tuning: Tuning
  fromFret: number
  toFret: number
}

/** Grade any of the three answer kinds against a question. */
export function checkNoteReadingAnswer(
  question: NoteReadingQuestion,
  answer: NoteReadingAnswer,
  ctx: AnswerContext,
): boolean {
  switch (answer.kind) {
    case 'name':
      return checkNameAnswer(answer.pc, question.midi)
    case 'keyboard':
      return checkKeyboardAnswer(answer.midi, question.midi)
    case 'fretboard':
      return checkFretboardAnswer(ctx.tuning, answer.midi, question.midi, ctx.fromFret, ctx.toFret)
  }
}

/** Inputs that constrain which questions can be generated. */
export interface GenerateContext {
  clefSetting: ClefSetting
  rangePreset: RangePreset
  customRange: CustomRange
}

/**
 * Generate the next question: resolve a concrete clef (random when the
 * setting is `'both'`), resolve its active range, and draw a note — avoiding
 * an immediate repeat only when the previous question shared the same clef
 * (a range change on clef flip makes "avoid" meaningless across clefs).
 * Matches `QuizSession`'s `generate(previous, rng)` shape.
 */
export function generateNoteReadingQuestion(
  ctx: GenerateContext,
  previous: NoteReadingQuestion | null,
  rng: Rng,
): NoteReadingQuestion {
  const clef = resolveQuestionClef(ctx.clefSetting, rng)
  const range = resolveRange(clef, ctx.rangePreset, ctx.customRange)
  const avoid = previous && previous.clef === clef ? previous.midi : undefined
  const midi = randomNote(range, rng, avoid)
  return { midi, clef }
}

// --- Timed mode: a pure countdown -------------------------------------------

export const TIMED_DURATIONS = [30, 60, 120] as const
export type TimedDurationSec = (typeof TIMED_DURATIONS)[number]

/** A running countdown: when it started and how long it lasts, in ms. */
export interface Countdown {
  startedAt: number
  durationMs: number
}

/** Start a countdown of `durationSec` seconds at clock reading `now`. */
export function startCountdown(now: number, durationSec: TimedDurationSec): Countdown {
  return { startedAt: now, durationMs: durationSec * 1000 }
}

/** Milliseconds left at clock reading `now`, floored at 0. */
export function remainingMs(countdown: Countdown, now: number): number {
  return Math.max(0, countdown.durationMs - (now - countdown.startedAt))
}

/** Whole seconds left, rounded up so the display never shows 0 while time remains. */
export function remainingSeconds(countdown: Countdown, now: number): number {
  return Math.ceil(remainingMs(countdown, now) / 1000)
}

/** True once the countdown has fully elapsed at clock reading `now`. */
export function isCountdownOver(countdown: Countdown, now: number): boolean {
  return remainingMs(countdown, now) <= 0
}

/** Final numbers for the Timed mode results screen, derived from `QuizStats`. */
export interface TimedResults {
  correct: number
  answered: number
  /** 0…1, or 0 if nothing was answered. */
  accuracy: number
  bestStreak: number
}

/** Minimal shape of `QuizStats` this module depends on (avoids a hard import cycle risk). */
export interface ScoreLike {
  correct: number
  answered: number
  bestStreak: number
}

export function summarizeTimedResults(stats: ScoreLike): TimedResults {
  return {
    correct: stats.correct,
    answered: stats.answered,
    accuracy: stats.answered === 0 ? 0 : stats.correct / stats.answered,
    bestStreak: stats.bestStreak,
  }
}

/** Clamp+order helper for editing one end of a custom range via a note picker. */
export function updateCustomRange(range: PitchRange, field: 'low' | 'high', midi: number): PitchRange {
  const clamped = Math.min(CUSTOM_RANGE_MAX, Math.max(CUSTOM_RANGE_MIN, Math.round(midi)))
  if (field === 'low') return { low: clamped, high: Math.max(clamped, range.high) }
  return { low: Math.min(range.low, clamped), high: clamped }
}

// --- Settings ---------------------------------------------------------------

export type NoteReadingMode = 'practice' | 'timed'

export interface NoteReadingSettings {
  clef: ClefSetting
  inputMode: InputMode
  rangePreset: RangePreset
  customRange: CustomRange
  mode: NoteReadingMode
  timedSeconds: TimedDurationSec
}

/** Bass clef first: the primary user is a bassist. */
export const DEFAULT_NOTE_READING_SETTINGS: NoteReadingSettings = {
  clef: 'bass',
  inputMode: 'name',
  rangePreset: 'ledger',
  customRange: DEFAULT_CUSTOM_RANGE,
  mode: 'practice',
  timedSeconds: 60,
}

function isClefSetting(value: unknown): value is ClefSetting {
  return value === 'bass' || value === 'treble' || value === 'both'
}

function isInputMode(value: unknown): value is InputMode {
  return value === 'name' || value === 'fretboard' || value === 'keyboard'
}

function isRangePreset(value: unknown): value is RangePreset {
  return value === 'staff' || value === 'ledger' || value === 'custom'
}

function isNoteReadingMode(value: unknown): value is NoteReadingMode {
  return value === 'practice' || value === 'timed'
}

function isTimedDuration(value: unknown): value is TimedDurationSec {
  return value === 30 || value === 60 || value === 120
}

function clampCustomBound(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(CUSTOM_RANGE_MAX, Math.max(CUSTOM_RANGE_MIN, Math.round(value)))
}

function normalizeClefRange(value: unknown, fallback: PitchRange): PitchRange {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof PitchRange, unknown>
  >
  const low = clampCustomBound(v.low, fallback.low)
  const high = Math.max(low, clampCustomBound(v.high, fallback.high))
  return { low, high }
}

function normalizeCustomRange(value: unknown): CustomRange {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<Record<Clef, unknown>>
  return {
    bass: normalizeClefRange(v.bass, DEFAULT_CUSTOM_RANGE.bass),
    treble: normalizeClefRange(v.treble, DEFAULT_CUSTOM_RANGE.treble),
  }
}

/** Coerce arbitrary persisted/typed data into valid settings, per field. */
export function normalizeNoteReadingSettings(value: unknown): NoteReadingSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof NoteReadingSettings, unknown>
  >
  return {
    clef: isClefSetting(v.clef) ? v.clef : DEFAULT_NOTE_READING_SETTINGS.clef,
    inputMode: isInputMode(v.inputMode) ? v.inputMode : DEFAULT_NOTE_READING_SETTINGS.inputMode,
    rangePreset: isRangePreset(v.rangePreset) ? v.rangePreset : DEFAULT_NOTE_READING_SETTINGS.rangePreset,
    customRange: normalizeCustomRange(v.customRange),
    mode: isNoteReadingMode(v.mode) ? v.mode : DEFAULT_NOTE_READING_SETTINGS.mode,
    timedSeconds: isTimedDuration(v.timedSeconds)
      ? v.timedSeconds
      : DEFAULT_NOTE_READING_SETTINGS.timedSeconds,
  }
}

/**
 * Build a settings store (tests pass `memoryBackend()`).
 *
 * v1 → v2: added range presets/custom range and the practice/timed mode
 * fields. `normalizeNoteReadingSettings` already fills in defaults for
 * anything absent from older data (and `ClefSetting` is a superset of the
 * old bass/treble-only `Clef`), so migrating is just re-running it.
 */
export function createNoteReadingSettingsStore(
  backend?: StorageBackend,
): Store<NoteReadingSettings> {
  return new Store<NoteReadingSettings>(
    {
      key: 'settings:note-reading',
      version: 2,
      defaultValue: DEFAULT_NOTE_READING_SETTINGS,
      migrate: (oldData) => normalizeNoteReadingSettings(oldData),
    },
    backend,
  )
}

/** The app-wide note-reading settings store (localStorage-backed). */
export const noteReadingSettingsStore = createNoteReadingSettingsStore()
