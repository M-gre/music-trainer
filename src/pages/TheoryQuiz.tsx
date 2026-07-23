/**
 * Theory Quiz — multiple-choice questions across three categories: key
 * signatures (sharps/flats counts, both directions, major and relative
 * minor), diatonic chords ("what is the V chord of X major?" and its
 * reverse), and intervals (semitone counts and note-to-note naming).
 *
 * All question generation, grading, and distractor-building is pure logic in
 * `src/lib/theoryQuiz.ts`; this page is a thin shell over that plus the
 * shared `QuizSession` from `src/lib/quiz.ts` (question type = the ready-made
 * `TheoryQuizQuestion`, answer type = the tapped option string). Category
 * filter chips persist via a versioned `Store`, same pattern as the other
 * quiz tools' settings.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { emptyStats, QuizSession, type AnswerResult, type QuizStats } from '../lib/quiz.ts'
import {
  checkAnswer,
  enabledCategories,
  generateQuestion,
  normalizeTheoryQuizSettings,
  QUIZ_CATEGORIES,
  theoryQuizSettingsStore,
  type QuizCategory,
  type TheoryQuizQuestion,
  type TheoryQuizSettings,
} from '../lib/theoryQuiz.ts'

/** How long the answer stays on screen before auto-advancing. */
const ADVANCE_MS_CORRECT = 900
const ADVANCE_MS_WRONG = 2200

export function TheoryQuiz() {
  const timeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<TheoryQuizSettings>(() =>
    normalizeTheoryQuizSettings(theoryQuizSettingsStore.get()),
  )

  useEffect(() => {
    theoryQuizSettingsStore.set(settings)
  }, [settings])

  const categories = useMemo(() => enabledCategories(settings), [settings])
  const categoriesKey = categories.join(',')

  const sessionRef = useRef<QuizSession<TheoryQuizQuestion, string> | null>(null)
  const [question, setQuestion] = useState<TheoryQuizQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [result, setResult] = useState<AnswerResult<TheoryQuizQuestion, string> | null>(null)

  const clearPendingAdvance = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const advance = useCallback(() => {
    clearPendingAdvance()
    const session = sessionRef.current
    if (!session) return
    session.next()
    setQuestion(session.current)
    setResult(null)
  }, [clearPendingAdvance])

  // Fresh session whenever the enabled category set changes (including mount).
  useEffect(() => {
    clearPendingAdvance()
    const session = new QuizSession<TheoryQuizQuestion, string>({
      generate: (previous, rng) => generateQuestion(categories, previous, rng),
      check: checkAnswer,
      clock: () => performance.now(),
    })
    sessionRef.current = session
    session.next()
    setQuestion(session.current)
    setStats(session.stats)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoriesKey])

  useEffect(() => () => clearPendingAdvance(), [clearPendingAdvance])

  const submit = useCallback(
    (answer: string) => {
      const session = sessionRef.current
      if (!session || !session.current || session.isAnswered) return
      const res = session.answer(answer)
      setResult(res)
      setStats(session.stats)

      clearPendingAdvance()
      timeoutRef.current = window.setTimeout(
        advance,
        res.correct ? ADVANCE_MS_CORRECT : ADVANCE_MS_WRONG,
      )
    },
    [advance, clearPendingAdvance],
  )

  const toggleCategory = (id: QuizCategory) => {
    setSettings((s) => {
      const currentlyOn = s.categories[id]
      const enabledCount = QUIZ_CATEGORIES.filter((c) => s.categories[c.id]).length
      if (currentlyOn && enabledCount === 1) return s // keep at least one enabled
      return { ...s, categories: { ...s.categories, [id]: !currentlyOn } }
    })
  }

  const answered = result !== null

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Theory Quiz</h1>
        <p className="tool-page-lead">
          Key signatures, diatonic chords, and interval naming — multiple choice, with score and
          streak tracking.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Categories</span>
          <div className="tq-chips" role="group" aria-label="Question categories">
            {QUIZ_CATEGORIES.map((c) => {
              const on = settings.categories[c.id]
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`tq-chip${on ? ' tq-chip-active' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleCategory(c.id)}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="tq-prompt" role="status" aria-live="polite">
        {!question ? (
          <span className="tq-prompt-text">Loading…</span>
        ) : answered ? (
          <span className={`tq-prompt-feedback ${result!.correct ? 'tq-correct' : 'tq-wrong'}`}>
            {result!.correct ? 'Correct!' : `Not quite — the answer is ${question.answer}.`}
          </span>
        ) : (
          <span className="tq-prompt-text">{question.prompt}</span>
        )}
      </div>

      {question && (
        <div className="tq-option-grid" role="group" aria-label="Answer options">
          {question.options.map((option) => {
            const isCorrect = answered && option === question.answer
            const isWrongChoice = answered && result?.answer === option && !result.correct
            const cls = ['tq-option-btn']
            if (isCorrect) cls.push('tq-option-correct')
            if (isWrongChoice) cls.push('tq-option-wrong')
            return (
              <button
                key={option}
                type="button"
                className={cls.join(' ')}
                disabled={answered}
                onClick={() => submit(option)}
              >
                {option}
              </button>
            )
          })}
        </div>
      )}

      <div className="tq-score">
        <div className="tq-score-item">
          <span className="tq-score-value">{stats.streak}</span>
          <span className="tq-score-label">Streak</span>
        </div>
        <div className="tq-score-item">
          <span className="tq-score-value">
            {stats.correct}
            <span className="tq-score-sep">/</span>
            {stats.answered}
          </span>
          <span className="tq-score-label">Correct</span>
        </div>
        <div className="tq-score-item">
          <span className="tq-score-value">{stats.bestStreak}</span>
          <span className="tq-score-label">Best streak</span>
        </div>
      </div>
    </div>
  )
}
