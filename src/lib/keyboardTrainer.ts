/**
 * Domain logic for the Keyboard Note Trainer: pure question generation,
 * answer checking, and persisted settings. Mirrors `fretboardTrainer.ts` —
 * everything here is framework-free and unit-tested; the React page
 * (`src/pages/KeyboardNoteTrainer.tsx`) is a thin shell over it plus the
 * shared `QuizSession` in `src/lib/quiz.ts`.
 *
 * Two quiz modes:
 *  - `find` — the prompt names a pitch class; the player clicks any key in
 *    the visible range whose pitch class matches (enharmonics handled by
 *    pitch class, same as the fretboard trainer).
 *  - `name` — a key is highlighted; the player names its pitch class from
 *    12 note-name buttons.
 */

import { midiToPc, type PitchClass } from './theory/notes.ts'
import { pickAvoiding, type Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'

export type QuizMode = 'find' | 'name'

/** "Find the note" question: name a pitch class anywhere in the visible range. */
export interface FindQuestion {
  mode: 'find'
  pc: PitchClass
  /** Every midi key in range whose pitch class is `pc` (>= 1). */
  answerMidis: number[]
}

/** "Name the key" question: identify the pitch class of a highlighted key. */
export interface NameQuestion {
  mode: 'name'
  midi: number
  /** The correct pitch class of that key. */
  pc: PitchClass
}

export type TrainerQuestion = FindQuestion | NameQuestion

/** A player's answer: a clicked key (find) or a chosen pitch class (name). */
export type TrainerAnswer = { kind: 'key'; midi: number } | { kind: 'pc'; pc: PitchClass }

/** Inputs that constrain which questions can be generated. */
export interface QuestionContext {
  mode: QuizMode
  fromMidi: number
  toMidi: number
}

/** Grade an answer. Pure; a mismatched question/answer kind is incorrect. */
export function checkAnswer(question: TrainerQuestion, answer: TrainerAnswer): boolean {
  if (question.mode === 'find' && answer.kind === 'key') {
    return question.answerMidis.includes(answer.midi)
  }
  if (question.mode === 'name' && answer.kind === 'pc') {
    return answer.pc === question.pc
  }
  return false
}

/**
 * All questions the context can produce, in a stable order. Generation picks
 * from this list, so building it is the single source of truth for what is
 * answerable under the current settings.
 */
export function possibleQuestions(ctx: QuestionContext): TrainerQuestion[] {
  const from = Math.min(ctx.fromMidi, ctx.toMidi)
  const to = Math.max(ctx.fromMidi, ctx.toMidi)
  const midis: number[] = []
  for (let m = from; m <= to; m++) midis.push(m)

  const questions: TrainerQuestion[] = []
  if (ctx.mode === 'name') {
    for (const midi of midis) {
      questions.push({ mode: 'name', midi, pc: midiToPc(midi) })
    }
  } else {
    // Group keys by pitch class so each pc is one question that accepts any
    // of its keys in range.
    const byPc = new Map<PitchClass, number[]>()
    for (const midi of midis) {
      const pc = midiToPc(midi)
      const list = byPc.get(pc)
      if (list) list.push(midi)
      else byPc.set(pc, [midi])
    }
    for (const [pc, answerMidis] of byPc) {
      questions.push({ mode: 'find', pc, answerMidis })
    }
  }
  return questions
}

/** Identity for immediate-repeat avoidance: same target, ignoring key lists. */
function sameQuestion(a: TrainerQuestion, b: TrainerQuestion): boolean {
  if (a.mode === 'find' && b.mode === 'find') return a.pc === b.pc
  if (a.mode === 'name' && b.mode === 'name') return a.midi === b.midi
  return false
}

/**
 * Generate the next question for `ctx`, avoiding an immediate repeat of
 * `previous`. Pure given `rng`. Throws if the context has no answerable
 * question (caller must ensure a valid, non-empty range).
 */
export function generateQuestion(
  ctx: QuestionContext,
  previous: TrainerQuestion | null,
  rng: Rng,
): TrainerQuestion {
  const candidates = possibleQuestions(ctx)
  if (candidates.length === 0) throw new Error('generateQuestion: no answerable questions')
  return pickAvoiding(candidates, previous, rng, sameQuestion)
}

// --- Settings ---------------------------------------------------------------

export interface KeyboardTrainerSettings {
  mode: QuizMode
  /** Lowest octave shown (scientific pitch notation, C4 = middle C). */
  fromOctave: number
  /** Highest octave shown. */
  toOctave: number
  /** Spelling used for note labels and answer buttons. */
  accidentals: 'sharp' | 'flat'
}

/** Octave bounds any preset/range may reach. */
export const MIN_OCTAVE = 0
export const MAX_OCTAVE = 8

/** Selectable octave-range presets. */
export const OCTAVE_RANGE_PRESETS = [
  { id: '3-4', label: 'C3–C4', fromOctave: 3, toOctave: 4 },
  { id: '3-5', label: 'C3–C5', fromOctave: 3, toOctave: 5 },
  { id: '2-6', label: 'C2–C6', fromOctave: 2, toOctave: 6 },
] as const

export const DEFAULT_KEYBOARD_TRAINER_SETTINGS: KeyboardTrainerSettings = {
  mode: 'find',
  fromOctave: 3,
  toOctave: 5,
  accidentals: 'sharp',
}

function clampOctave(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(MAX_OCTAVE, Math.max(MIN_OCTAVE, Math.round(value)))
}

/** Coerce arbitrary persisted/typed data into valid settings. */
export function normalizeTrainerSettings(value: unknown): KeyboardTrainerSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof KeyboardTrainerSettings, unknown>
  >
  const mode: QuizMode = v.mode === 'name' ? 'name' : 'find'
  const fromOctave = clampOctave(v.fromOctave, DEFAULT_KEYBOARD_TRAINER_SETTINGS.fromOctave)
  const toRaw = clampOctave(v.toOctave, DEFAULT_KEYBOARD_TRAINER_SETTINGS.toOctave)
  const toOctave = Math.max(fromOctave, toRaw)
  const accidentals: 'sharp' | 'flat' = v.accidentals === 'flat' ? 'flat' : 'sharp'
  return { mode, fromOctave, toOctave, accidentals }
}

/** Build a trainer-settings store (tests pass `memoryBackend()`). */
export function createKeyboardTrainerSettingsStore(
  backend?: StorageBackend,
): Store<KeyboardTrainerSettings> {
  return new Store<KeyboardTrainerSettings>(
    {
      key: 'settings:keyboard-trainer',
      version: 1,
      defaultValue: DEFAULT_KEYBOARD_TRAINER_SETTINGS,
    },
    backend,
  )
}

/** The app-wide trainer settings store (localStorage-backed). */
export const keyboardTrainerSettingsStore = createKeyboardTrainerSettingsStore()
