/**
 * Domain logic for the Fretboard Note Trainer: pure question generation,
 * answer checking, and persisted settings. Everything here is framework-free
 * and unit-tested; the React page (`src/pages/FretboardNoteTrainer.tsx`) is a
 * thin shell over it plus the shared `QuizSession` in `src/lib/quiz.ts`.
 *
 * Two quiz modes:
 *  - `find` — the prompt names a pitch class + a string; the player clicks a
 *    matching fret. Any fret on that string within the active range whose
 *    pitch class matches counts (so enharmonics are handled by pitch class).
 *  - `name` — a fret is highlighted; the player names its pitch class.
 */

import { midiToPc, type PitchClass } from './theory/notes.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { pickAvoiding, type Rng } from './quiz.ts'
import { pickWeightedByPc, type NoteStatsData } from './noteStats.ts'
import { Store, type StorageBackend } from './storage.ts'

export type QuizMode = 'find' | 'name' | 'findAll'

/** "Find the note" question: name a pitch class on a specific string. */
export interface FindQuestion {
  mode: 'find'
  pc: PitchClass
  string: number
  /** Every fret in range on `string` whose pitch class is `pc` (>= 1). */
  answerFrets: number[]
}

/** "Name the note" question: identify the pitch class at a highlighted fret. */
export interface NameQuestion {
  mode: 'name'
  string: number
  fret: number
  /** The correct pitch class at that position. */
  pc: PitchClass
}

/** A concrete board position (string + fret). */
export interface Position {
  string: number
  fret: number
}

/**
 * "Find all instances" question: name a pitch class; every matching position
 * across the included strings and fret range must be clicked.
 */
export interface FindAllQuestion {
  mode: 'findAll'
  pc: PitchClass
  /** Every position (string, fret) in range whose pitch class is `pc` (>= 1). */
  targets: Position[]
}

export type TrainerQuestion = FindQuestion | NameQuestion | FindAllQuestion

/** A player's answer: a clicked board position (find) or a chosen pc (name). */
export type TrainerAnswer =
  | { kind: 'position'; string: number; fret: number }
  | { kind: 'pc'; pc: PitchClass }

/** Inputs that constrain which questions can be generated. */
export interface QuestionContext {
  tuning: Tuning
  mode: QuizMode
  fromFret: number
  toFret: number
  /** Resolved, non-empty list of playable string indices. */
  includedStrings: number[]
}

/** Grade an answer. Pure; a mismatched question/answer kind is incorrect. */
export function checkAnswer(question: TrainerQuestion, answer: TrainerAnswer): boolean {
  if (question.mode === 'find' && answer.kind === 'position') {
    return answer.string === question.string && question.answerFrets.includes(answer.fret)
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
  const from = Math.min(ctx.fromFret, ctx.toFret)
  const to = Math.max(ctx.fromFret, ctx.toFret)
  const frets: number[] = []
  for (let f = from; f <= to; f++) frets.push(f)

  const questions: TrainerQuestion[] = []

  if (ctx.mode === 'findAll') {
    // One question per pitch class present anywhere in range; its targets are
    // every matching position across all included strings.
    const byPc = new Map<PitchClass, Position[]>()
    for (const string of ctx.includedStrings) {
      for (const fret of frets) {
        const pc = midiToPc(fretMidi(ctx.tuning, string, fret))
        const list = byPc.get(pc)
        if (list) list.push({ string, fret })
        else byPc.set(pc, [{ string, fret }])
      }
    }
    for (let pc = 0; pc < 12; pc++) {
      const targets = byPc.get(pc)
      if (targets && targets.length > 0) questions.push({ mode: 'findAll', pc, targets })
    }
    return questions
  }

  for (const string of ctx.includedStrings) {
    if (ctx.mode === 'name') {
      for (const fret of frets) {
        questions.push({ mode: 'name', string, fret, pc: midiToPc(fretMidi(ctx.tuning, string, fret)) })
      }
    } else {
      // Group frets by pitch class so each (string, pc) is one question that
      // accepts any of its frets.
      const byPc = new Map<PitchClass, number[]>()
      for (const fret of frets) {
        const pc = midiToPc(fretMidi(ctx.tuning, string, fret))
        const list = byPc.get(pc)
        if (list) list.push(fret)
        else byPc.set(pc, [fret])
      }
      for (const [pc, answerFrets] of byPc) {
        questions.push({ mode: 'find', pc, string, answerFrets })
      }
    }
  }
  return questions
}

/** Stable key for a board position, used by the find-all session. */
export function positionKey(string: number, fret: number): string {
  return `${string}:${fret}`
}

/** Target keys (every matching position) for a find-all question. */
export function findAllTargetKeys(question: FindAllQuestion): string[] {
  return question.targets.map((p) => positionKey(p.string, p.fret))
}

/** Identity for immediate-repeat avoidance: same target, ignoring fret lists. */
function sameQuestion(a: TrainerQuestion, b: TrainerQuestion): boolean {
  if (a.mode === 'find' && b.mode === 'find') return a.string === b.string && a.pc === b.pc
  if (a.mode === 'name' && b.mode === 'name') return a.string === b.string && a.fret === b.fret
  if (a.mode === 'findAll' && b.mode === 'findAll') return a.pc === b.pc
  return false
}

/**
 * Optional weakest-first picking: when supplied, `generateQuestion` biases
 * toward the pitch classes the player is weakest on (see `noteStats.ts`)
 * instead of drawing uniformly.
 */
export interface QuestionPicking {
  stats: NoteStatsData
  /** Wall-clock now (ms) for recency weighting. */
  now: number
}

/** Candidates with `previous` filtered out, unless that would leave nothing. */
function withoutPrevious(
  candidates: TrainerQuestion[],
  previous: TrainerQuestion | null,
): TrainerQuestion[] {
  if (previous === null) return candidates
  const pool = candidates.filter((c) => !sameQuestion(c, previous))
  return pool.length > 0 ? pool : candidates
}

/**
 * Generate the next question for `ctx`, avoiding an immediate repeat of
 * `previous`. Pure given `rng`. Throws if the context has no answerable
 * question (caller must ensure a non-empty string list and valid range).
 *
 * With `picking` supplied, questions are biased toward the weakest pitch
 * classes; without it, they are drawn uniformly.
 */
export function generateQuestion(
  ctx: QuestionContext,
  previous: TrainerQuestion | null,
  rng: Rng,
  picking?: QuestionPicking,
): TrainerQuestion {
  const candidates = possibleQuestions(ctx)
  if (candidates.length === 0) throw new Error('generateQuestion: no answerable questions')
  if (picking) {
    const pool = withoutPrevious(candidates, previous)
    return pickWeightedByPc(pool, (q) => q.pc, picking.stats, rng, picking.now)
  }
  return pickAvoiding(candidates, previous, rng, sameQuestion)
}

// --- Settings ---------------------------------------------------------------

export interface FretboardTrainerSettings {
  mode: QuizMode
  fromFret: number
  toFret: number
  /** Spelling used for note labels and answer buttons. */
  accidentals: 'sharp' | 'flat'
  /** String indices the player has switched off. New strings are on by default. */
  excludedStrings: number[]
  /** Bias question picking toward the notes the player is weakest on. */
  focusWeak: boolean
}

/** Highest fret any preset/range may reach (matches `DEFAULT_FRET_COUNT`). */
export const MAX_FRET = 24

/** Selectable fret-range presets. */
export const FRET_RANGE_PRESETS = [
  { id: '0-5', label: '0–5', from: 0, to: 5 },
  { id: '0-12', label: '0–12', from: 0, to: 12 },
  { id: '0-24', label: 'Full neck', from: 0, to: MAX_FRET },
] as const

export const DEFAULT_TRAINER_SETTINGS: FretboardTrainerSettings = {
  mode: 'find',
  fromFret: 0,
  toFret: 12,
  accidentals: 'sharp',
  excludedStrings: [],
  focusWeak: true,
}

function clampFret(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback
  return Math.min(MAX_FRET, Math.max(0, Math.round(value)))
}

/** Coerce arbitrary persisted/typed data into valid settings. */
export function normalizeTrainerSettings(value: unknown): FretboardTrainerSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof FretboardTrainerSettings, unknown>
  >
  const mode: QuizMode = v.mode === 'name' ? 'name' : v.mode === 'findAll' ? 'findAll' : 'find'
  const from = clampFret(v.fromFret, DEFAULT_TRAINER_SETTINGS.fromFret)
  const toRaw = clampFret(v.toFret, DEFAULT_TRAINER_SETTINGS.toFret)
  const toFret = Math.max(from, toRaw)
  const accidentals: 'sharp' | 'flat' = v.accidentals === 'flat' ? 'flat' : 'sharp'
  const excludedStrings = Array.isArray(v.excludedStrings)
    ? Array.from(
        new Set(
          v.excludedStrings.filter(
            (n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0,
          ),
        ),
      ).sort((a, b) => a - b)
    : []
  const focusWeak = typeof v.focusWeak === 'boolean' ? v.focusWeak : DEFAULT_TRAINER_SETTINGS.focusWeak
  return { mode, fromFret: from, toFret, accidentals, excludedStrings, focusWeak }
}

/**
 * Resolve the playable string indices for a tuning: all strings minus the
 * excluded ones, always non-empty (if every string were excluded, all are
 * treated as included — you can't quiz on zero strings).
 */
export function resolveIncludedStrings(excluded: number[], stringCount: number): number[] {
  const excludedSet = new Set(excluded)
  const included: number[] = []
  for (let s = 0; s < stringCount; s++) if (!excludedSet.has(s)) included.push(s)
  if (included.length === 0) return Array.from({ length: stringCount }, (_, s) => s)
  return included
}

/** Build a trainer-settings store (tests pass `memoryBackend()`). */
export function createTrainerSettingsStore(
  backend?: StorageBackend,
): Store<FretboardTrainerSettings> {
  return new Store<FretboardTrainerSettings>(
    {
      key: 'settings:fretboard-trainer',
      // v2 added the 'findAll' quiz mode; v3 added the 'focusWeak' toggle. The
      // shape is otherwise unchanged, so old data just re-normalizes cleanly.
      version: 3,
      defaultValue: DEFAULT_TRAINER_SETTINGS,
      migrate: (oldData) => normalizeTrainerSettings(oldData),
    },
    backend,
  )
}

/** The app-wide trainer settings store (localStorage-backed). */
export const trainerSettingsStore = createTrainerSettingsStore()
