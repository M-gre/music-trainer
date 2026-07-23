/**
 * Ear Training — by-ear quiz tools, now three sibling modes selected by a
 * top-level segmented control: interval recognition, chord-quality
 * recognition, and scale/mode recognition. All three are thin React shells
 * over pure cores:
 *  - `src/lib/quiz.ts`: `QuizSession` (score/streak), reused by every quiz.
 *  - `src/lib/earTraining.ts`: interval question generation, answer checking,
 *    playback scheduling, per-interval stats, and the persisted
 *    settings/stats stores.
 *  - `src/lib/chordQualityTraining.ts`: the chord-quality equivalent —
 *    question generation (root/quality/inversion), answer checking, the
 *    voicing/arpeggio to play (via `chordExplorer.ts`), per-quality stats,
 *    and its own persisted settings/stats stores.
 *  - `src/lib/scaleRecognitionTraining.ts`: the scale/mode equivalent —
 *    question generation (root register + scale), answer checking, the
 *    ascending/descending note sequence to play, per-scale stats, and its own
 *    persisted settings/stats stores.
 *
 * Structured for the rest of milestone M3: further quizzes are meant to slot
 * in as additional SIBLING MODES here — add them to the segmented control
 * below and render another trainer component. Each mode owns its own
 * settings/stats stores so switching tabs never clobbers another mode's
 * progress. All trainers reuse the same `QuizSession` wiring, the `et-*`
 * styles, the play/replay transport, the multiple-choice grid, and the
 * stats-chip pattern. Audio only ever starts from a user gesture
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
import {
  accumulateStat as accumulateChordQualityStat,
  accuracy as chordQualityAccuracy,
  ALL_QUALITY_IDS,
  checkChordQualityAnswer,
  CHORD_QUALITY_PRESETS,
  chordQualitySettingsStore,
  chordQualityStatsStore,
  generateChordQualityQuestion,
  inversionLabel,
  normalizeChordQualityStats,
  normalizeChordQualityTrainingSettings,
  qualityShort,
  questionArpeggioSteps,
  questionVoicingMidis,
  sortQualityIds,
  toggleQuality,
  type ChordQualityContext,
  type ChordQualityQuestion,
  type ChordQualityStats,
  type ChordQualityTrainingSettings,
} from '../lib/chordQualityTraining.ts'
import { getChordQuality } from '../lib/theory/chords.ts'
import {
  accumulateStat as accumulateScaleStat,
  accuracy as scaleAccuracy,
  ALL_SCALE_IDS,
  checkScaleAnswer,
  DEFAULT_SCALE_STEP_SECONDS,
  generateScaleQuestion,
  normalizeScaleStats,
  normalizeScaleTrainingSettings,
  questionScaleSteps,
  scaleLabel,
  scaleSettingsStore,
  scaleShort,
  scaleStatsStore,
  SCALE_PRESETS,
  sortScaleIds,
  toggleScale,
  type ScaleQuestion,
  type ScaleQuestionContext,
  type ScaleStats,
  type ScaleTrainingSettings,
} from '../lib/scaleRecognitionTraining.ts'
import { getScale } from '../lib/theory/scales.ts'

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

type EarTrainingMode = 'intervals' | 'chord-quality' | 'scales'

const MODE_OPTIONS: { value: EarTrainingMode; label: string }[] = [
  { value: 'intervals', label: 'Intervals' },
  { value: 'chord-quality', label: 'Chord qualities' },
  { value: 'scales', label: 'Scales' },
]

export function EarTraining() {
  // Sibling modes, each a fully separate trainer with its own settings/stats
  // stores (see the file-level notes above); this segmented control is the
  // seam a future scale/mode-recognition quiz slots into.
  const [mode, setMode] = useState<EarTrainingMode>('intervals')

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Ear Training</h1>
        <p className="tool-page-lead">
          Train your ear to name intervals, chord qualities, and scales/modes. Sound plays only
          after you press Play.
        </p>
      </div>

      <div className="mn-segmented" role="tablist" aria-label="Ear training mode">
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={mode === option.value}
            className={`mn-segment${mode === option.value ? ' mn-segment-active' : ''}`}
            onClick={() => setMode(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>

      {mode === 'intervals' && <IntervalTrainer />}
      {mode === 'chord-quality' && <ChordQualityTrainer />}
      {mode === 'scales' && <ScaleTrainer />}
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

// --- Chord quality recognition (sibling mode) -------------------------------

/** Block-chord playback duration (seconds); a touch longer than a melodic note so the quality settles. */
const CHORD_DURATION = 1.4
/** Per-note duration when replaying the chord as an arpeggio. */
const ARPEGGIO_NOTE_DURATION = 0.55
/** Spacing between arpeggio notes (seconds). */
const ARPEGGIO_STEP_SECONDS = 0.24
/** How long a correct answer stays up before auto-advancing (ms). */
const ADVANCE_MS_CORRECT_CHORD = 1000

function ChordQualityTrainer() {
  const engineRef = useRef(getAudioEngine())
  const advanceTimeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<ChordQualityTrainingSettings>(() =>
    normalizeChordQualityTrainingSettings(chordQualitySettingsStore.get()),
  )
  useEffect(() => {
    chordQualitySettingsStore.set(settings)
  }, [settings])

  // Live context read by the (stable) question generator.
  const context: ChordQualityContext = {
    enabled: settings.enabled,
    inversions: settings.inversions,
  }
  const contextRef = useRef(context)
  contextRef.current = context

  const sessionRef = useRef<QuizSession<ChordQualityQuestion, string> | null>(null)
  const [question, setQuestion] = useState<ChordQualityQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [answer, setAnswer] = useState<string | null>(null)
  /** True once the user has made the first audio gesture (enables auto-play). */
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)

  const [sessionStats, setSessionStats] = useState<ChordQualityStats>({})
  const [lifetimeStats, setLifetimeStats] = useState<ChordQualityStats>(() =>
    normalizeChordQualityStats(chordQualityStatsStore.get()),
  )

  const clearAdvance = useCallback(() => {
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current)
      advanceTimeoutRef.current = null
    }
  }, [])

  /** Play a question's voicing as a block chord. */
  const playBlock = useCallback((q: ChordQualityQuestion) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      engine.playChord(questionVoicingMidis(q), CHORD_DURATION, { when: engine.currentTime })
    })
  }, [])

  /** Replay a question's voicing as a timed up-then-down arpeggio. */
  const playArpeggio = useCallback((q: ChordQualityQuestion) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      const now = engine.currentTime
      for (const step of questionArpeggioSteps(q, ARPEGGIO_STEP_SECONDS, now, true)) {
        engine.playNote(step.midi, ARPEGGIO_NOTE_DURATION, { when: step.when })
      }
    })
  }, [])

  const markStarted = useCallback(() => {
    if (!startedRef.current) {
      startedRef.current = true
      setStarted(true)
    }
  }, [])

  const playCurrent = useCallback(() => {
    const q = sessionRef.current?.current
    if (!q) return
    markStarted()
    playBlock(q)
  }, [markStarted, playBlock])

  const playCurrentArpeggio = useCallback(() => {
    const q = sessionRef.current?.current
    if (!q) return
    markStarted()
    playArpeggio(q)
  }, [markStarted, playArpeggio])

  // (Re)start a session whenever the answerable set changes (enabled
  // qualities or the inversions setting). Auto-plays the fresh question only
  // if already started.
  const contextKey = `${settings.enabled.join(',')}|${settings.inversions}`
  useEffect(() => {
    clearAdvance()
    const session = new QuizSession<ChordQualityQuestion, string>({
      generate: (previous, rng) => generateChordQualityQuestion(contextRef.current, previous, rng),
      check: checkChordQualityAnswer,
    })
    sessionRef.current = session
    session.next()
    setQuestion(session.current)
    setStats(session.stats)
    setAnswer(null)
    if (startedRef.current && session.current) playBlock(session.current)
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
    if (startedRef.current && session.current) playBlock(session.current)
  }, [clearAdvance, playBlock])

  const submit = useCallback(
    (picked: string) => {
      const session = sessionRef.current
      const q = session?.current
      if (!session || !q || session.isAnswered) return
      const res = session.answer(picked)
      setAnswer(picked)
      setStats(session.stats)

      setSessionStats((s) => accumulateChordQualityStat(s, q.qualityId, res.correct))
      setLifetimeStats((s) => {
        const next = accumulateChordQualityStat(s, q.qualityId, res.correct)
        chordQualityStatsStore.set(next)
        return next
      })

      if (res.correct) {
        clearAdvance()
        advanceTimeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT_CHORD)
      }
    },
    [advance, clearAdvance],
  )

  const resetStats = useCallback(() => {
    setSessionStats({})
    setLifetimeStats({})
    chordQualityStatsStore.set({})
  }, [])

  const answered = answer !== null
  const correct = answered && question !== null && answer === question.qualityId

  const enabledSorted = useMemo(() => sortQualityIds(settings.enabled), [settings.enabled])

  const applyPreset = (qualityIds: string[]): void =>
    setSettings((s) => ({ ...s, enabled: [...qualityIds] }))

  const toggle = (qualityId: string): void =>
    setSettings((s) => ({ ...s, enabled: toggleQuality(s.enabled, qualityId) }))

  const setInversions = (on: boolean): void => setSettings((s) => ({ ...s, inversions: on }))

  return (
    <>
      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Quality set</span>
          <div className="mn-segmented" role="group" aria-label="Chord quality presets">
            {CHORD_QUALITY_PRESETS.map((preset) => {
              const active =
                preset.qualityIds.length === settings.enabled.length &&
                preset.qualityIds.every((id) => settings.enabled.includes(id))
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`mn-segment${active ? ' mn-segment-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => applyPreset(preset.qualityIds)}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <div className="et-chips" role="group" aria-label="Enabled chord qualities">
            {ALL_QUALITY_IDS.map((id) => {
              const quality = getChordQuality(id)
              const on = settings.enabled.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  className={`et-chip${on ? ' et-chip-on' : ''}`}
                  aria-pressed={on}
                  title={quality.name}
                  onClick={() => toggle(id)}
                >
                  {qualityShort(quality)}
                </button>
              )
            })}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Difficulty</span>
          <div className="mn-segmented" role="group" aria-label="Inversions setting">
            <button
              type="button"
              className={`mn-segment${settings.inversions ? ' mn-segment-active' : ''}`}
              aria-pressed={settings.inversions}
              onClick={() => setInversions(!settings.inversions)}
            >
              Include inversions (harder)
            </button>
          </div>
        </div>
      </div>

      <div className="fnt-prompt" role="status" aria-live="polite">
        <ChordQualityPrompt question={question} answer={answer} started={started} />
      </div>

      <div className="et-transport">
        <button type="button" className="et-play" onClick={playCurrent}>
          {started ? '▶ Play again' : '▶ Play chord'}
        </button>
        <button type="button" className="et-play-secondary" onClick={playCurrentArpeggio}>
          Play as arpeggio
        </button>
      </div>

      <div className="et-answers" role="group" aria-label="Chord quality answers">
        {enabledSorted.map((id) => {
          const quality = getChordQuality(id)
          const isCorrect = answered && question?.qualityId === id
          const isWrongChoice = answered && !correct && answer === id
          const cls = ['et-answer']
          if (isCorrect) cls.push('et-answer-correct')
          if (isWrongChoice) cls.push('et-answer-wrong')
          return (
            <button
              key={id}
              type="button"
              className={cls.join(' ')}
              disabled={answered}
              onClick={() => submit(id)}
            >
              <span className="et-answer-short">{qualityShort(quality)}</span>
              <span className="et-answer-full">{quality.name}</span>
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
              onClick={() => playBlock({ ...question, qualityId: answer })}
            >
              Your answer ({qualityShort(getChordQuality(answer))})
            </button>
            <button type="button" className="et-compare-btn" onClick={() => playBlock(question)}>
              Correct ({qualityShort(getChordQuality(question.qualityId))})
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

      <ChordQualityStatsPanel
        enabled={enabledSorted}
        session={sessionStats}
        lifetime={lifetimeStats}
        onReset={resetStats}
      />
    </>
  )
}

interface ChordQualityPromptProps {
  question: ChordQualityQuestion | null
  answer: string | null
  started: boolean
}

function ChordQualityPrompt({ question, answer, started }: ChordQualityPromptProps) {
  if (!question) return <span className="fnt-prompt-text">Loading…</span>

  if (answer !== null) {
    const correct = answer === question.qualityId
    const quality = getChordQuality(question.qualityId)
    const detail = question.inversion > 0 ? ` — ${inversionLabel(question.inversion)}` : ''
    if (correct) {
      return (
        <span className="fnt-prompt-feedback fnt-correct">
          Correct — {qualityShort(quality)} ({quality.name}){detail}!
        </span>
      )
    }
    return (
      <span className="fnt-prompt-feedback fnt-wrong">
        Not quite — that was {qualityShort(quality)} ({quality.name}){detail}.
      </span>
    )
  }

  if (!started) {
    return <span className="fnt-prompt-text">Press Play to hear the chord, then name its quality.</span>
  }
  return (
    <span className="fnt-prompt-text">
      What <strong className="fnt-target">chord quality</strong> did you hear?
    </span>
  )
}

interface ChordQualityStatsPanelProps {
  enabled: string[]
  session: ChordQualityStats
  lifetime: ChordQualityStats
  onReset: () => void
}

/** Compact accuracy chips per enabled quality: session and lifetime tallies. */
function ChordQualityStatsPanel({ enabled, session, lifetime, onReset }: ChordQualityStatsPanelProps) {
  return (
    <div className="et-stats">
      <div className="et-stats-head">
        <span className="tool-control-label">Per-quality accuracy</span>
        <button type="button" className="et-reset" onClick={onReset}>
          Reset stats
        </button>
      </div>
      <div className="et-stats-grid">
        {enabled.map((id) => {
          const quality = getChordQuality(id)
          const s = session[id]
          const l = lifetime[id]
          const sessionAcc = chordQualityAccuracy(s)
          const lifetimeAcc = chordQualityAccuracy(l)
          return (
            <div key={id} className="et-stat" title={quality.name}>
              <span className="et-stat-name">{qualityShort(quality)}</span>
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

// --- Scale/mode recognition (sibling mode) ----------------------------------

/** Per-note duration when playing the scale (seconds); a touch longer than the
 * step spacing so consecutive notes overlap slightly for a legato feel. */
const SCALE_NOTE_DURATION = 0.35
/** How long a correct answer stays up before auto-advancing (ms). */
const ADVANCE_MS_CORRECT_SCALE = 1000

function ScaleTrainer() {
  const engineRef = useRef(getAudioEngine())
  const advanceTimeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<ScaleTrainingSettings>(() =>
    normalizeScaleTrainingSettings(scaleSettingsStore.get()),
  )
  useEffect(() => {
    scaleSettingsStore.set(settings)
  }, [settings])

  // Live context read by the (stable) question generator.
  const context: ScaleQuestionContext = { enabled: settings.enabled }
  const contextRef = useRef(context)
  contextRef.current = context

  const sessionRef = useRef<QuizSession<ScaleQuestion, string> | null>(null)
  const [question, setQuestion] = useState<ScaleQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [answer, setAnswer] = useState<string | null>(null)
  /** True once the user has made the first audio gesture (enables auto-play). */
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)

  const [sessionStats, setSessionStats] = useState<ScaleStats>({})
  const [lifetimeStats, setLifetimeStats] = useState<ScaleStats>(() =>
    normalizeScaleStats(scaleStatsStore.get()),
  )

  const clearAdvance = useCallback(() => {
    if (advanceTimeoutRef.current !== null) {
      window.clearTimeout(advanceTimeoutRef.current)
      advanceTimeoutRef.current = null
    }
  }, [])

  /** Play a question's scale ascending (root through the octave above). */
  const playAscending = useCallback((q: ScaleQuestion) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      const now = engine.currentTime
      for (const step of questionScaleSteps(q, DEFAULT_SCALE_STEP_SECONDS, now, false)) {
        engine.playNote(step.midi, SCALE_NOTE_DURATION, { when: step.when })
      }
    })
  }, [])

  /** Replay a question's scale descending — the harder "hear it backwards" option. */
  const playDescending = useCallback((q: ScaleQuestion) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      const now = engine.currentTime
      for (const step of questionScaleSteps(q, DEFAULT_SCALE_STEP_SECONDS, now, true)) {
        engine.playNote(step.midi, SCALE_NOTE_DURATION, { when: step.when })
      }
    })
  }, [])

  const markStarted = useCallback(() => {
    if (!startedRef.current) {
      startedRef.current = true
      setStarted(true)
    }
  }, [])

  const playCurrent = useCallback(() => {
    const q = sessionRef.current?.current
    if (!q) return
    markStarted()
    playAscending(q)
  }, [markStarted, playAscending])

  const playCurrentDescending = useCallback(() => {
    const q = sessionRef.current?.current
    if (!q) return
    markStarted()
    playDescending(q)
  }, [markStarted, playDescending])

  // (Re)start a session whenever the enabled scale set changes. Auto-plays
  // the fresh question only if already started.
  const contextKey = settings.enabled.join(',')
  useEffect(() => {
    clearAdvance()
    const session = new QuizSession<ScaleQuestion, string>({
      generate: (previous, rng) => generateScaleQuestion(contextRef.current, previous, rng),
      check: checkScaleAnswer,
    })
    sessionRef.current = session
    session.next()
    setQuestion(session.current)
    setStats(session.stats)
    setAnswer(null)
    if (startedRef.current && session.current) playAscending(session.current)
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
    if (startedRef.current && session.current) playAscending(session.current)
  }, [clearAdvance, playAscending])

  const submit = useCallback(
    (picked: string) => {
      const session = sessionRef.current
      const q = session?.current
      if (!session || !q || session.isAnswered) return
      const res = session.answer(picked)
      setAnswer(picked)
      setStats(session.stats)

      setSessionStats((s) => accumulateScaleStat(s, q.scaleId, res.correct))
      setLifetimeStats((s) => {
        const next = accumulateScaleStat(s, q.scaleId, res.correct)
        scaleStatsStore.set(next)
        return next
      })

      if (res.correct) {
        clearAdvance()
        advanceTimeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT_SCALE)
      }
    },
    [advance, clearAdvance],
  )

  const resetStats = useCallback(() => {
    setSessionStats({})
    setLifetimeStats({})
    scaleStatsStore.set({})
  }, [])

  const answered = answer !== null
  const correct = answered && question !== null && answer === question.scaleId

  const enabledSorted = useMemo(() => sortScaleIds(settings.enabled), [settings.enabled])

  const applyPreset = (scaleIds: string[]): void => setSettings((s) => ({ ...s, enabled: [...scaleIds] }))

  const toggle = (scaleId: string): void =>
    setSettings((s) => ({ ...s, enabled: toggleScale(s.enabled, scaleId) }))

  return (
    <>
      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Scale set</span>
          <div className="mn-segmented" role="group" aria-label="Scale presets">
            {SCALE_PRESETS.map((preset) => {
              const active =
                preset.scaleIds.length === settings.enabled.length &&
                preset.scaleIds.every((id) => settings.enabled.includes(id))
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`mn-segment${active ? ' mn-segment-active' : ''}`}
                  aria-pressed={active}
                  onClick={() => applyPreset(preset.scaleIds)}
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <div className="et-chips" role="group" aria-label="Enabled scales">
            {ALL_SCALE_IDS.map((id) => {
              const scale = getScale(id)
              const on = settings.enabled.includes(id)
              return (
                <button
                  key={id}
                  type="button"
                  className={`et-chip${on ? ' et-chip-on' : ''}`}
                  aria-pressed={on}
                  title={scale.name}
                  onClick={() => toggle(id)}
                >
                  {scaleShort(scale)}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="fnt-prompt" role="status" aria-live="polite">
        <ScalePrompt question={question} answer={answer} started={started} />
      </div>

      <div className="et-transport">
        <button type="button" className="et-play" onClick={playCurrent}>
          {started ? '▶ Play again' : '▶ Play scale'}
        </button>
        <button type="button" className="et-play-secondary" onClick={playCurrentDescending}>
          Play descending
        </button>
      </div>

      <div className="et-answers" role="group" aria-label="Scale answers">
        {enabledSorted.map((id) => {
          const scale = getScale(id)
          const isCorrect = answered && question?.scaleId === id
          const isWrongChoice = answered && !correct && answer === id
          const cls = ['et-answer']
          if (isCorrect) cls.push('et-answer-correct')
          if (isWrongChoice) cls.push('et-answer-wrong')
          return (
            <button
              key={id}
              type="button"
              className={cls.join(' ')}
              disabled={answered}
              onClick={() => submit(id)}
            >
              <span className="et-answer-short">{scaleShort(scale)}</span>
              <span className="et-answer-full">{scaleLabel(scale)}</span>
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
              onClick={() => playAscending({ ...question, scaleId: answer })}
            >
              Your answer ({scaleShort(getScale(answer))})
            </button>
            <button type="button" className="et-compare-btn" onClick={() => playAscending(question)}>
              Correct ({scaleShort(getScale(question.scaleId))})
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

      <ScaleStatsPanel
        enabled={enabledSorted}
        session={sessionStats}
        lifetime={lifetimeStats}
        onReset={resetStats}
      />
    </>
  )
}

interface ScalePromptProps {
  question: ScaleQuestion | null
  answer: string | null
  started: boolean
}

function ScalePrompt({ question, answer, started }: ScalePromptProps) {
  if (!question) return <span className="fnt-prompt-text">Loading…</span>

  if (answer !== null) {
    const correct = answer === question.scaleId
    const scale = getScale(question.scaleId)
    if (correct) {
      return (
        <span className="fnt-prompt-feedback fnt-correct">
          Correct — {scaleShort(scale)} ({scale.name})!
        </span>
      )
    }
    return (
      <span className="fnt-prompt-feedback fnt-wrong">
        Not quite — that was {scaleShort(scale)} ({scale.name}).
      </span>
    )
  }

  if (!started) {
    return <span className="fnt-prompt-text">Press Play to hear the scale, then name it.</span>
  }
  return (
    <span className="fnt-prompt-text">
      What <strong className="fnt-target">scale or mode</strong> did you hear?
    </span>
  )
}

interface ScaleStatsPanelProps {
  enabled: string[]
  session: ScaleStats
  lifetime: ScaleStats
  onReset: () => void
}

/** Compact accuracy chips per enabled scale: session and lifetime tallies. */
function ScaleStatsPanel({ enabled, session, lifetime, onReset }: ScaleStatsPanelProps) {
  return (
    <div className="et-stats">
      <div className="et-stats-head">
        <span className="tool-control-label">Per-scale accuracy</span>
        <button type="button" className="et-reset" onClick={onReset}>
          Reset stats
        </button>
      </div>
      <div className="et-stats-grid">
        {enabled.map((id) => {
          const scale = getScale(id)
          const s = session[id]
          const l = lifetime[id]
          const sessionAcc = scaleAccuracy(s)
          const lifetimeAcc = scaleAccuracy(l)
          return (
            <div key={id} className="et-stat" title={scale.name}>
              <span className="et-stat-name">{scaleShort(scale)}</span>
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
