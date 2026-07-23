/**
 * Reusable, framework-free quiz-session core.
 *
 * This is the shared engine behind every quiz tool (the fretboard note
 * trainer is the first; keyboard trainer, note reading and ear training will
 * reuse it). It is deliberately generic over a question type `Q` and an
 * answer type `A`, and it owns nothing musical — domain tools supply:
 *  - a pure `generate(previous, rng)` that produces the next question
 *    (given the previous one so it can avoid immediate repeats), and
 *  - a pure `check(question, answer)` that grades an answer.
 *
 * The session tracks score, current/best streak and (optionally) response
 * time. All impurity is injected: randomness via `rng` and the clock via
 * `clock`, so tests are fully deterministic and this file never touches
 * `window`/`document` (it runs in the `node` test environment).
 */

/** A source of randomness in `[0, 1)`, matching `Math.random`. */
export type Rng = () => number

/** A source of monotonic timestamps in milliseconds, e.g. `performance.now`. */
export type Clock = () => number

/** Equality used to detect an immediate repeat. */
export type Eq<T> = (a: T, b: T) => boolean

export interface QuizSessionOptions<Q, A> {
  /**
   * Pure generator for the next question. Receives the currently-displayed
   * question (or `null` for the first) so it can avoid an immediate repeat,
   * plus the injected `rng`.
   */
  generate: (previous: Q | null, rng: Rng) => Q
  /** Pure grader: is `answer` correct for `question`? */
  check: (question: Q, answer: A) => boolean
  /** Randomness source. Defaults to `Math.random`. */
  rng?: Rng
  /**
   * Clock for response-time capture. Defaults to `undefined`, in which case
   * response times are reported as `null`. Pass e.g. `() => performance.now()`.
   */
  clock?: Clock
}

/** The outcome of grading a single answer. */
export interface AnswerResult<Q, A> {
  question: Q
  answer: A
  correct: boolean
  /** Milliseconds from question presentation to this answer, or `null`. */
  responseMs: number | null
}

/** Aggregate progress for the current session. */
export interface QuizStats {
  /** Questions graded so far. */
  answered: number
  correct: number
  incorrect: number
  /** Consecutive correct answers ending at the latest graded answer. */
  streak: number
  /** Best `streak` reached this session. */
  bestStreak: number
  /** Mean response time over graded answers that had timing, or `null`. */
  averageResponseMs: number | null
}

const EMPTY_STATS: QuizStats = {
  answered: 0,
  correct: 0,
  incorrect: 0,
  streak: 0,
  bestStreak: 0,
  averageResponseMs: null,
}

/**
 * A single quiz run. Construct it, call `next()` to present the first
 * question, `answer(a)` to grade the current one, then `next()` again to
 * advance. Answering the same question twice is a no-op (the first grade
 * stands), so a double-tap in the UI can't inflate the score.
 */
export class QuizSession<Q, A> {
  private readonly generate: (previous: Q | null, rng: Rng) => Q
  private readonly check: (question: Q, answer: A) => boolean
  private readonly rng: Rng
  private readonly clock: Clock | undefined

  private currentQuestion: Q | null = null
  private presentedAt: number | null = null
  private answered = false
  private lastResultValue: AnswerResult<Q, A> | null = null

  private answeredCount = 0
  private correctCount = 0
  private currentStreak = 0
  private bestStreakValue = 0
  private responseCount = 0
  private responseTotal = 0

  constructor(options: QuizSessionOptions<Q, A>) {
    this.generate = options.generate
    this.check = options.check
    this.rng = options.rng ?? Math.random
    this.clock = options.clock
  }

  /** The question currently presented, or `null` before the first `next()`. */
  get current(): Q | null {
    return this.currentQuestion
  }

  /** Whether the current question has already been graded. */
  get isAnswered(): boolean {
    return this.answered
  }

  /** The most recent grade, or `null` before any answer. */
  get lastResult(): AnswerResult<Q, A> | null {
    return this.lastResultValue
  }

  /** A snapshot of the current score/streak/timing. */
  get stats(): QuizStats {
    return {
      answered: this.answeredCount,
      correct: this.correctCount,
      incorrect: this.answeredCount - this.correctCount,
      streak: this.currentStreak,
      bestStreak: this.bestStreakValue,
      averageResponseMs:
        this.responseCount > 0 ? this.responseTotal / this.responseCount : null,
    }
  }

  /**
   * Generate and present the next question. Passes the current question to
   * the generator so it can avoid an immediate repeat, and (re)starts the
   * response-time clock. Returns the new question.
   */
  next(): Q {
    const question = this.generate(this.currentQuestion, this.rng)
    this.currentQuestion = question
    this.presentedAt = this.clock ? this.clock() : null
    this.answered = false
    return question
  }

  /**
   * Grade `answer` against the current question and fold it into the stats.
   * Throws if called before `next()`. Returns the grade; if the current
   * question was already answered, returns that first grade unchanged.
   */
  answer(answer: A): AnswerResult<Q, A> {
    const question = this.currentQuestion
    if (question === null) throw new Error('answer() called before next()')
    if (this.answered && this.lastResultValue) return this.lastResultValue

    const correct = this.check(question, answer)
    const responseMs =
      this.clock && this.presentedAt !== null ? this.clock() - this.presentedAt : null

    this.answeredCount += 1
    if (correct) {
      this.correctCount += 1
      this.currentStreak += 1
      if (this.currentStreak > this.bestStreakValue) this.bestStreakValue = this.currentStreak
    } else {
      this.currentStreak = 0
    }
    if (responseMs !== null) {
      this.responseCount += 1
      this.responseTotal += responseMs
    }

    const result: AnswerResult<Q, A> = { question, answer, correct, responseMs }
    this.answered = true
    this.lastResultValue = result
    return result
  }

  /** Clear all progress and the current question, back to a fresh session. */
  reset(): void {
    this.currentQuestion = null
    this.presentedAt = null
    this.answered = false
    this.lastResultValue = null
    this.answeredCount = 0
    this.correctCount = 0
    this.currentStreak = 0
    this.bestStreakValue = 0
    this.responseCount = 0
    this.responseTotal = 0
  }
}

/** The zero-progress stats value (useful as a React initial state). */
export function emptyStats(): QuizStats {
  return { ...EMPTY_STATS }
}

// --- Find-all (multi-answer) session ---------------------------------------

/**
 * Progress within a single find-all round: how many of the required positions
 * have been found, the total, mistakes so far, and whether the round is done.
 */
export interface FindAllProgress {
  found: number
  total: number
  mistakes: number
  complete: boolean
}

/** The outcome of a single `submit` on a find-all round. */
export interface FindAllSubmitResult {
  /**
   * `'found'` — a required, not-yet-found target; `'already'` — a target found
   * before (no-op); `'wrong'` — not a target (counts as a mistake).
   */
  outcome: 'found' | 'already' | 'wrong'
  /** True only for the submit that finds the last remaining target. */
  justCompleted: boolean
  progress: FindAllProgress
}

export interface FindAllSessionOptions<Q, A> {
  /** Pure generator for the next question (see `QuizSessionOptions`). */
  generate: (previous: Q | null, rng: Rng) => Q
  /**
   * Every answer key that must be found to complete `question`. Keys are
   * compared by string equality against `keyOf(answer)`; the caller chooses a
   * stable encoding (e.g. `"string:fret"` or a midi number as a string).
   */
  targetsOf: (question: Q) => readonly string[]
  /** Stable key for a submitted answer, compared against the targets. */
  keyOf: (answer: A) => string
  /** Randomness source. Defaults to `Math.random`. */
  rng?: Rng
}

/**
 * A "find every instance" quiz run: each question names a target (e.g. a pitch
 * class) with several correct positions in range, and the player must click
 * them all. Found positions stay found; a click that is not a target is a
 * mistake but never un-finds anything. A round completes when every target is
 * found; it counts as "correct" for the streak only if it was completed with
 * zero mistakes.
 *
 * This complements `QuizSession` (single-answer) without touching it, so both
 * models stay available. It is pure: all randomness is injected via `rng` and
 * it never touches `window`/`document`.
 */
export class FindAllSession<Q, A> {
  private readonly generate: (previous: Q | null, rng: Rng) => Q
  private readonly targetsOf: (question: Q) => readonly string[]
  private readonly keyOf: (answer: A) => string
  private readonly rng: Rng

  private currentQuestion: Q | null = null
  private targets = new Set<string>()
  private found = new Set<string>()
  private mistakes = 0
  /** Whether the current round has been folded into the aggregate stats. */
  private roundClosed = false

  private completedRounds = 0
  private perfectRounds = 0
  private currentStreak = 0
  private bestStreakValue = 0

  constructor(options: FindAllSessionOptions<Q, A>) {
    this.generate = options.generate
    this.targetsOf = options.targetsOf
    this.keyOf = options.keyOf
    this.rng = options.rng ?? Math.random
  }

  /** The question currently presented, or `null` before the first `next()`. */
  get current(): Q | null {
    return this.currentQuestion
  }

  /** Keys found so far in the current round (for rendering markers). */
  get foundKeys(): readonly string[] {
    return [...this.found]
  }

  /** Whether every target of the current round has been found. */
  get isComplete(): boolean {
    return this.targets.size > 0 && this.found.size >= this.targets.size
  }

  /** Progress for the current round. */
  get progress(): FindAllProgress {
    return {
      found: this.found.size,
      total: this.targets.size,
      mistakes: this.mistakes,
      complete: this.isComplete,
    }
  }

  /**
   * Aggregate progress across rounds, reusing `QuizStats`: `answered` counts
   * completed rounds, `correct` counts rounds completed with zero mistakes,
   * and the streak follows those perfect rounds. Timing is not tracked.
   */
  get stats(): QuizStats {
    return {
      answered: this.completedRounds,
      correct: this.perfectRounds,
      incorrect: this.completedRounds - this.perfectRounds,
      streak: this.currentStreak,
      bestStreak: this.bestStreakValue,
      averageResponseMs: null,
    }
  }

  /** Generate and present the next question, starting a fresh round. */
  next(): Q {
    const question = this.generate(this.currentQuestion, this.rng)
    this.currentQuestion = question
    this.targets = new Set(this.targetsOf(question))
    this.found = new Set()
    this.mistakes = 0
    this.roundClosed = false
    return question
  }

  /**
   * Register a clicked position against the current round. Throws if called
   * before `next()`. Folds the round into the stats exactly once, on the
   * submit that completes it.
   */
  submit(answer: A): FindAllSubmitResult {
    if (this.currentQuestion === null) throw new Error('submit() called before next()')

    const key = this.keyOf(answer)
    let outcome: 'found' | 'already' | 'wrong'
    if (!this.targets.has(key)) {
      if (!this.roundClosed) this.mistakes += 1
      outcome = 'wrong'
    } else if (this.found.has(key)) {
      outcome = 'already'
    } else {
      this.found.add(key)
      outcome = 'found'
    }

    const complete = this.isComplete
    let justCompleted = false
    if (complete && !this.roundClosed) {
      this.roundClosed = true
      justCompleted = true
      this.completedRounds += 1
      if (this.mistakes === 0) {
        this.perfectRounds += 1
        this.currentStreak += 1
        if (this.currentStreak > this.bestStreakValue) this.bestStreakValue = this.currentStreak
      } else {
        this.currentStreak = 0
      }
    }

    return { outcome, justCompleted, progress: this.progress }
  }

  /** Clear all progress and the current question, back to a fresh session. */
  reset(): void {
    this.currentQuestion = null
    this.targets = new Set()
    this.found = new Set()
    this.mistakes = 0
    this.roundClosed = false
    this.completedRounds = 0
    this.perfectRounds = 0
    this.currentStreak = 0
    this.bestStreakValue = 0
  }
}

/**
 * Pick a uniformly-random element of `items`, avoiding `avoid` when doing so
 * still leaves a choice. Pure given `rng`; the building block domain
 * generators use to prevent immediate repeats.
 *
 * Throws on an empty list. If every remaining item equals `avoid` (e.g. a
 * single-element list), `avoid` is returned rather than looping forever.
 */
export function pickAvoiding<T>(
  items: readonly T[],
  avoid: T | null,
  rng: Rng,
  eq: Eq<T> = (a, b) => a === b,
): T {
  if (items.length === 0) throw new Error('pickAvoiding: empty list')
  const pool = avoid === null ? items : items.filter((item) => !eq(item, avoid))
  const source = pool.length > 0 ? pool : items
  const index = Math.min(source.length - 1, Math.floor(rng() * source.length))
  return source[index]!
}
