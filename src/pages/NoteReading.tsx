/**
 * Note Reading — draws a single random note on a staff and asks the player to
 * identify it through one of three input modes: name buttons, the on-screen
 * Fretboard (using the global tuning), or the Keyboard.
 *
 * Two play modes:
 *  - Practice — untimed, each answer reveals the note name for a moment
 *    before advancing.
 *  - Timed — a 30/60/120s countdown; answers (right or wrong) advance
 *    immediately with no lingering reveal, then a results screen shows the
 *    score, accuracy and best streak.
 *
 * The component stays thin: staff placement lives in `staffGeometry.ts`,
 * range/clef/answer/countdown/persistence logic in `src/lib/noteReading.ts`
 * (pure, unit-tested), and question/score bookkeeping in the shared
 * `QuizSession` (`src/lib/quiz.ts`) — one session drives both modes, so
 * changing the clef/range settings just re-generates it (see the
 * `contextKey` effect below), same pattern as `FretboardNoteTrainer`.
 *
 * Audio follows the metronome pattern: the AudioContext is only resumed inside
 * an answer handler (`ensureRunning`), never at mount, so the page never trips
 * the browser autoplay block.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Staff } from '../components/Staff.tsx'
import { Fretboard, type FretboardMarker } from '../components/Fretboard.tsx'
import { Keyboard, type KeyboardMarker } from '../components/Keyboard.tsx'
import type { Clef } from '../components/staffGeometry.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { fretMidi } from '../lib/theory/instruments.ts'
import { FLAT_NAMES, midiToName, midiToPc, SHARP_NAMES } from '../lib/theory/notes.ts'
import { useGlobalSettings } from '../hooks/useGlobalSettings.ts'
import { applySpellingPreference } from '../lib/globalSettings.ts'
import {
  emptyStats,
  QuizSession,
  type AnswerResult,
  type QuizStats,
} from '../lib/quiz.ts'
import {
  checkNoteReadingAnswer,
  CLEF_SETTING_OPTIONS,
  generateNoteReadingQuestion,
  INPUT_MODE_OPTIONS,
  isCountdownOver,
  noteReadingSettingsStore,
  noteReadingSrsStore,
  normalizeNoteReadingSettings,
  RANGE_NOTE_OPTIONS,
  RANGE_PRESET_OPTIONS,
  remainingSeconds,
  resolveRange,
  srsKeyForNote,
  startCountdown,
  summarizeTimedResults,
  TIMED_DURATIONS,
  updateCustomRange,
  type ClefSetting,
  type Countdown,
  type InputMode,
  type NoteReadingAnswer,
  type NoteReadingMode,
  type NoteReadingPicking,
  type NoteReadingQuestion,
  type NoteReadingSettings,
  type RangePreset,
  type TimedDurationSec,
} from '../lib/noteReading.ts'
import { normalizeSrsData, qualityFromOutcome, reviewKey, type SrsData } from '../lib/spacedRepetition.ts'
import { recordPractice } from '../lib/practiceLog.ts'
import { useAnswerShortcuts } from '../hooks/useAnswerShortcuts.ts'
import { shortcutLabel } from '../lib/answerShortcuts.ts'

const FROM_FRET = 0
const TO_FRET = 12
/** Practice mode: how long the answer stays revealed before auto-advancing. */
const REVEAL_MS = 1200
/** How often the Timed-mode countdown re-renders. */
const TICK_MS = 150

type TimedPhase = 'setup' | 'running' | 'finished'

const CLEF_LABEL: Record<ClefSetting, string> = { bass: 'Bass', treble: 'Treble', both: 'Both (random)' }
const MODE_LABEL: Record<NoteReadingMode, string> = { practice: 'Practice', timed: 'Timed' }
const INPUT_LABEL: Record<InputMode, string> = {
  name: 'Name',
  fretboard: 'Fretboard',
  keyboard: 'Keyboard',
}
const RANGE_LABEL: Record<RangePreset, string> = {
  staff: 'Staff only',
  ledger: 'Staff + ledger',
  custom: 'Custom',
}

export function NoteReading() {
  const { tuning } = useInstrumentSettings()
  const { settings: globalSettings } = useGlobalSettings()
  const engineRef = useRef(getAudioEngine())

  // This tool draws a note on a staff with no key signature, so the accidental
  // spelling is a genuinely free choice (there is no key context to contradict).
  // Follow the global sharps/flats preference; `'auto'` keeps the original
  // sharp spelling everywhere — staff, name buttons, and reveal markers.
  const prefer = applySpellingPreference(globalSettings.spellingPreference, 'sharp')
  const noteNames = prefer === 'flat' ? FLAT_NAMES : SHARP_NAMES
  const advanceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tickIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<Countdown | null>(null)

  const [settings, setSettings] = useState<NoteReadingSettings>(() =>
    normalizeNoteReadingSettings(noteReadingSettingsStore.get()),
  )
  useEffect(() => {
    noteReadingSettingsStore.set(settings)
  }, [settings])

  // The "hear it" playback matches the answer-input surface: the keyboard input
  // plays the keyboard (piano) voice, the fretboard and name inputs play the
  // fretted (pluck) voice. Re-asserted whenever the input mode changes.
  useEffect(() => {
    engineRef.current.setVoiceContext(settings.inputMode === 'keyboard' ? 'keyboard' : 'fretted')
  }, [settings.inputMode])

  const sessionRef = useRef<QuizSession<NoteReadingQuestion, NoteReadingAnswer> | null>(null)
  const [question, setQuestion] = useState<NoteReadingQuestion | null>(null)
  const [result, setResult] = useState<AnswerResult<NoteReadingQuestion, NoteReadingAnswer> | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)

  // Spaced-repetition schedule (per clef+pitch). Reviews are recorded on every
  // graded answer; the schedule biases which note is prompted next in Practice
  // mode. Timed mode keeps a pure-random draw (it is a race, so due-ness
  // shouldn't steer it), but still records reviews so the schedule stays fresh.
  const [srs, setSrs] = useState<SrsData>(() => normalizeSrsData(noteReadingSrsStore.get()))
  const srsRef = useRef(srs)
  srsRef.current = srs
  const modeRef = useRef(settings.mode)
  modeRef.current = settings.mode
  // Read via a ref so the (stable) generator always sees the latest schedule.
  const pickingRef = useRef<() => NoteReadingPicking | undefined>(() => undefined)
  pickingRef.current = () =>
    modeRef.current === 'practice' ? { srs: srsRef.current, now: Date.now() } : undefined

  const [timedPhase, setTimedPhase] = useState<TimedPhase>('setup')
  const [remaining, setRemaining] = useState<number>(settings.timedSeconds)
  const [finalStats, setFinalStats] = useState<QuizStats | null>(null)

  // Live context read by the (stable) generator/checker, so the session never
  // needs recreating just because a closure captured stale settings.
  const generateContextRef = useRef({
    clefSetting: settings.clef,
    rangePreset: settings.rangePreset,
    customRange: settings.customRange,
  })
  generateContextRef.current = {
    clefSetting: settings.clef,
    rangePreset: settings.rangePreset,
    customRange: settings.customRange,
  }
  const answerContextRef = useRef({ tuning, fromFret: FROM_FRET, toFret: TO_FRET })
  answerContextRef.current = { tuning, fromFret: FROM_FRET, toFret: TO_FRET }

  const clearAdvanceTimeout = useCallback(() => {
    if (advanceTimeoutRef.current !== null) {
      clearTimeout(advanceTimeoutRef.current)
      advanceTimeoutRef.current = null
    }
  }, [])

  const clearTick = useCallback(() => {
    if (tickIntervalRef.current !== null) {
      clearInterval(tickIntervalRef.current)
      tickIntervalRef.current = null
    }
  }, [])

  const drawNext = useCallback(() => {
    const session = sessionRef.current
    if (!session) return
    session.next()
    setQuestion(session.current)
    setResult(null)
  }, [])

  // Rebuild the session (and drop any in-flight timer/results) whenever the
  // answerable question set changes: tuning, clef setting, range preset or
  // custom range, or the Practice/Timed mode itself.
  const contextKey = `${tuning.id}|${settings.clef}|${settings.rangePreset}|${JSON.stringify(settings.customRange)}|${settings.mode}`
  useEffect(() => {
    clearAdvanceTimeout()
    clearTick()
    countdownRef.current = null
    if (!sessionRef.current) {
      sessionRef.current = new QuizSession<NoteReadingQuestion, NoteReadingAnswer>({
        generate: (previous, rng) =>
          generateNoteReadingQuestion(generateContextRef.current, previous, rng, pickingRef.current()),
        check: (q, a) => checkNoteReadingAnswer(q, a, answerContextRef.current),
        clock: () => performance.now(),
      })
    } else {
      sessionRef.current.reset()
    }
    sessionRef.current.next()
    setQuestion(sessionRef.current.current)
    setResult(null)
    setStats(sessionRef.current.stats)
    setTimedPhase('setup')
    setFinalStats(null)
    setRemaining(settings.timedSeconds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey])

  useEffect(
    () => () => {
      clearAdvanceTimeout()
      clearTick()
    },
    [clearAdvanceTimeout, clearTick],
  )

  const finishTimedRun = useCallback(() => {
    clearTick()
    countdownRef.current = null
    setFinalStats(sessionRef.current?.stats ?? emptyStats())
    setTimedPhase('finished')
  }, [clearTick])

  const startTimedRun = useCallback(() => {
    clearAdvanceTimeout()
    clearTick()
    const session = sessionRef.current
    if (!session) return
    session.reset()
    session.next()
    setQuestion(session.current)
    setResult(null)
    setStats(session.stats)
    setFinalStats(null)

    const now = performance.now()
    countdownRef.current = startCountdown(now, settings.timedSeconds)
    setRemaining(settings.timedSeconds)
    setTimedPhase('running')
    tickIntervalRef.current = setInterval(() => {
      const cd = countdownRef.current
      if (!cd) return
      const now2 = performance.now()
      setRemaining(remainingSeconds(cd, now2))
      if (isCountdownOver(cd, now2)) finishTimedRun()
    }, TICK_MS)
  }, [settings.timedSeconds, clearAdvanceTimeout, clearTick, finishTimedRun])

  const submit = useCallback(
    (answer: NoteReadingAnswer) => {
      const session = sessionRef.current
      const current = session?.current
      if (!session || !current) return
      if (settings.mode === 'timed' && timedPhase !== 'running') return
      if (session.isAnswered) return

      const res = session.answer(answer)
      setResult(res)
      setStats(session.stats)

      // Record the review (both modes) and stamp the practice log — Note
      // Reading tracks no per-note stats otherwise, so this is where its
      // activity reaches the dashboard.
      const now = Date.now()
      recordPractice(new Date(now))
      setSrs(
        noteReadingSrsStore.update((d) =>
          reviewKey(
            d,
            srsKeyForNote(res.question.clef, res.question.midi),
            qualityFromOutcome(res.correct, res.responseMs),
            now,
          ),
        ),
      )

      const engine = engineRef.current
      void engine
        .ensureRunning()
        .then(() => engine.playNote(current.midi, 1.1))
        .catch(() => {})

      if (settings.mode === 'timed') {
        // Timed mode: wrong answers just advance too — no lingering reveal.
        drawNext()
      } else {
        clearAdvanceTimeout()
        advanceTimeoutRef.current = setTimeout(drawNext, REVEAL_MS)
      }
    },
    [settings.mode, timedPhase, drawNext, clearAdvanceTimeout],
  )

  const locked = settings.mode === 'practice' && result !== null

  // Reveal markers only after a Practice-mode answer, so the board doesn't
  // give it away, and Timed mode (no lingering feedback) never shows them.
  const fretMarkers = useMemo<FretboardMarker[]>(() => {
    if (!locked || !question) return []
    const target = question.midi
    const markers: FretboardMarker[] = []
    const exactReachable = boardHas(tuning.strings.length, (s, f) => fretMidi(tuning, s, f) === target)
    for (let s = 0; s < tuning.strings.length; s++) {
      for (let f = FROM_FRET; f <= TO_FRET; f++) {
        const midi = fretMidi(tuning, s, f)
        const isTarget = exactReachable ? midi === target : midiToPc(midi) === midiToPc(target)
        if (isTarget) markers.push({ string: s, fret: f, variant: 'root', label: midiToName(midi, prefer) })
      }
    }
    return markers
  }, [locked, question, tuning, prefer])

  const keyMarkers = useMemo<KeyboardMarker[]>(
    () => (locked && question ? [{ midi: question.midi, variant: 'root', label: midiToName(question.midi, prefer) }] : []),
    [locked, question, prefer],
  )

  const questionClef: Clef = question?.clef ?? (settings.clef === 'treble' ? 'treble' : 'bass')
  const keyboardRange = resolveRange(questionClef, settings.rangePreset, settings.customRange)
  const answerName = question ? midiToName(question.midi, prefer) : ''
  const controlsLocked = settings.mode === 'timed' && timedPhase === 'running'

  const setClef = (clef: ClefSetting) => setSettings((s) => ({ ...s, clef }))
  const setInputMode = (inputMode: InputMode) => setSettings((s) => ({ ...s, inputMode }))
  const setRangePreset = (rangePreset: RangePreset) => setSettings((s) => ({ ...s, rangePreset }))
  const setMode = (mode: NoteReadingMode) => setSettings((s) => ({ ...s, mode }))
  const setTimedSeconds = (timedSeconds: TimedDurationSec) => setSettings((s) => ({ ...s, timedSeconds }))
  const editCustomRange = (clef: Clef, field: 'low' | 'high', midi: number) =>
    setSettings((s) => ({
      ...s,
      customRange: { ...s.customRange, [clef]: updateCustomRange(s.customRange[clef], field, midi) },
    }))

  const customRangeClefs: Clef[] = settings.clef === 'both' ? ['bass', 'treble'] : [settings.clef]

  const showStage = settings.mode === 'practice' || timedPhase === 'running'

  // With the "Name" input, number keys 1–9 pick the first nine note buttons
  // (C … G♯); the fretboard/keyboard inputs stay tap-only. Bound only while an
  // answer can actually be submitted (not locked, and the run is live).
  const nameInputActive =
    settings.inputMode === 'name' &&
    !locked &&
    (settings.mode === 'practice' || timedPhase === 'running')
  const selectNote = useCallback(
    (index: number) => submit({ kind: 'name', pc: index }),
    [submit],
  )
  useAnswerShortcuts({
    optionCount: nameInputActive ? noteNames.length : 0,
    onSelect: selectNote,
  })

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Note Reading</h1>
        <p className="tool-page-lead">
          Read the note on the staff, then answer with the name buttons, the fretboard, or the
          keyboard. Practice mode reveals each answer; Timed mode races the clock for a high
          score.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Clef</span>
          <div className="nr-segmented" role="group" aria-label="Clef">
            {CLEF_SETTING_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                className={`nr-segment${c === settings.clef ? ' nr-segment-active' : ''}`}
                aria-pressed={c === settings.clef}
                disabled={controlsLocked}
                onClick={() => setClef(c)}
              >
                {CLEF_LABEL[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Answer with</span>
          <div className="nr-segmented" role="group" aria-label="Input mode">
            {INPUT_MODE_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                className={`nr-segment${m === settings.inputMode ? ' nr-segment-active' : ''}`}
                aria-pressed={m === settings.inputMode}
                disabled={controlsLocked}
                onClick={() => setInputMode(m)}
              >
                {INPUT_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Note range</span>
          <div className="nr-segmented" role="group" aria-label="Note range">
            {RANGE_PRESET_OPTIONS.map((p) => (
              <button
                key={p}
                type="button"
                className={`nr-segment${p === settings.rangePreset ? ' nr-segment-active' : ''}`}
                aria-pressed={p === settings.rangePreset}
                disabled={controlsLocked}
                onClick={() => setRangePreset(p)}
              >
                {RANGE_LABEL[p]}
              </button>
            ))}
          </div>
          {settings.rangePreset === 'custom' && (
            <div className="nr-custom-range">
              {customRangeClefs.map((c) => (
                <div key={c} className="nr-custom-range-row">
                  {customRangeClefs.length > 1 && <span className="nr-custom-range-clef">{CLEF_LABEL[c]}</span>}
                  <select
                    className="ip-select"
                    aria-label={`${CLEF_LABEL[c]} lowest note`}
                    value={settings.customRange[c].low}
                    disabled={controlsLocked}
                    onChange={(e) => editCustomRange(c, 'low', Number(e.target.value))}
                  >
                    {RANGE_NOTE_OPTIONS.map((o) => (
                      <option key={o.midi} value={o.midi}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <span className="nr-custom-range-to">to</span>
                  <select
                    className="ip-select"
                    aria-label={`${CLEF_LABEL[c]} highest note`}
                    value={settings.customRange[c].high}
                    disabled={controlsLocked}
                    onChange={(e) => editCustomRange(c, 'high', Number(e.target.value))}
                  >
                    {RANGE_NOTE_OPTIONS.map((o) => (
                      <option key={o.midi} value={o.midi}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Mode</span>
          <div className="nr-segmented" role="group" aria-label="Practice or Timed">
            {(['practice', 'timed'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`nr-segment${m === settings.mode ? ' nr-segment-active' : ''}`}
                aria-pressed={m === settings.mode}
                disabled={controlsLocked}
                onClick={() => setMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
          {settings.mode === 'timed' && (
            <div className="nr-segmented" role="group" aria-label="Timed duration">
              {TIMED_DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`nr-segment${d === settings.timedSeconds ? ' nr-segment-active' : ''}`}
                  aria-pressed={d === settings.timedSeconds}
                  disabled={controlsLocked}
                  onClick={() => setTimedSeconds(d)}
                >
                  {d}s
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {settings.mode === 'timed' && timedPhase === 'setup' && (
        <div className="nr-timed-card">
          <p className="nr-timed-text">
            {settings.timedSeconds} seconds on the clock. Answer as many notes as you can — wrong
            answers just move on, so keep going.
          </p>
          <button type="button" className="nr-button" onClick={startTimedRun}>
            Start
          </button>
        </div>
      )}

      {settings.mode === 'timed' && timedPhase === 'finished' && finalStats && (
        <div className="nr-results">
          <h2 className="nr-results-title">Time&apos;s up!</h2>
          <div className="nr-scores">
            <div className="nr-score">
              <span className="nr-score-value">{finalStats.correct}</span>
              <span className="nr-score-label">Score</span>
            </div>
            <div className="nr-score">
              <span className="nr-score-value">
                {Math.round(summarizeTimedResults(finalStats).accuracy * 100)}%
              </span>
              <span className="nr-score-label">Accuracy</span>
            </div>
            <div className="nr-score">
              <span className="nr-score-value">{finalStats.bestStreak}</span>
              <span className="nr-score-label">Best streak</span>
            </div>
          </div>
          <button type="button" className="nr-button" onClick={startTimedRun}>
            Play again
          </button>
        </div>
      )}

      {showStage && question && (
        <>
          {settings.mode === 'timed' && (
            <div className={`nr-timer${remaining <= 10 ? ' nr-timer-low' : ''}`} role="status" aria-live="off">
              <span className="nr-timer-value">{remaining}</span>
              <span className="nr-timer-label">seconds left</span>
              <span className="nr-timer-streak">
                Streak <strong>{stats.streak}</strong>
              </span>
            </div>
          )}

          <div className={`nr-stage nr-stage-${locked ? (result?.correct ? 'correct' : 'wrong') : 'idle'}`}>
            <Staff midi={question.midi} clef={questionClef} prefer={prefer} className="nr-staff" />
            <div className="nr-feedback" role="status" aria-live="polite">
              {!locked && <span className="nr-prompt">Name this note</span>}
              {locked && result?.correct && <span className="nr-correct">Correct — {answerName}</span>}
              {locked && result && !result.correct && <span className="nr-wrong">It was {answerName}</span>}
            </div>
          </div>

          {settings.mode === 'practice' && (
            <div className="nr-scores">
              <div className="nr-score">
                <span className="nr-score-value">{stats.streak}</span>
                <span className="nr-score-label">Streak</span>
              </div>
              <div className="nr-score">
                <span className="nr-score-value">{stats.bestStreak}</span>
                <span className="nr-score-label">Best</span>
              </div>
              <div className="nr-score">
                <span className="nr-score-value">
                  {stats.correct}/{stats.answered}
                </span>
                <span className="nr-score-label">Correct</span>
              </div>
            </div>
          )}

          <div className="nr-answer">
            {settings.inputMode === 'name' && (
              <div className="nr-names" role="group" aria-label="Note names">
                {noteNames.map((name, pc) => {
                  const key = shortcutLabel(pc)
                  return (
                    <button
                      key={name}
                      type="button"
                      className="nr-name"
                      disabled={locked}
                      title={key ? `Shortcut: press ${key}` : undefined}
                      onClick={() => submit({ kind: 'name', pc })}
                    >
                      {key && (
                        <span className="sc-key" aria-hidden="true">
                          {key}
                        </span>
                      )}
                      {name}
                    </button>
                  )
                })}
              </div>
            )}

            {settings.inputMode === 'fretboard' && (
              <Fretboard
                tuning={tuning}
                fromFret={FROM_FRET}
                toFret={TO_FRET}
                markers={fretMarkers}
                prefer={prefer}
                onFretClick={locked ? undefined : (pos) => submit({ kind: 'fretboard', midi: pos.midi })}
                ariaLabel={`${tuning.name} — click the fret of the note`}
              />
            )}

            {settings.inputMode === 'keyboard' && (
              <Keyboard
                from={keyboardRange.low}
                to={keyboardRange.high}
                markers={keyMarkers}
                prefer={prefer}
                showLabels="c"
                onKeyClick={locked ? undefined : ({ midi }) => submit({ kind: 'keyboard', midi })}
                ariaLabel="Click the key of the note"
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** True when any (string, fret) within the shown range satisfies `pred`. */
function boardHas(stringCount: number, pred: (s: number, f: number) => boolean): boolean {
  for (let s = 0; s < stringCount; s++) {
    for (let f = FROM_FRET; f <= TO_FRET; f++) {
      if (pred(s, f)) return true
    }
  }
  return false
}
