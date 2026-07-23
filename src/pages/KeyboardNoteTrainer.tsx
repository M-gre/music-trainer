/**
 * Keyboard Note Trainer — the same quiz modes as the Fretboard Note Trainer
 * (see `FretboardNoteTrainer.tsx`), applied to the `Keyboard` component. Two
 * pure cores are reused:
 *  - `src/lib/quiz.ts`: `QuizSession` (single-answer modes) and
 *    `FindAllSession` (the multi-answer "find all" mode).
 *  - `src/lib/keyboardTrainer.ts`: question generation, answer checking and
 *    persisted settings for this tool specifically.
 *
 * Three modes: "Find the note" (prompt names a note, tap any matching key in
 * the visible range), "Name the key" (a key is highlighted, pick the note) and
 * "Find all" (tap the note in every octave in range; found keys stay lit).
 * Audio only starts from the answer click (`ensureRunning`), never at mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, type KeyboardMarker } from '../components/Keyboard.tsx'
import { NoteStatsPanel } from '../components/NoteStatsPanel.tsx'
import { octaveRangeToMidi } from '../components/keyboardGeometry.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { midiToName, midiToPc, pcToName, type PitchClass } from '../lib/theory/notes.ts'
import {
  emptyStats,
  FindAllSession,
  QuizSession,
  type AnswerResult,
  type FindAllProgress,
  type QuizStats,
} from '../lib/quiz.ts'
import {
  emptyNoteStats,
  keyboardStatsStore,
  normalizeNoteStats,
  recordFindAllRound,
  recordOutcome,
  type NoteStatsData,
} from '../lib/noteStats.ts'
import {
  checkAnswer,
  findAllTargetKeys,
  generateQuestion,
  keyboardTrainerSettingsStore,
  keyKey,
  MAX_OCTAVE,
  MIN_OCTAVE,
  normalizeTrainerSettings,
  OCTAVE_RANGE_PRESETS,
  type FindAllQuestion,
  type KeyboardTrainerSettings,
  type QuestionContext,
  type QuizMode,
  type TrainerAnswer,
  type TrainerQuestion,
} from '../lib/keyboardTrainer.ts'

const PITCH_CLASSES: PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

/** How long the answer stays on screen before auto-advancing. */
const ADVANCE_MS_CORRECT = 900
const ADVANCE_MS_WRONG = 1700
/** How long a wrong tap flashes red in find-all mode. */
const WRONG_FLASH_MS = 650

const EMPTY_PROGRESS: FindAllProgress = { found: 0, total: 0, mistakes: 0, complete: false }

const MODE_OPTIONS: { value: QuizMode; label: string }[] = [
  { value: 'find', label: 'Find the note' },
  { value: 'name', label: 'Name the key' },
  { value: 'findAll', label: 'Find all' },
]

const OCTAVE_OPTIONS = Array.from({ length: MAX_OCTAVE - MIN_OCTAVE + 1 }, (_, i) => MIN_OCTAVE + i)

export function KeyboardNoteTrainer() {
  const engineRef = useRef(getAudioEngine())
  const timeoutRef = useRef<number | null>(null)
  const wrongTimeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<KeyboardTrainerSettings>(() =>
    normalizeTrainerSettings(keyboardTrainerSettingsStore.get()),
  )

  useEffect(() => {
    keyboardTrainerSettingsStore.set(settings)
  }, [settings])

  const [noteStats, setNoteStats] = useState<NoteStatsData>(() =>
    normalizeNoteStats(keyboardStatsStore.get()),
  )
  // Refs so the stable question generator reads the latest stats / toggle.
  const statsRef = useRef(noteStats)
  statsRef.current = noteStats
  const focusWeakRef = useRef(settings.focusWeak)
  focusWeakRef.current = settings.focusWeak

  const { from: fromMidi, to: toMidi } = useMemo(
    () => octaveRangeToMidi(settings.fromOctave, settings.toOctave),
    [settings.fromOctave, settings.toOctave],
  )

  // Live context read by the (stable) question generator.
  const context: QuestionContext = { mode: settings.mode, fromMidi, toMidi }
  const contextRef = useRef(context)
  contextRef.current = context

  const sessionRef = useRef<QuizSession<TrainerQuestion, TrainerAnswer> | null>(null)
  const faSessionRef = useRef<FindAllSession<FindAllQuestion, number> | null>(null)
  const [question, setQuestion] = useState<TrainerQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [result, setResult] = useState<AnswerResult<TrainerQuestion, TrainerAnswer> | null>(null)
  const [faProgress, setFaProgress] = useState<FindAllProgress>(EMPTY_PROGRESS)
  const [faFound, setFaFound] = useState<readonly string[]>([])
  const [faWrong, setFaWrong] = useState<number | null>(null)

  // Weakest-first picking parameters, or `undefined` when the toggle is off.
  // Reads refs so the (stable) generator always sees the current stats/toggle.
  const picking = useCallback(
    () => (focusWeakRef.current ? { stats: statsRef.current, now: Date.now() } : undefined),
    [],
  )

  const clearPendingAdvance = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const clearWrongFlash = useCallback(() => {
    if (wrongTimeoutRef.current !== null) {
      window.clearTimeout(wrongTimeoutRef.current)
      wrongTimeoutRef.current = null
    }
  }, [])

  const advance = useCallback(() => {
    clearPendingAdvance()
    clearWrongFlash()
    if (settings.mode === 'findAll') {
      const session = faSessionRef.current
      if (!session) return
      session.next()
      setQuestion(session.current)
      setFaProgress(session.progress)
      setFaFound(session.foundKeys)
      setFaWrong(null)
    } else {
      const session = sessionRef.current
      if (!session) return
      session.next()
      setQuestion(session.current)
      setResult(null)
    }
  }, [clearPendingAdvance, clearWrongFlash, settings.mode])

  // Reset and draw a fresh question whenever the answerable set changes (mode
  // or octave range). Also runs on mount.
  const contextKey = `${settings.mode}|${fromMidi}|${toMidi}`
  useEffect(() => {
    clearPendingAdvance()
    clearWrongFlash()
    if (settings.mode === 'findAll') {
      const session = new FindAllSession<FindAllQuestion, number>({
        generate: (previous, rng) =>
          generateQuestion(contextRef.current, previous, rng, picking()) as FindAllQuestion,
        targetsOf: findAllTargetKeys,
        keyOf: keyKey,
      })
      faSessionRef.current = session
      sessionRef.current = null
      session.next()
      setQuestion(session.current)
      setStats(session.stats)
      setFaProgress(session.progress)
      setFaFound(session.foundKeys)
      setFaWrong(null)
      setResult(null)
    } else {
      const session = new QuizSession<TrainerQuestion, TrainerAnswer>({
        generate: (previous, rng) => generateQuestion(contextRef.current, previous, rng, picking()),
        check: checkAnswer,
        clock: () => performance.now(),
      })
      sessionRef.current = session
      faSessionRef.current = null
      session.next()
      setQuestion(session.current)
      setStats(session.stats)
      setResult(null)
      setFaProgress(EMPTY_PROGRESS)
      setFaFound([])
      setFaWrong(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey])

  useEffect(
    () => () => {
      clearPendingAdvance()
      clearWrongFlash()
    },
    [clearPendingAdvance, clearWrongFlash],
  )

  const submit = useCallback(
    (answer: TrainerAnswer, midiToPlay: number) => {
      const session = sessionRef.current
      if (!session || !session.current || session.isAnswered) return
      const res = session.answer(answer)
      setResult(res)
      setStats(session.stats)
      setNoteStats(
        keyboardStatsStore.update((d) =>
          recordOutcome(d, res.question.pc, res.correct, res.responseMs, Date.now()),
        ),
      )

      const engine = engineRef.current
      void engine.ensureRunning().then(() => engine.playNote(midiToPlay, 0.7))

      clearPendingAdvance()
      timeoutRef.current = window.setTimeout(
        advance,
        res.correct ? ADVANCE_MS_CORRECT : ADVANCE_MS_WRONG,
      )
    },
    [advance, clearPendingAdvance],
  )

  const faSubmit = useCallback(
    (midi: number) => {
      const session = faSessionRef.current
      if (!session || !session.current || session.isComplete) return
      const res = session.submit(midi)
      setFaProgress(res.progress)
      setFaFound(session.foundKeys)
      setStats(session.stats)

      const engine = engineRef.current
      void engine.ensureRunning().then(() => engine.playNote(midi, 0.7))

      if (res.outcome === 'wrong') {
        setFaWrong(midi)
        clearWrongFlash()
        wrongTimeoutRef.current = window.setTimeout(() => {
          setFaWrong(null)
          wrongTimeoutRef.current = null
        }, WRONG_FLASH_MS)
      }
      if (res.justCompleted) {
        const q = session.current
        if (q) {
          setNoteStats(
            keyboardStatsStore.update((d) =>
              recordFindAllRound(d, [q.pc], q.pc, res.progress.mistakes, Date.now()),
            ),
          )
        }
        clearPendingAdvance()
        timeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT)
      }
    },
    [advance, clearPendingAdvance, clearWrongFlash],
  )

  const handleKeyClick = useCallback(
    (key: { midi: number }) => {
      if (settings.mode === 'findAll') faSubmit(key.midi)
      else submit({ kind: 'key', midi: key.midi }, key.midi)
    },
    [settings.mode, faSubmit, submit],
  )

  const handlePcClick = useCallback(
    (pc: PitchClass) => {
      const q = sessionRef.current?.current
      if (!q || q.mode !== 'name') return
      submit({ kind: 'pc', pc }, q.midi)
    },
    [submit],
  )

  const prefer = settings.accidentals
  const markers = useMemo(() => {
    if (settings.mode === 'findAll') return buildFindAllMarkers(question, faFound, faWrong, prefer)
    return buildMarkers(question, result, prefer)
  }, [settings.mode, question, faFound, faWrong, result, prefer])

  const answered = result !== null
  const findClickable = settings.mode === 'find' && !answered
  const findAllClickable = settings.mode === 'findAll' && !faProgress.complete

  const resetStats = useCallback(() => {
    keyboardStatsStore.clear()
    setNoteStats(emptyNoteStats())
  }, [])

  const setOctave = (which: 'fromOctave' | 'toOctave', value: number): void => {
    setSettings((s) => {
      const next = { ...s, [which]: value }
      if (which === 'fromOctave' && value > s.toOctave) next.toOctave = value
      if (which === 'toOctave' && value < s.fromOctave) next.fromOctave = value
      return next
    })
  }

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Keyboard Note Trainer</h1>
        <p className="tool-page-lead">
          Learn the keys and their names across octaves. Sound plays only when you answer.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Mode</span>
          <div className="mn-segmented" role="group">
            {MODE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`mn-segment${settings.mode === option.value ? ' mn-segment-active' : ''}`}
                aria-pressed={settings.mode === option.value}
                onClick={() => setSettings((s) => ({ ...s, mode: option.value }))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Octave range</span>
          <div className="mn-segmented" role="group">
            {OCTAVE_RANGE_PRESETS.map((preset) => {
              const active =
                settings.fromOctave === preset.fromOctave && settings.toOctave === preset.toOctave
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`mn-segment${active ? ' mn-segment-active' : ''}`}
                  aria-pressed={active}
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      fromOctave: preset.fromOctave,
                      toOctave: preset.toOctave,
                    }))
                  }
                >
                  {preset.label}
                </button>
              )
            })}
          </div>
          <div className="fnt-range-row">
            <label className="fnt-range-field">
              <span>From</span>
              <select
                className="fnt-range-select"
                value={settings.fromOctave}
                onChange={(e) => setOctave('fromOctave', Number(e.target.value))}
                aria-label="Lowest octave"
              >
                {OCTAVE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    C{o}
                  </option>
                ))}
              </select>
            </label>
            <span className="fnt-range-sep" aria-hidden="true">
              –
            </span>
            <label className="fnt-range-field">
              <span>To</span>
              <select
                className="fnt-range-select"
                value={settings.toOctave}
                onChange={(e) => setOctave('toOctave', Number(e.target.value))}
                aria-label="Highest octave"
              >
                {OCTAVE_OPTIONS.map((o) => (
                  <option key={o} value={o}>
                    B{o}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Accidentals</span>
          <div className="mn-segmented" role="group">
            {(['sharp', 'flat'] as const).map((acc) => (
              <button
                key={acc}
                type="button"
                className={`mn-segment${settings.accidentals === acc ? ' mn-segment-active' : ''}`}
                aria-pressed={settings.accidentals === acc}
                onClick={() => setSettings((s) => ({ ...s, accidentals: acc }))}
              >
                {acc === 'sharp' ? 'Sharps ♯' : 'Flats ♭'}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Focus</span>
          <div className="mn-segmented" role="group">
            <button
              type="button"
              className={`mn-segment${settings.focusWeak ? ' mn-segment-active' : ''}`}
              aria-pressed={settings.focusWeak}
              onClick={() => setSettings((s) => ({ ...s, focusWeak: !s.focusWeak }))}
            >
              Focus weak notes
            </button>
          </div>
        </div>
      </div>

      <div className="fnt-prompt" role="status" aria-live="polite">
        <Prompt question={question} result={result} faProgress={faProgress} prefer={prefer} />
      </div>

      <Keyboard
        fromOctave={settings.fromOctave}
        toOctave={settings.toOctave}
        markers={markers}
        prefer={prefer}
        showLabels="c"
        onKeyClick={findClickable || findAllClickable ? handleKeyClick : undefined}
        ariaLabel={
          settings.mode === 'name'
            ? 'piano keyboard — name the highlighted key'
            : 'piano keyboard — tap the requested key'
        }
      />

      {settings.mode === 'name' && (
        <div className="fnt-note-grid" role="group" aria-label="Note answers">
          {PITCH_CLASSES.map((pc) => {
            const isCorrect = answered && question?.mode === 'name' && question.pc === pc
            const isWrongChoice =
              answered &&
              result?.answer.kind === 'pc' &&
              result.answer.pc === pc &&
              !result.correct
            const cls = ['fnt-note-btn']
            if (isCorrect) cls.push('fnt-note-correct')
            if (isWrongChoice) cls.push('fnt-note-wrong')
            return (
              <button
                key={pc}
                type="button"
                className={cls.join(' ')}
                disabled={answered}
                onClick={() => handlePcClick(pc)}
              >
                {pcToName(pc, prefer)}
              </button>
            )
          })}
        </div>
      )}

      {settings.mode === 'findAll' && (
        <p className="fnt-hint">
          Streak counts a note only when you find every octave with no wrong taps.
        </p>
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
          <span className="fnt-score-label">{settings.mode === 'findAll' ? 'Clean' : 'Correct'}</span>
        </div>
        <div className="fnt-score-item">
          <span className="fnt-score-value">{stats.bestStreak}</span>
          <span className="fnt-score-label">Best streak</span>
        </div>
      </div>

      <NoteStatsPanel stats={noteStats} prefer={prefer} onReset={resetStats} />
    </div>
  )
}

interface PromptProps {
  question: TrainerQuestion | null
  result: AnswerResult<TrainerQuestion, TrainerAnswer> | null
  faProgress: FindAllProgress
  prefer: 'sharp' | 'flat'
}

function Prompt({ question, result, faProgress, prefer }: PromptProps) {
  if (!question) return <span className="fnt-prompt-text">Loading…</span>

  if (question.mode === 'findAll') {
    const note = pcToName(question.pc, prefer)
    if (faProgress.complete) {
      const clean = faProgress.mistakes === 0
      return (
        <span className={`fnt-prompt-feedback ${clean ? 'fnt-correct' : 'fnt-wrong'}`}>
          Found all {faProgress.total} {note}
          {clean ? ' — clean!' : ` with ${faProgress.mistakes} wrong tap${faProgress.mistakes === 1 ? '' : 's'}.`}
        </span>
      )
    }
    return (
      <span className="fnt-prompt-text">
        Find every <strong className="fnt-target">{note}</strong>{' '}
        <span className="fnt-progress">
          {faProgress.found}/{faProgress.total}
        </span>
      </span>
    )
  }

  if (result) {
    const feedback = result.correct ? 'Correct!' : 'Not quite —'
    const cls = `fnt-prompt-feedback ${result.correct ? 'fnt-correct' : 'fnt-wrong'}`
    let reveal = ''
    if (question.mode === 'name') {
      reveal = ` that key is ${pcToName(question.pc, prefer)}.`
    } else {
      reveal = ` ${pcToName(question.pc, prefer)} is also at ${question.answerMidis
        .map((m) => midiToName(m, prefer))
        .join(', ')}.`
    }
    return (
      <span className={cls}>
        {feedback}
        {result.correct ? '' : reveal}
      </span>
    )
  }

  if (question.mode === 'find') {
    return (
      <span className="fnt-prompt-text">
        Find <strong className="fnt-target">{pcToName(question.pc, prefer)}</strong> anywhere on
        the keyboard
      </span>
    )
  }

  return <span className="fnt-prompt-text">Name the highlighted key</span>
}

/** Build keyboard markers for the single-answer (find / name) modes. */
function buildMarkers(
  question: TrainerQuestion | null,
  result: AnswerResult<TrainerQuestion, TrainerAnswer> | null,
  prefer: 'sharp' | 'flat',
): KeyboardMarker[] {
  if (!question) return []

  if (question.mode === 'name') {
    if (!result) {
      // Highlight the key but hide its name — that's the question.
      return [{ midi: question.midi, variant: 'root', label: '?' }]
    }
    return [
      {
        midi: question.midi,
        variant: result.correct ? 'correct' : 'incorrect',
        label: pcToName(question.pc, prefer),
      },
    ]
  }

  if (question.mode !== 'find') return []

  // find mode
  if (!result || result.answer.kind !== 'key') return []
  const clicked = result.answer
  const markers: KeyboardMarker[] = [
    {
      midi: clicked.midi,
      variant: result.correct ? 'correct' : 'incorrect',
      label: pcToName(midiToPc(clicked.midi), prefer),
    },
  ]
  if (!result.correct) {
    for (const midi of question.answerMidis) {
      markers.push({ midi, variant: 'correct', label: pcToName(question.pc, prefer) })
    }
  }
  return markers
}

/** Build keyboard markers for find-all mode: found keys plus a wrong flash. */
function buildFindAllMarkers(
  question: TrainerQuestion | null,
  found: readonly string[],
  wrong: number | null,
  prefer: 'sharp' | 'flat',
): KeyboardMarker[] {
  if (!question || question.mode !== 'findAll') return []
  const foundSet = new Set(found)
  const markers: KeyboardMarker[] = []
  for (const midi of question.targets) {
    if (foundSet.has(keyKey(midi))) {
      markers.push({ midi, variant: 'correct', label: pcToName(question.pc, prefer) })
    }
  }
  if (wrong !== null) {
    markers.push({ midi: wrong, variant: 'incorrect', label: pcToName(midiToPc(wrong), prefer) })
  }
  return markers
}
