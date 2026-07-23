/**
 * Domain logic for the Theory Quiz tool: pure multiple-choice question
 * generation across three categories — key signatures, diatonic chords, and
 * intervals — plus persisted category-filter settings.
 *
 * Every generator returns a fully-formed `TheoryQuizQuestion`: a prompt, four
 * shuffled option strings (one correct + three plausible distractors), and
 * the correct answer text. This keeps the page a thin shell: it only needs to
 * render `prompt`/`options` and pass the tapped option to `checkAnswer`, and
 * can reuse `QuizSession` from `./quiz.ts` unmodified (question type `Q` =
 * `TheoryQuizQuestion`, answer type `A` = `string`).
 *
 * All randomness is injected via `Rng` (see `./quiz.ts`), so every generator
 * is pure and deterministic for a given rng — fully unit-testable without
 * touching `window`/`document`.
 */

import { diatonicTriads } from './theory/chords.ts'
import { INTERVALS, intervalName } from './theory/intervals.ts'
import { LETTER_PC, LETTERS, mod12, pcToName, type Letter, type PitchClass } from './theory/notes.ts'
import { getScale } from './theory/scales.ts'
import { spellScale } from './theory/spell.ts'
import { CIRCLE_KEYS } from '../components/circleGeometry.ts'
import type { Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'

const MAJOR_INTERVALS = getScale('major').intervals

// --- Question model ----------------------------------------------------

export type QuizCategory = 'keySignature' | 'diatonicChord' | 'interval'

export const QUIZ_CATEGORIES: readonly { id: QuizCategory; label: string }[] = [
  { id: 'keySignature', label: 'Key signatures' },
  { id: 'diatonicChord', label: 'Diatonic chords' },
  { id: 'interval', label: 'Intervals' },
]

/**
 * A ready-to-render multiple-choice question: `options` is always four
 * strings, shuffled, containing `answer` exactly once. `kind` distinguishes
 * the specific question shape within a category (useful for tests) but is
 * not meant to be shown to the player.
 */
export interface TheoryQuizQuestion {
  category: QuizCategory
  kind: string
  prompt: string
  options: string[]
  answer: string
}

/** Grade a multiple-choice answer: exact string match against `question.answer`. */
export function checkAnswer(question: TheoryQuizQuestion, answer: string): boolean {
  return answer === question.answer
}

// --- Shared helpers ------------------------------------------------------

/** A random integer in `[0, n)`. Throws for `n <= 0`. */
function randomIndex(n: number, rng: Rng): number {
  if (n <= 0) throw new Error('randomIndex: n must be positive')
  return Math.min(n - 1, Math.floor(rng() * n))
}

/** Fisher-Yates shuffle using the injected `rng`; does not mutate `items`. */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, rng)
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

/**
 * Build the four shuffled option strings for a question: `correct` plus
 * three distinct distractors drawn (and shuffled) from `pool`. Distractors
 * equal to `correct` or to each other are dropped before picking, so the
 * result never contains a duplicate. Throws if `pool` doesn't contain at
 * least three distinct non-`correct` values — every generator below is
 * responsible for supplying a pool that large.
 */
function buildOptions(correct: string, pool: readonly string[], rng: Rng, size = 4): string[] {
  const seen = new Set<string>([correct])
  const distinctPool: string[] = []
  for (const candidate of pool) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    distinctPool.push(candidate)
  }
  const need = size - 1
  if (distinctPool.length < need) {
    throw new Error(`buildOptions: need ${need} distinct distractors, got ${distinctPool.length}`)
  }
  const distractors = shuffle(distinctPool, rng).slice(0, need)
  return shuffle([correct, ...distractors], rng)
}

// --- Key signatures --------------------------------------------------------

/** Format a signed accidental count, e.g. `3` -> "3 sharps", `0` -> "No sharps or flats". */
function signatureCountText(signature: number): string {
  const n = Math.abs(signature)
  if (n === 0) return 'No sharps or flats'
  const word = signature > 0 ? 'sharp' : 'flat'
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Every signature value other than `correct`, ordered by closeness (most confusable first). */
function neighboringSignatures(correct: number): number[] {
  const all = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]
  return all
    .filter((v) => v !== correct)
    .sort((a, b) => Math.abs(a - correct) - Math.abs(b - correct))
}

/** Circle-of-fifths indexes nearest to `index` (excluding itself), closest first. */
function neighborIndexes(index: number, count: number): number[] {
  const offsets = [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6]
  const result: number[] = []
  for (const offset of offsets) {
    if (result.length >= count) break
    result.push(mod12(index + offset))
  }
  return result
}

function generateKeySignatureQuestion(rng: Rng): TheoryQuizQuestion {
  const mode: 'major' | 'minor' = rng() < 0.5 ? 'major' : 'minor'
  const reverse = rng() < 0.5
  const index = randomIndex(CIRCLE_KEYS.length, rng)
  const key = CIRCLE_KEYS[index]!
  const keyName = (mode === 'major' ? key.majorName : key.minorName.toLowerCase()) + ` ${mode}`

  if (!reverse) {
    const prompt = `How many sharps or flats does ${keyName} have?`
    const answer = signatureCountText(key.signature)
    const pool = neighboringSignatures(key.signature).map(signatureCountText)
    const options = buildOptions(answer, pool, rng)
    return { category: 'keySignature', kind: 'count', prompt, options, answer }
  }

  const prompt = `Which ${mode} key has ${signatureCountText(key.signature)}?`
  const answer = mode === 'major' ? key.majorName : key.minorName.toLowerCase()
  const pool = neighborIndexes(index, 8).map((i) => {
    const k = CIRCLE_KEYS[i]!
    return mode === 'major' ? k.majorName : k.minorName.toLowerCase()
  })
  const options = buildOptions(answer, pool, rng)
  return { category: 'keySignature', kind: 'name', prompt, options, answer }
}

// --- Diatonic chords --------------------------------------------------------

function generateDiatonicChordQuestion(rng: Rng): TheoryQuizQuestion {
  const index = randomIndex(CIRCLE_KEYS.length, rng)
  const key = CIRCLE_KEYS[index]!
  const scaleNames = spellScale(key.majorPc, MAJOR_INTERVALS, key.rootLetter)
  const triads = diatonicTriads(key.majorPc)
  const symbols = triads.map((t, i) => scaleNames[i]! + t.quality.symbol)

  const degreeIndex = randomIndex(triads.length, rng)
  const askForChord = rng() < 0.5

  if (askForChord) {
    const triad = triads[degreeIndex]!
    const prompt = `What is the ${triad.numeral} chord in ${key.majorName} major?`
    const answer = symbols[degreeIndex]!
    const pool = symbols.filter((_, i) => i !== degreeIndex)
    const options = buildOptions(answer, pool, rng)
    return { category: 'diatonicChord', kind: 'chordOfDegree', prompt, options, answer }
  }

  const prompt = `What scale degree is ${symbols[degreeIndex]} in ${key.majorName} major?`
  const answer = triads[degreeIndex]!.numeral
  const pool = triads.filter((_, i) => i !== degreeIndex).map((t) => t.numeral)
  const options = buildOptions(answer, pool, rng)
  return { category: 'diatonicChord', kind: 'degreeOfChord', prompt, options, answer }
}

// --- Intervals --------------------------------------------------------------

/** Every semitone count 0–12 other than `correct`. */
function neighboringSemitones(correct: number): number[] {
  return Array.from({ length: 13 }, (_, s) => s).filter((s) => s !== correct)
}

function intervalLabel(semitones: number): string {
  const iv = intervalName(semitones)
  return `${iv.short} (${iv.name})`
}

/** Every simple-interval (1–11 semitone) label other than `correct`. */
function neighboringIntervalLabels(correct: number): string[] {
  const labels: string[] = []
  for (let s = 1; s <= 11; s++) {
    if (s !== correct) labels.push(intervalLabel(s))
  }
  return labels
}

function generateIntervalQuestion(rng: Rng): TheoryQuizQuestion {
  const askSemitones = rng() < 0.5

  if (askSemitones) {
    const interval = INTERVALS[randomIndex(INTERVALS.length, rng)]!
    const prompt = `How many semitones is a ${interval.short} (${interval.name})?`
    const answer = String(interval.semitones)
    const pool = neighboringSemitones(interval.semitones).map(String)
    const options = buildOptions(answer, pool, rng)
    return { category: 'interval', kind: 'semitones', prompt, options, answer }
  }

  // Note-to-note: a natural root letter up to any other pitch class (natural
  // or single-accidental spelling), kept within an octave (1-11 semitones
  // ascending) so it always matches one of the app's defined interval names.
  const rootLetter: Letter = LETTERS[randomIndex(LETTERS.length, rng)]!
  const rootPc: PitchClass = LETTER_PC[rootLetter]
  const distance = 1 + randomIndex(11, rng) // 1..11
  const targetPc = mod12(rootPc + distance)
  const prefer = rng() < 0.5 ? 'sharp' : 'flat'
  const targetName = pcToName(targetPc, prefer)

  const prompt = `What interval is ${rootLetter} to ${targetName}?`
  const answer = intervalLabel(distance)
  const pool = neighboringIntervalLabels(distance)
  const options = buildOptions(answer, pool, rng)
  return { category: 'interval', kind: 'noteToNote', prompt, options, answer }
}

// --- Dispatch ----------------------------------------------------------

function generateForCategory(category: QuizCategory, rng: Rng): TheoryQuizQuestion {
  switch (category) {
    case 'keySignature':
      return generateKeySignatureQuestion(rng)
    case 'diatonicChord':
      return generateDiatonicChordQuestion(rng)
    case 'interval':
      return generateIntervalQuestion(rng)
  }
}

/** How many times to retry generation to avoid an identical-prompt repeat. */
const MAX_REPEAT_ATTEMPTS = 8

/**
 * Generate the next question, picking uniformly among `categories` and
 * avoiding an immediate repeat of `previous` (by prompt) when it can. Pure
 * given `rng`. Throws if `categories` is empty.
 */
export function generateQuestion(
  categories: readonly QuizCategory[],
  previous: TheoryQuizQuestion | null,
  rng: Rng,
): TheoryQuizQuestion {
  if (categories.length === 0) throw new Error('generateQuestion: no categories enabled')
  let candidate: TheoryQuizQuestion | null = null
  for (let attempt = 0; attempt < MAX_REPEAT_ATTEMPTS; attempt++) {
    const category = categories[randomIndex(categories.length, rng)]!
    candidate = generateForCategory(category, rng)
    if (!previous || candidate.prompt !== previous.prompt) return candidate
  }
  return candidate!
}

// --- Settings ---------------------------------------------------------------

export interface TheoryQuizSettings {
  categories: Record<QuizCategory, boolean>
}

export const DEFAULT_THEORY_QUIZ_SETTINGS: TheoryQuizSettings = {
  categories: { keySignature: true, diatonicChord: true, interval: true },
}

/** The enabled categories of `settings`, in `QUIZ_CATEGORIES` order. */
export function enabledCategories(settings: TheoryQuizSettings): QuizCategory[] {
  return QUIZ_CATEGORIES.map((c) => c.id).filter((id) => settings.categories[id])
}

/**
 * Coerce arbitrary persisted/typed data into valid settings. A category is
 * enabled unless explicitly `false`, so old/partial data defaults to "on".
 * If every category would end up disabled, falls back to the full default
 * instead (there must always be at least one enabled category).
 */
export function normalizeTheoryQuizSettings(value: unknown): TheoryQuizSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<{
    categories: unknown
  }>
  const raw = (typeof v.categories === 'object' && v.categories !== null ? v.categories : {}) as Partial<
    Record<QuizCategory, unknown>
  >
  const categories: Record<QuizCategory, boolean> = {
    keySignature: raw.keySignature !== false,
    diatonicChord: raw.diatonicChord !== false,
    interval: raw.interval !== false,
  }
  if (!categories.keySignature && !categories.diatonicChord && !categories.interval) {
    return DEFAULT_THEORY_QUIZ_SETTINGS
  }
  return { categories }
}

/** Build a theory-quiz settings store (tests pass `memoryBackend()`). */
export function createTheoryQuizSettingsStore(backend?: StorageBackend): Store<TheoryQuizSettings> {
  return new Store<TheoryQuizSettings>(
    {
      key: 'settings:theory-quiz',
      version: 1,
      defaultValue: DEFAULT_THEORY_QUIZ_SETTINGS,
      migrate: (oldData) => normalizeTheoryQuizSettings(oldData),
    },
    backend,
  )
}

/** The app-wide theory-quiz settings store (localStorage-backed). */
export const theoryQuizSettingsStore = createTheoryQuizSettingsStore()
