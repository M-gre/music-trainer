/**
 * Ear Training — the app's first by-ear quiz tool. Currently a single quiz:
 * interval recognition. It is a thin React shell over two pure cores:
 *  - `src/lib/quiz.ts`: `QuizSession` (score/streak), reused by every quiz.
 *  - `src/lib/earTraining.ts`: question generation, answer checking, playback
 *    scheduling, per-interval stats, and the persisted settings/stats stores.
 *
 * Structured for the rest of milestone M3. The later ear-training quizzes
 * (chord-quality recognition, scale/mode recognition) are meant to slot in as
 * SIBLING MODES here: add a mode to a top-level segmented control and render a
 * different trainer component. Everything interval-specific lives in
 * `IntervalTrainer` below and in `earTraining.ts`, so a chord/scale trainer can
 * reuse the same `QuizSession` wiring, the `et-*` styles, the play/replay
 * transport, the multiple-choice grid, and the stats-chip pattern without
 * touching this file's shell. Audio only ever starts from a user gesture
 * (`ensureRunning`), never at mount — matching the other tool pages.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getAudioEngine } from '../lib/audio/index.ts'
import { emptyStats, QuizSession, type QuizStats } from '../lib/quiz.ts'
import {
  accumulateStat,
  accuracy,
  ALL_INTERVAL_SEMITONES,
  checkIntervalAnswer,
  DEFAULT_NOTE_GAP,
  earTrainingSettingsStore,
  generateIntervalQuestion,
  INTERVAL_PRESETS,
  intervalBySemitones,
  intervalStatsStore,
  normalizeEarTrainingSettings,
  normalizeStats,
  PLAYBACK_LABELS,
  scheduleQuestion,
  toggleInterval,
  type EarTrainingSettings,
  type IntervalQuestion,
  type IntervalStats,
  type PlaybackSetting,
  type QuestionContext,
} from '../lib/earTraining.ts'

/** Per-note playback durations (seconds); harmonic rings a little longer. */
const MELODIC_NOTE_DURATION = 0.7
const HARMONIC_NOTE_DURATION = 1.4
/** How long a correct answer stays up before auto-advancing (ms). */
const ADVANCE_MS_CORRECT = 1000

const PLAYBACK_OPTIONS: { value: PlaybackSetting; label: string }[] = [
  { value: 'melodic-asc', label: PLAYBACK_LABELS['melodic-asc'] },
  { value: 'melodic-desc', label: PLAYBACK_LABELS['melodic-desc'] },
  { value: 'harmonic', label: PLAYBACK_LABELS.harmonic },
  { value: 'random', label: PLAYBACK_LABELS.random },
]

export function EarTraining() {
  // Only one mode today; the segmented control in the shell is the seam for
  // chord-quality / scale-recognition modes to slot in later.
  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Ear Training</h1>
        <p className="tool-page-lead">
          Train your ear to name intervals. Sound plays only after you press Play.
        </p>
      </div>
      <IntervalTrainer />
    </div>
  )
}

function IntervalTrainer() {
  const engineRef = useRef(getAudioEngine())
  const advanceTimeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<EarTrainingSettings>(() =>
    normalizeEarTrainingSettings(earTrainingSettingsStore.get()),
  )
  useEffect(() => {
    earTrainingSettingsStore.set(settings)
  }, [settings])

  // Live context read by the (stable) question generator.
  const context: QuestionContext = {
    enabled: settings.enabled,
    playback: settings.playback,
  }
  const contextRef = useRef(context)
  contextRef.current = context

  const sessionRef = useRef<QuizSession<IntervalQuestion, number> | null>(null)
  const [question, setQuestion] = useState<IntervalQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [answer, setAnswer] = useState<number | null>(null)
  /** True once the user has made the first audio gesture (enables auto-play). */
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)

  const [sessionStats, setSessionStats] = useState<IntervalStats>({})
  const [lifetimeStats, setLifetimeStats] = useState<IntervalStats>(() =>
    normalizeStats(intervalStatsStore.get()),
  )

  const clearAdvance = useCallback(() => {
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current)
      advanceTimeoutRef.current = null
    }
  }, [])

  /** Play an explicit interval (root + semitones) with the current mode. */
  const playInterval = useCallback((q: IntervalQuestion) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      const now = engine.currentTime
      const duration = q.mode === 'harmonic' ? HARMONIC_NOTE_DURATION : MELODIC_NOTE_DURATION
      for (const note of scheduleQuestion(q, DEFAULT_NOTE_GAP)) {
        engine.playNote(note.midi, duration, { when: now + note.when })
      }
    })
  }, [])

  const playCurrent = useCallback(() => {
    const q = sessionRef.current?.current
    if (!q) return
    if (!startedRef.current) {
      startedRef.current = true
      setStarted(true)
    }
    playInterval(q)
  }, [playInterval])

  // (Re)start a session whenever the answerable set changes (enabled intervals
  // or playback mode). Auto-plays the fresh question only if already started.
  const contextKey = `${settings.enabled.join(',')}|${settings.playback}`
  useEffect(() => {
    clearAdvance()
    const session = new QuizSession<IntervalQuestion, number>({
      generate: (previous, rng) => generateIntervalQuestion(contextRef.current, previous, rng),
      check: checkIntervalAnswer,
    })
    sessionRef.current = session
    session.next()
    setQuestion(session.current)
    setStats(session.stats)
    setAnswer(null)
    if (startedRef.current && session.current) playInterval(session.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey])

  useEffect(() => () => clearAdvance(), [clearAdvance])

  const advance = useCallback(() => {
    clearAdvance()
    const session = sessionRef.current
    if (!session) return
    session.next()
    setQuestion(session.current)
    setAnswer(null)
    if (startedRef.current && session.current) playInterval(session.current)
  }, [clearAdvance, playInterval])

  const submit = useCallback(
    (picked: number) => {
      const session = sessionRef.current
      const q = session?.current
      if (!session || !q || session.isAnswered) return
      const res = session.answer(picked)
      setAnswer(picked)
      setStats(session.stats)

      setSessionStats((s) => accumulateStat(s, q.semitones, res.correct))
      setLifetimeStats((s) => {
        const next = accumulateStat(s, q.semitones, res.correct)
        intervalStatsStore.set(next)
        return next
      })

      if (res.correct) {
        clearAdvance()
        advanceTimeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT)
      }
    },
    [advance, clearAdvance],
  )

  const resetStats = useCallback(() => {
    setSessionStats({})
    setLifetimeStats({})
    intervalStatsStore.set({})
  }, [])

  const answered = answer !== null
  const correct = answered && question !== null && answer === question.semitones

  const enabledSorted = useMemo(() => [...settings.enabled].sort((a, b) => a - b), [settings.enabled])

  const setPlayback = (value: PlaybackSetting): void =>
    setSettings((s) => ({ ...s, playback: value }))

  const applyPreset = (semitones: number[]): void =>
    setSettings((s) => ({ ...s, enabled: [...semitones] }))

  const toggle = (semitones: number): void =>
    setSettings((s) => ({ ...s, enabled: toggleInterval(s.enabled, semitones) }))

  return (
    <>
      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Playback</span>
          <div className="mn-segmented" role="group" aria-label="Playback mode">
            {PLAYBACK_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`mn-segment${settings.playback === option.value ? ' mn-segment-active' : ''}`}
                aria-pressed={settings.playback === option.value}
                onClick={() => setPlayback(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Interval set</span>
          <div className="mn-segmented" role="group" aria-label="Interval presets">
            {INTERVAL_PRESETS.map((preset) => {
              const active =
                preset.semitones.length === settings.enabled.length &&
                preset.semitones.every((s) => settings.enabled.includes(s))
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`mn-segment${active ? ' mn-segment-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => applyPreset(preset.semitones)}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <div className="et-chips" role="group" aria-label="Enabled intervals">
            {ALL_INTERVAL_SEMITONES.map((semitones) => {
              const interval = intervalBySemitones(semitones)
              const on = settings.enabled.includes(semitones)
              return (
                <button
                  key={semitones}
                  type="button"
                  className={`et-chip${on ? ' et-chip-on' : ''}`}
                  aria-pressed={on}
                  title={interval.name}
                  onClick={() => toggle(semitones)}
                >
                  {interval.short}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="fnt-prompt" role="status" aria-live="polite">
        <IntervalPrompt question={question} answer={answer} started={started} />
      </div>

      <div className="et-transport">
        <button type="button" className="et-play" onClick={playCurrent}>
          {started ? '▶ Play again' : '▶ Play interval'}
        </button>
      </div>

      <div className="et-answers" role="group" aria-label="Interval answers">
        {enabledSorted.map((semitones) => {
          const interval = intervalBySemitones(semitones)
          const isCorrect = answered && question?.semitones === semitones
          const isWrongChoice = answered && !correct && answer === semitones
          const cls = ['et-answer']
          if (isCorrect) cls.push('et-answer-correct')
          if (isWrongChoice) cls.push('et-answer-wrong')
          return (
            <button
              key={semitones}
              type="button"
              className={cls.join(' ')}
              disabled={answered}
              onClick={() => submit(semitones)}
            >
              <span className="et-answer-short">{interval.short}</span>
              <span className="et-answer-full">{interval.name}</span>
            </button>
          )
        })}
      </div>

      {answered && !correct && question && (
        <div className="et-compare" role="group" aria-label="Replay to compare">
          <p className="fnt-hint">Replay both, then continue.</p>
          <div className="et-compare-row">
            <button
              type="button"
              className="et-compare-btn"
              onClick={() =>
                playInterval({ ...question, semitones: answer })
              }
            >
              Your answer ({intervalBySemitones(answer).short})
            </button>
            <button
              type="button"
              className="et-compare-btn"
              onClick={() => playInterval(question)}
            >
              Correct ({intervalBySemitones(question.semitones).short})
            </button>
          </div>
          <button type="button" className="et-next" onClick={advance}>
            Next question →
          </button>
        </div>
      )}

      <div className="fnt-score">
        <div className="fnt-score-item">
          <span className="fnt-score-value">{stats.streak}</span>
          <span className="fnt-score-label">Streak</span>
        </div>
        <div className="fnt-score-item">
          <span className="fnt-score-value">
            {stats.correct}
            <span className="fnt-score-sep">/</span>
            {stats.answered}
          </span>
          <span className="fnt-score-label">Correct</span>
        </div>
        <div className="fnt-score-item">
          <span className="fnt-score-value">{stats.bestStreak}</span>
          <span className="fnt-score-label">Best streak</span>
        </div>
      </div>

      <IntervalStatsPanel
        enabled={enabledSorted}
        session={sessionStats}
        lifetime={lifetimeStats}
        onReset={resetStats}
      />
    </>
  )
}

interface IntervalPromptProps {
  question: IntervalQuestion | null
  answer: number | null
  started: boolean
}

function IntervalPrompt({ question, answer, started }: IntervalPromptProps) {
  if (!question) return <span className="fnt-prompt-text">Loading…</span>

  if (answer !== null) {
    const correct = answer === question.semitones
    const interval = intervalBySemitones(question.semitones)
    if (correct) {
      return <span className="fnt-prompt-feedback fnt-correct">Correct — {interval.short}!</span>
    }
    return (
      <span className="fnt-prompt-feedback fnt-wrong">
        Not quite — that was {interval.short} ({interval.name}).
      </span>
    )
  }

  if (!started) {
    return <span className="fnt-prompt-text">Press Play to hear the interval, then name it.</span>
  }
  return (
    <span className="fnt-prompt-text">
      What <strong className="fnt-target">interval</strong> did you hear?
    </span>
  )
}

interface IntervalStatsPanelProps {
  enabled: number[]
  session: IntervalStats
  lifetime: IntervalStats
  onReset: () => void
}

/** Compact accuracy chips per enabled interval: session and lifetime tallies. */
function IntervalStatsPanel({ enabled, session, lifetime, onReset }: IntervalStatsPanelProps) {
  return (
    <div className="et-stats">
      <div className="et-stats-head">
        <span className="tool-control-label">Per-interval accuracy</span>
        <button type="button" className="et-reset" onClick={onReset}>
          Reset stats
        </button>
      </div>
      <div className="et-stats-grid">
        {enabled.map((semitones) => {
          const interval = intervalBySemitones(semitones)
          const s = session[semitones]
          const l = lifetime[semitones]
          const sessionAcc = accuracy(s)
          const lifetimeAcc = accuracy(l)
          return (
            <div key={semitones} className="et-stat" title={interval.name}>
              <span className="et-stat-name">{interval.short}</span>
              <span className="et-stat-line">
                <span className="et-stat-tag">Session</span>
                {formatStat(sessionAcc, s?.attempts ?? 0)}
              </span>
              <span className="et-stat-line">
                <span className="et-stat-tag">Lifetime</span>
                {formatStat(lifetimeAcc, l?.attempts ?? 0)}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function formatStat(acc: number | null, attempts: number): React.ReactNode {
  if (acc === null) return <span className="et-stat-empty">—</span>
  return (
    <span className="et-stat-acc">
      {Math.round(acc * 100)}%<span className="et-stat-n"> ({attempts})</span>
    </span>
  )
}
