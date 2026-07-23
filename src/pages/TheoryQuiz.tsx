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
  theoryQuizSrsStore,
  type QuizCategory,
  type TheoryQuizQuestion,
  type TheoryQuizSettings,
} from '../lib/theoryQuiz.ts'
import { normalizeSrsData, qualityFromOutcome, reviewKey, type SrsData } from '../lib/spacedRepetition.ts'
import { useGlobalSettings } from '../hooks/useGlobalSettings.ts'
import { applySpellingPreference } from '../lib/globalSettings.ts'
import { recordPractice } from '../lib/practiceLog.ts'
import { useAnswerShortcuts } from '../hooks/useAnswerShortcuts.ts'
import { shortcutLabel } from '../lib/answerShortcuts.ts'

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

  // Spaced-repetition schedule (per fact). Reviews are recorded on every
  // answer; the schedule biases which fact is quizzed next. Read via a ref so
  // the (stable) generator always sees the latest schedule.
  const [srs, setSrs] = useState<SrsData>(() => normalizeSrsData(theoryQuizSrsStore.get()))
  const srsRef = useRef(srs)
  srsRef.current = srs

  // A forced global sharps/flats preference fixes note-to-note interval
  // spelling; `'auto'` leaves it a per-question coin flip. Read via a ref so
  // the (stable) generator always sees the current preference.
  const { settings: globalSettings } = useGlobalSettings()
  const preferOverride =
    globalSettings.spellingPreference === 'auto'
      ? undefined
      : applySpellingPreference(globalSettings.spellingPreference, 'sharp')
  const preferOverrideRef = useRef(preferOverride)
  preferOverrideRef.current = preferOverride

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
      generate: (previous, rng) =>
        generateQuestion(
          categories,
          previous,
          rng,
          { srs: srsRef.current, now: Date.now() },
          preferOverrideRef.current,
        ),
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

      // Record the review and stamp the practice log — Theory Quiz tracks no
      // other stats, so this is where its activity reaches the dashboard.
      const now = Date.now()
      recordPractice(new Date(now))
      setSrs(
        theoryQuizSrsStore.update((d) =>
          reviewKey(d, res.question.srsKey, qualityFromOutcome(res.correct, res.responseMs), now),
        ),
      )

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
  const options = question?.options ?? []

  // Number keys 1–N pick an answer while unanswered; Enter advances early
  // once the current answer is showing (there is always a pending auto-advance).
  const selectOption = useCallback(
    (index: number) => {
      const option = options[index]
      if (option !== undefined) submit(option)
    },
    [options, submit],
  )
  useAnswerShortcuts({
    optionCount: answered ? 0 : options.length,
    onSelect: selectOption,
    onNext: answered ? advance : undefined,
  })

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
          {question.options.map((option, index) => {
            const isCorrect = answered && option === question.answer
            const isWrongChoice = answered && result?.answer === option && !result.correct
            const cls = ['tq-option-btn']
            if (isCorrect) cls.push('tq-option-correct')
            if (isWrongChoice) cls.push('tq-option-wrong')
            const key = shortcutLabel(index)
            return (
              <button
                key={option}
                type="button"
                className={cls.join(' ')}
                disabled={answered}
                title={key ? `Shortcut: press ${key}` : undefined}
                onClick={() => submit(option)}
              >
                {key && (
                  <span className="sc-key" aria-hidden="true">
                    {key}
                  </span>
                )}
                {option}
              </button>
            )
          })}
        </div>
      )}

      {question && (
        <p className="sc-hint">Tip: press 1–{question.options.length} to answer, Enter for next.</p>
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
