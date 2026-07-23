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
  intervalSrsKey,
  intervalSrsStore,
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
  chordQualitySrsKey,
  chordQualitySrsStore,
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
  scaleSrsKey,
  scaleSrsStore,
  scaleStatsStore,
  SCALE_PRESETS,
  sortScaleIds,
  toggleScale,
  type ScaleQuestion,
  type ScaleQuestionContext,
  type ScaleStats,
  type ScaleTrainingSettings,
} from '../lib/scaleRecognitionTraining.ts'
import {
  normalizeSrsData,
  qualityFromOutcome,
  reviewKey,
  type SrsData,
} from '../lib/spacedRepetition.ts'
import { getScale } from '../lib/theory/scales.ts'
import { Fretboard, type FretboardMarker } from '../components/Fretboard.tsx'
import { Keyboard, type KeyboardMarker } from '../components/Keyboard.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { fretMidi } from '../lib/theory/instruments.ts'
import { midiToName, midiToPc, pcToName, type PitchClass } from '../lib/theory/notes.ts'
import {
  accumulateStat as accumulateEchoStat,
  accuracy as echoAccuracy,
  ALL_ROOT_PCS,
  DEFAULT_STEP_SECONDS as ECHO_STEP_SECONDS,
  EMPTY_MELODIC_ECHO_STATS,
  generateMelodicEchoQuestion,
  initialEchoState,
  INPUT_MODE_OPTIONS,
  MAX_LENGTH,
  melodicEchoSettingsStore,
  melodicEchoStatsStore,
  MIN_LENGTH,
  normalizeMelodicEchoSettings,
  normalizeMelodicEchoStats,
  phraseLength,
  questionPhraseSteps,
  submitEchoNote,
  type EchoInputMode,
  type EchoScaleType,
  type EchoState,
  type MatchMode,
  type MelodicEchoContext,
  type MelodicEchoQuestion,
  type MelodicEchoSettings,
  type MelodicEchoStats,
} from '../lib/melodicEchoTraining.ts'
import {
  EAR_TRAINING_LEVELS,
  earTrainingLevelsProgressStore,
  isLevelUnlocked,
  levelProgressSummary,
  normalizeLevelProgressMap,
  recommendedLevelId,
  recordLevelAnswer,
  type EarTrainingLevel,
  type LevelProgressMap,
} from '../lib/earTrainingLevels.ts'

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

type EarTrainingMode = 'intervals' | 'chord-quality' | 'scales' | 'melodic-echo' | 'levels'

const MODE_OPTIONS: { value: EarTrainingMode; label: string }[] = [
  { value: 'intervals', label: 'Intervals' },
  { value: 'chord-quality', label: 'Chord qualities' },
  { value: 'scales', label: 'Scales' },
  { value: 'melodic-echo', label: 'Melodic echo' },
  { value: 'levels', label: 'Levels' },
]

export function EarTraining() {
  // Sibling modes, each a fully separate trainer with its own settings/stats
  // stores (see the file-level notes above); this segmented control is the
  // seam a future scale/mode-recognition quiz slots into. "Levels" is a
  // curriculum built on top of the same four trainers rather than a fifth
  // quiz core of its own — see `LevelsTrainer` below and `earTrainingLevels.ts`.
  const [mode, setMode] = useState<EarTrainingMode>('intervals')

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Ear Training</h1>
        <p className="tool-page-lead">
          Train your ear to name intervals, chord qualities, and scales/modes, or echo a phrase back
          by ear. Sound plays only after you press Play.
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
      {mode === 'melodic-echo' && <MelodicEchoTrainer />}
      {mode === 'levels' && <LevelsTrainer />}
    </div>
  )
}

interface IntervalTrainerProps {
  /**
   * When set, this trainer runs in "Levels" mode: the interval set/playback
   * are fixed to a level's config (no preset/chip editors, no persistence to
   * the free-play settings store) and `onAnswer` is notified of every grade
   * in addition to the usual per-interval stats.
   */
  fixedSettings?: EarTrainingSettings
  onAnswer?: (correct: boolean) => void
}

function IntervalTrainer({ fixedSettings, onAnswer }: IntervalTrainerProps = {}) {
  const engineRef = useRef(getAudioEngine())
  const advanceTimeoutRef = useRef<number | null>(null)
  const levelMode = fixedSettings !== undefined

  const [settings, setSettings] = useState<EarTrainingSettings>(
    () => fixedSettings ?? normalizeEarTrainingSettings(earTrainingSettingsStore.get()),
  )
  useEffect(() => {
    if (!levelMode) earTrainingSettingsStore.set(settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Spaced-repetition schedule (per interval + playback mode); biases question
  // picking toward the items that are due for review.
  const [srs, setSrs] = useState<SrsData>(() => normalizeSrsData(intervalSrsStore.get()))
  const srsRef = useRef(srs)
  srsRef.current = srs

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
      generate: (previous, rng) =>
        generateIntervalQuestion(contextRef.current, previous, rng, {
          srs: srsRef.current,
          now: Date.now(),
        }),
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
      setSrs(
        intervalSrsStore.update((d) =>
          reviewKey(
            d,
            intervalSrsKey(q.semitones, q.mode),
            qualityFromOutcome(res.correct, res.responseMs),
            Date.now(),
          ),
        ),
      )
      onAnswer?.(res.correct)

      if (res.correct) {
        clearAdvance()
        advanceTimeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT)
      }
    },
    [advance, clearAdvance, onAnswer],
  )

  const resetStats = useCallback(() => {
    setSessionStats({})
    setLifetimeStats({})
    intervalStatsStore.set({})
    intervalSrsStore.clear()
    setSrs({})
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
      {!levelMode && (
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
      )}

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

interface ChordQualityTrainerProps {
  /** See `IntervalTrainerProps.fixedSettings` — same "Levels" mode contract. */
  fixedSettings?: ChordQualityTrainingSettings
  onAnswer?: (correct: boolean) => void
}

function ChordQualityTrainer({ fixedSettings, onAnswer }: ChordQualityTrainerProps = {}) {
  const engineRef = useRef(getAudioEngine())
  const advanceTimeoutRef = useRef<number | null>(null)
  const levelMode = fixedSettings !== undefined

  const [settings, setSettings] = useState<ChordQualityTrainingSettings>(
    () => fixedSettings ?? normalizeChordQualityTrainingSettings(chordQualitySettingsStore.get()),
  )
  useEffect(() => {
    if (!levelMode) chordQualitySettingsStore.set(settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Spaced-repetition schedule (per quality); biases picking toward due items.
  const [srs, setSrs] = useState<SrsData>(() => normalizeSrsData(chordQualitySrsStore.get()))
  const srsRef = useRef(srs)
  srsRef.current = srs

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
      generate: (previous, rng) =>
        generateChordQualityQuestion(contextRef.current, previous, rng, {
          srs: srsRef.current,
          now: Date.now(),
        }),
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
      setSrs(
        chordQualitySrsStore.update((d) =>
          reviewKey(
            d,
            chordQualitySrsKey(q.qualityId),
            qualityFromOutcome(res.correct, res.responseMs),
            Date.now(),
          ),
        ),
      )
      onAnswer?.(res.correct)

      if (res.correct) {
        clearAdvance()
        advanceTimeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT_CHORD)
      }
    },
    [advance, clearAdvance, onAnswer],
  )

  const resetStats = useCallback(() => {
    setSessionStats({})
    setLifetimeStats({})
    chordQualityStatsStore.set({})
    chordQualitySrsStore.clear()
    setSrs({})
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
      {!levelMode && (
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
      )}

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

interface ScaleTrainerProps {
  /** See `IntervalTrainerProps.fixedSettings` — same "Levels" mode contract. */
  fixedSettings?: ScaleTrainingSettings
  onAnswer?: (correct: boolean) => void
}

function ScaleTrainer({ fixedSettings, onAnswer }: ScaleTrainerProps = {}) {
  const engineRef = useRef(getAudioEngine())
  const advanceTimeoutRef = useRef<number | null>(null)
  const levelMode = fixedSettings !== undefined

  const [settings, setSettings] = useState<ScaleTrainingSettings>(
    () => fixedSettings ?? normalizeScaleTrainingSettings(scaleSettingsStore.get()),
  )
  useEffect(() => {
    if (!levelMode) scaleSettingsStore.set(settings)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  // Spaced-repetition schedule (per scale); biases picking toward due items.
  const [srs, setSrs] = useState<SrsData>(() => normalizeSrsData(scaleSrsStore.get()))
  const srsRef = useRef(srs)
  srsRef.current = srs

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
      generate: (previous, rng) =>
        generateScaleQuestion(contextRef.current, previous, rng, {
          srs: srsRef.current,
          now: Date.now(),
        }),
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
      setSrs(
        scaleSrsStore.update((d) =>
          reviewKey(
            d,
            scaleSrsKey(q.scaleId),
            qualityFromOutcome(res.correct, res.responseMs),
            Date.now(),
          ),
        ),
      )
      onAnswer?.(res.correct)

      if (res.correct) {
        clearAdvance()
        advanceTimeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT_SCALE)
      }
    },
    [advance, clearAdvance, onAnswer],
  )

  const resetStats = useCallback(() => {
    setSessionStats({})
    setLifetimeStats({})
    scaleStatsStore.set({})
    scaleSrsStore.clear()
    setSrs({})
  }, [])

  const answered = answer !== null
  const correct = answered && question !== null && answer === question.scaleId

  const enabledSorted = useMemo(() => sortScaleIds(settings.enabled), [settings.enabled])

  const applyPreset = (scaleIds: string[]): void => setSettings((s) => ({ ...s, enabled: [...scaleIds] }))

  const toggle = (scaleId: string): void =>
    setSettings((s) => ({ ...s, enabled: toggleScale(s.enabled, scaleId) }))

  return (
    <>
      {!levelMode && (
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
      )}

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

// --- Melodic echo (sibling mode) --------------------------------------------

/** Per-note duration when playing back the phrase (seconds). */
const ECHO_NOTE_DURATION = 0.55
/** Fretboard fret range the phrase is echoed within. */
const ECHO_FROM_FRET = 0
const ECHO_TO_FRET = 12
/** Spelling used for phrase note labels/feedback. */
const ECHO_PREFER = 'sharp' as const

const ECHO_INPUT_LABEL: Record<EchoInputMode, string> = {
  fretboard: 'Fretboard',
  keyboard: 'Keyboard',
}

const ECHO_SCALE_LABEL: Record<EchoScaleType, string> = {
  major: 'Major',
  minor: 'Minor',
}

const ECHO_LENGTHS: readonly number[] = Array.from(
  { length: MAX_LENGTH - MIN_LENGTH + 1 },
  (_, i) => MIN_LENGTH + i,
)

interface MelodicEchoTrainerProps {
  /**
   * See `IntervalTrainerProps.fixedSettings` — same "Levels" mode contract,
   * but narrower: only the phrase's difficulty (length/key/scale) is fixed
   * by the level. The input instrument (`inputMode`) stays the player's own
   * free-play preference either way, since it's an interaction choice, not a
   * difficulty knob.
   */
  fixedSettings?: Pick<MelodicEchoSettings, 'length' | 'rootPc' | 'scaleType'>
  onAnswer?: (correct: boolean) => void
}

function MelodicEchoTrainer({ fixedSettings, onAnswer }: MelodicEchoTrainerProps = {}) {
  const { tuning } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())
  const levelMode = fixedSettings !== undefined

  const [settings, setSettings] = useState<MelodicEchoSettings>(() => {
    const stored = normalizeMelodicEchoSettings(melodicEchoSettingsStore.get())
    return fixedSettings ? { ...stored, ...fixedSettings } : stored
  })
  useEffect(() => {
    if (levelMode) {
      // Only the input-instrument preference is shared with free play here;
      // length/root/scale come from the level and are never persisted.
      melodicEchoSettingsStore.update((s) => ({ ...s, inputMode: settings.inputMode }))
    } else {
      melodicEchoSettingsStore.set(settings)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings])

  // Live context read by the (stable) question generator.
  const context: MelodicEchoContext = {
    length: settings.length,
    rootPc: settings.rootPc,
    scaleType: settings.scaleType,
  }
  const contextRef = useRef(context)
  contextRef.current = context

  const sessionRef = useRef<QuizSession<MelodicEchoQuestion, boolean> | null>(null)
  const [question, setQuestion] = useState<MelodicEchoQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [echoState, setEchoState] = useState<EchoState>(initialEchoState)
  /** Concrete positions the player has echoed correctly this run, for markers. */
  const [progressMarks, setProgressMarks] = useState<FretboardMarker[]>([])
  const [progressMidis, setProgressMidis] = useState<number[]>([])
  const [feedback, setFeedback] = useState<{ expected: number; played: number } | null>(null)
  const [done, setDone] = useState(false)
  const [lastClean, setLastClean] = useState(false)
  /** True once the user has made the first audio gesture (enables auto-play). */
  const [started, setStarted] = useState(false)
  const startedRef = useRef(false)

  const [sessionStats, setSessionStats] = useState<MelodicEchoStats>(EMPTY_MELODIC_ECHO_STATS)
  const [lifetimeStats, setLifetimeStats] = useState<MelodicEchoStats>(() =>
    normalizeMelodicEchoStats(melodicEchoStatsStore.get()),
  )

  const matchMode: MatchMode = settings.inputMode === 'keyboard' ? 'exact' : 'pitch-class'

  const playPhrase = useCallback((q: MelodicEchoQuestion) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      const now = engine.currentTime
      for (const step of questionPhraseSteps(q, ECHO_STEP_SECONDS, now)) {
        engine.playNote(step.midi, ECHO_NOTE_DURATION, { when: now + step.when })
      }
    })
  }, [])

  const playSingle = useCallback((midi: number) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      engine.playNote(midi, ECHO_NOTE_DURATION, { when: engine.currentTime })
    })
  }, [])

  const resetAttempt = useCallback(() => {
    setEchoState(initialEchoState())
    setProgressMarks([])
    setProgressMidis([])
    setFeedback(null)
    setDone(false)
  }, [])

  // (Re)start a session whenever the phrase parameters change (length, key,
  // scale) or the input instrument. Auto-plays the fresh phrase only if the
  // user has already made an audio gesture.
  const contextKey = `${settings.length}|${settings.rootPc}|${settings.scaleType}|${settings.inputMode}`
  useEffect(() => {
    const session = new QuizSession<MelodicEchoQuestion, boolean>({
      generate: (previous, rng) => generateMelodicEchoQuestion(contextRef.current, previous, rng),
      check: (_q, clean) => clean,
    })
    sessionRef.current = session
    session.next()
    setQuestion(session.current)
    setStats(session.stats)
    resetAttempt()
    if (startedRef.current && session.current) playPhrase(session.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey])

  const markStarted = useCallback(() => {
    if (!startedRef.current) {
      startedRef.current = true
      setStarted(true)
    }
  }, [])

  const replay = useCallback(() => {
    const q = sessionRef.current?.current
    if (!q) return
    markStarted()
    playPhrase(q)
  }, [markStarted, playPhrase])

  const advance = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    session.next()
    setQuestion(session.current)
    resetAttempt()
    if (startedRef.current && session.current) playPhrase(session.current)
  }, [playPhrase, resetAttempt])

  const handleNote = useCallback(
    (midi: number, mark: FretboardMarker | null) => {
      const session = sessionRef.current
      const q = session?.current
      if (!session || !q || done) return
      markStarted()
      const res = submitEchoNote(q, echoState, midi, matchMode)
      playSingle(midi)

      if (res.result === 'wrong') {
        setFeedback({ expected: res.expected, played: midi })
        setEchoState(res.state)
        setProgressMarks([])
        setProgressMidis([])
        return
      }

      setFeedback(null)
      setEchoState(res.state)
      if (mark) setProgressMarks((m) => [...m, mark])
      setProgressMidis((m) => [...m, midi])

      if (res.complete) {
        session.answer(res.clean)
        setStats(session.stats)
        setDone(true)
        setLastClean(res.clean)
        const streak = session.stats.streak
        setSessionStats((s) => accumulateEchoStat(s, res.clean, streak))
        setLifetimeStats((s) => {
          const next = accumulateEchoStat(s, res.clean, streak)
          melodicEchoStatsStore.set(next)
          return next
        })
        onAnswer?.(res.clean)
      }
    },
    [done, echoState, matchMode, markStarted, onAnswer, playSingle],
  )

  const resetStats = useCallback(() => {
    setSessionStats(EMPTY_MELODIC_ECHO_STATS)
    setLifetimeStats(EMPTY_MELODIC_ECHO_STATS)
    melodicEchoStatsStore.set(EMPTY_MELODIC_ECHO_STATS)
  }, [])

  const setLength = (length: number): void => setSettings((s) => ({ ...s, length }))
  const setRootPc = (rootPc: PitchClass): void => setSettings((s) => ({ ...s, rootPc }))
  const setScaleType = (scaleType: EchoScaleType): void => setSettings((s) => ({ ...s, scaleType }))
  const setInputMode = (inputMode: EchoInputMode): void => setSettings((s) => ({ ...s, inputMode }))

  const total = question ? phraseLength(question) : 0
  const referenceMidi = question?.midis[0] ?? null

  // Fretboard markers: the starting-reference note (all matching pitch-class
  // positions in range, dim) plus the positions echoed correctly so far.
  const fretMarkers = useMemo<FretboardMarker[]>(() => {
    if (!question) return []
    const byKey = new Map<string, FretboardMarker>()
    if (referenceMidi !== null && echoState.matched === 0) {
      const refPc = midiToPc(referenceMidi)
      for (let s = 0; s < tuning.strings.length; s += 1) {
        for (let f = ECHO_FROM_FRET; f <= ECHO_TO_FRET; f += 1) {
          const midi = fretMidi(tuning, s, f)
          if (midiToPc(midi) === refPc) {
            byKey.set(`${s}:${f}`, {
              string: s,
              fret: f,
              variant: 'dim',
              label: pcToName(refPc, ECHO_PREFER),
            })
          }
        }
      }
    }
    for (const m of progressMarks) {
      byKey.set(`${m.string}:${m.fret}`, { ...m, variant: 'correct' })
    }
    return [...byKey.values()]
  }, [question, referenceMidi, echoState.matched, progressMarks, tuning])

  // Keyboard markers: the starting-reference key (dim) plus echoed keys.
  const keyMarkers = useMemo<KeyboardMarker[]>(() => {
    if (!question) return []
    const byMidi = new Map<number, KeyboardMarker>()
    if (referenceMidi !== null && echoState.matched === 0) {
      byMidi.set(referenceMidi, {
        midi: referenceMidi,
        variant: 'dim',
        label: midiToName(referenceMidi, ECHO_PREFER),
      })
    }
    for (const midi of progressMidis) {
      byMidi.set(midi, { midi, variant: 'correct', label: midiToName(midi, ECHO_PREFER) })
    }
    return [...byMidi.values()]
  }, [question, referenceMidi, echoState.matched, progressMidis])

  const keyboardRange = useMemo(() => {
    if (!question) return { from: 60, to: 72 }
    const lo = Math.min(...question.midis)
    const hi = Math.max(...question.midis)
    return { from: lo - 2, to: hi + 2 }
  }, [question])

  const keyLabel = settings.inputMode === 'keyboard'
  const feedbackExpected = feedback
    ? keyLabel
      ? midiToName(feedback.expected, ECHO_PREFER)
      : pcToName(midiToPc(feedback.expected), ECHO_PREFER)
    : ''
  const feedbackPlayed = feedback
    ? keyLabel
      ? midiToName(feedback.played, ECHO_PREFER)
      : pcToName(midiToPc(feedback.played), ECHO_PREFER)
    : ''

  return (
    <>
      <div className="tool-controls">
        {!levelMode && (
          <>
            <div className="tool-control-group">
              <span className="tool-control-label">Phrase length</span>
              <div className="mn-segmented" role="group" aria-label="Phrase length">
                {ECHO_LENGTHS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`mn-segment${settings.length === n ? ' mn-segment-active' : ''}`}
                    aria-pressed={settings.length === n}
                    onClick={() => setLength(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="tool-control-group">
              <span className="tool-control-label">Key</span>
              <div className="et-echo-key">
                <select
                  className="ip-select"
                  aria-label="Root note"
                  value={settings.rootPc}
                  onChange={(e) => setRootPc(Number(e.target.value) as PitchClass)}
                >
                  {ALL_ROOT_PCS.map((pc) => (
                    <option key={pc} value={pc}>
                      {pcToName(pc, ECHO_PREFER)}
                    </option>
                  ))}
                </select>
                <div className="mn-segmented" role="group" aria-label="Scale">
                  {(['major', 'minor'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      className={`mn-segment${settings.scaleType === st ? ' mn-segment-active' : ''}`}
                      aria-pressed={settings.scaleType === st}
                      onClick={() => setScaleType(st)}
                    >
                      {ECHO_SCALE_LABEL[st]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        <div className="tool-control-group">
          <span className="tool-control-label">Echo on</span>
          <div className="mn-segmented" role="group" aria-label="Input instrument">
            {INPUT_MODE_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                className={`mn-segment${settings.inputMode === m ? ' mn-segment-active' : ''}`}
                aria-pressed={settings.inputMode === m}
                onClick={() => setInputMode(m)}
              >
                {ECHO_INPUT_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="fnt-prompt" role="status" aria-live="polite">
        <MelodicEchoPrompt
          started={started}
          done={done}
          clean={lastClean}
          feedbackExpected={feedbackExpected}
          feedbackPlayed={feedbackPlayed}
          hasFeedback={feedback !== null}
        />
      </div>

      <div className="et-transport">
        <button type="button" className="et-play" onClick={replay}>
          {started ? '▶ Play phrase again' : '▶ Play phrase'}
        </button>
      </div>

      {started && !done && (
        <div className="et-echo-progress" role="status" aria-live="polite">
          Echoed <strong>{echoState.matched}</strong> / {total}
        </div>
      )}

      <div className="et-echo-board">
        {settings.inputMode === 'fretboard' ? (
          <Fretboard
            tuning={tuning}
            fromFret={ECHO_FROM_FRET}
            toFret={ECHO_TO_FRET}
            markers={fretMarkers}
            prefer={ECHO_PREFER}
            onFretClick={done ? undefined : (pos) => handleNote(pos.midi, { string: pos.string, fret: pos.fret })}
            ariaLabel={`${tuning.name} — echo the phrase`}
          />
        ) : (
          <Keyboard
            from={keyboardRange.from}
            to={keyboardRange.to}
            markers={keyMarkers}
            prefer={ECHO_PREFER}
            showLabels="c"
            onKeyClick={done ? undefined : ({ midi }) => handleNote(midi, null)}
            ariaLabel="Echo the phrase on the keyboard"
          />
        )}
      </div>

      {done && (
        <div className="et-compare" role="group" aria-label="Phrase complete">
          <button type="button" className="et-next" onClick={advance}>
            Next phrase →
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
          <span className="fnt-score-label">Clean</span>
        </div>
        <div className="fnt-score-item">
          <span className="fnt-score-value">{stats.bestStreak}</span>
          <span className="fnt-score-label">Best streak</span>
        </div>
      </div>

      <MelodicEchoStatsPanel session={sessionStats} lifetime={lifetimeStats} onReset={resetStats} />
    </>
  )
}

interface MelodicEchoPromptProps {
  started: boolean
  done: boolean
  clean: boolean
  hasFeedback: boolean
  feedbackExpected: string
  feedbackPlayed: string
}

function MelodicEchoPrompt({
  started,
  done,
  clean,
  hasFeedback,
  feedbackExpected,
  feedbackPlayed,
}: MelodicEchoPromptProps) {
  if (done) {
    return clean ? (
      <span className="fnt-prompt-feedback fnt-correct">Clean echo — nicely done!</span>
    ) : (
      <span className="fnt-prompt-feedback fnt-correct">Phrase complete (with a slip or two).</span>
    )
  }
  if (hasFeedback) {
    return (
      <span className="fnt-prompt-feedback fnt-wrong">
        Not quite — expected <strong>{feedbackExpected}</strong>, you played{' '}
        <strong>{feedbackPlayed}</strong>. Start the phrase again.
      </span>
    )
  }
  if (!started) {
    return (
      <span className="fnt-prompt-text">
        Press Play to hear the phrase, then echo it back note by note. The first note is highlighted
        to get you started.
      </span>
    )
  }
  return (
    <span className="fnt-prompt-text">
      Echo the <strong className="fnt-target">phrase</strong> back, starting on the highlighted note.
    </span>
  )
}

interface MelodicEchoStatsPanelProps {
  session: MelodicEchoStats
  lifetime: MelodicEchoStats
  onReset: () => void
}

/** Overall accuracy chips (session + lifetime): clean phrases and best streak. */
function MelodicEchoStatsPanel({ session, lifetime, onReset }: MelodicEchoStatsPanelProps) {
  return (
    <div className="et-stats">
      <div className="et-stats-head">
        <span className="tool-control-label">Phrase accuracy</span>
        <button type="button" className="et-reset" onClick={onReset}>
          Reset stats
        </button>
      </div>
      <div className="et-stats-grid">
        <div className="et-stat">
          <span className="et-stat-name">Session</span>
          <span className="et-stat-line">
            <span className="et-stat-tag">Clean</span>
            {formatStat(echoAccuracy(session), session.attempts)}
          </span>
          <span className="et-stat-line">
            <span className="et-stat-tag">Best streak</span>
            <span className="et-stat-acc">{session.bestStreak}</span>
          </span>
        </div>
        <div className="et-stat">
          <span className="et-stat-name">Lifetime</span>
          <span className="et-stat-line">
            <span className="et-stat-tag">Clean</span>
            {formatStat(echoAccuracy(lifetime), lifetime.attempts)}
          </span>
          <span className="et-stat-line">
            <span className="et-stat-tag">Best streak</span>
            <span className="et-stat-acc">{lifetime.bestStreak}</span>
          </span>
        </div>
      </div>
    </div>
  )
}

// --- Levels (curriculum built on the four trainers above) -------------------

/**
 * A progressive curriculum: `EAR_TRAINING_LEVELS` bundles the four trainers
 * above into an ordered list the player works through. This component owns
 * only the level list + progress store; the actual quiz for a selected level
 * is one of the trainers above, constrained via its `fixedSettings` prop and
 * reporting back through `onAnswer` (see `LevelRunner`) — no quiz logic is
 * duplicated here.
 */
function LevelsTrainer() {
  const [progress, setProgress] = useState<LevelProgressMap>(() =>
    normalizeLevelProgressMap(earTrainingLevelsProgressStore.get()),
  )
  const [activeLevelId, setActiveLevelId] = useState<string | null>(null)

  const recommended = useMemo(
    () => recommendedLevelId(EAR_TRAINING_LEVELS, progress),
    [progress],
  )

  const handleAnswer = useCallback((levelId: string, correct: boolean) => {
    setProgress((current) => {
      const next = recordLevelAnswer(current, levelId, correct)
      earTrainingLevelsProgressStore.set(next)
      return next
    })
  }, [])

  const activeLevel = activeLevelId
    ? (EAR_TRAINING_LEVELS.find((level) => level.id === activeLevelId) ?? null)
    : null

  if (activeLevel) {
    return (
      <LevelRunner
        key={activeLevel.id}
        level={activeLevel}
        progress={progress[activeLevel.id]}
        onAnswer={(correct) => handleAnswer(activeLevel.id, correct)}
        onBack={() => setActiveLevelId(null)}
      />
    )
  }

  return (
    <div className="etl-levels">
      <p className="fnt-hint">
        A guided path through every trainer above, easiest first. Master a level (18/20 recent
        answers correct) to unlock the next one.
      </p>
      <ol className="etl-level-list">
        {EAR_TRAINING_LEVELS.map((level, index) => {
          const unlocked = isLevelUnlocked(EAR_TRAINING_LEVELS, progress, level.id)
          const summary = levelProgressSummary(progress[level.id])
          const isRecommended = level.id === recommended && unlocked && !summary.mastered
          const cardCls = ['etl-level-card']
          if (!unlocked) cardCls.push('etl-level-card-locked')
          if (summary.mastered) cardCls.push('etl-level-card-mastered')
          return (
            <li key={level.id} className={cardCls.join(' ')}>
              <div className="etl-level-head">
                <span className="etl-level-number">{index + 1}</span>
                <div className="etl-level-titles">
                  <span className="etl-level-title">{level.title}</span>
                  <span className="etl-level-desc">{level.description}</span>
                </div>
                {summary.mastered && (
                  <span className="etl-level-badge etl-level-badge-mastered">Mastered</span>
                )}
                {!summary.mastered && isRecommended && (
                  <span className="etl-level-badge etl-level-badge-next">Up next</span>
                )}
                {!unlocked && <span className="etl-level-lock" aria-hidden="true">🔒</span>}
              </div>
              <div className="etl-level-foot">
                <LevelProgressBar summary={summary} />
                <button
                  type="button"
                  className="etl-level-action"
                  disabled={!unlocked}
                  onClick={() => setActiveLevelId(level.id)}
                >
                  {unlocked ? (summary.attempts > 0 ? 'Continue' : 'Start') : 'Locked'}
                </button>
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

interface LevelProgressBarProps {
  summary: ReturnType<typeof levelProgressSummary>
}

/** Small "toward mastery" bar + label, shared by the level list and the runner. */
function LevelProgressBar({ summary }: LevelProgressBarProps) {
  const pct = summary.mastered ? 100 : Math.round((summary.accuracy ?? 0) * 100)
  return (
    <div className="etl-progress" role="status" aria-live="polite">
      <div className="etl-progress-bar">
        <div
          className={`etl-progress-fill${summary.mastered ? ' etl-progress-fill-mastered' : ''}`}
          style={{ width: `${summary.mastered ? 100 : Math.min(100, pct)}%` }}
        />
      </div>
      <span className="etl-progress-label">{summary.label}</span>
    </div>
  )
}

interface LevelRunnerProps {
  level: EarTrainingLevel
  progress: LevelProgressMap[string] | undefined
  onAnswer: (correct: boolean) => void
  onBack: () => void
}

/** Runs one level's task on the matching existing trainer, constrained to
 * the level's fixed config, and feeds every graded answer back into the
 * level's progress. */
function LevelRunner({ level, progress, onAnswer, onBack }: LevelRunnerProps) {
  const summary = levelProgressSummary(progress)
  const { task } = level

  return (
    <div className="etl-runner">
      <div className="etl-runner-head">
        <button type="button" className="etl-back" onClick={onBack}>
          ← Back to levels
        </button>
        <h2 className="etl-runner-title">{level.title}</h2>
        <p className="etl-runner-desc">{level.description}</p>
        <LevelProgressBar summary={summary} />
      </div>

      {task.kind === 'interval' && (
        <IntervalTrainer
          fixedSettings={{ enabled: task.enabled, playback: task.playback }}
          onAnswer={onAnswer}
        />
      )}
      {task.kind === 'chord-quality' && (
        <ChordQualityTrainer
          fixedSettings={{ enabled: task.enabled, inversions: task.inversions }}
          onAnswer={onAnswer}
        />
      )}
      {task.kind === 'scale' && (
        <ScaleTrainer fixedSettings={{ enabled: task.enabled }} onAnswer={onAnswer} />
      )}
      {task.kind === 'melodic-echo' && (
        <MelodicEchoTrainer
          fixedSettings={{ length: task.length, rootPc: task.rootPc, scaleType: task.scaleType }}
          onAnswer={onAnswer}
        />
      )}
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
