/**
 * Keyboard Note Trainer — the same quiz modes as the Fretboard Note Trainer
 * (see `FretboardNoteTrainer.tsx`), applied to the `Keyboard` component. Two
 * thin cores are reused:
 *  - `src/lib/quiz.ts` (`QuizSession`): score/streak/response-time tracking.
 *  - `src/lib/keyboardTrainer.ts`: question generation, answer checking and
 *    persisted settings for this tool specifically.
 *
 * Two modes: "Find the note" (prompt names a note, tap any matching key in
 * the visible octave range) and "Name the key" (a key is highlighted, pick
 * the note). Marker variants and feedback mirror the fretboard trainer's UX.
 * Audio only starts from the answer click (`ensureRunning`), never at mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, type KeyboardMarker } from '../components/Keyboard.tsx'
import { octaveRangeToMidi } from '../components/keyboardGeometry.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { midiToName, midiToPc, pcToName, type PitchClass } from '../lib/theory/notes.ts'
import { emptyStats, QuizSession, type AnswerResult, type QuizStats } from '../lib/quiz.ts'
import {
  checkAnswer,
  generateQuestion,
  keyboardTrainerSettingsStore,
  normalizeTrainerSettings,
  OCTAVE_RANGE_PRESETS,
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

const MODE_OPTIONS: { value: QuizMode; label: string }[] = [
  { value: 'find', label: 'Find the note' },
  { value: 'name', label: 'Name the key' },
]

export function KeyboardNoteTrainer() {
  const engineRef = useRef(getAudioEngine())
  const timeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<KeyboardTrainerSettings>(() =>
    normalizeTrainerSettings(keyboardTrainerSettingsStore.get()),
  )

  useEffect(() => {
    keyboardTrainerSettingsStore.set(settings)
  }, [settings])

  const { from: fromMidi, to: toMidi } = useMemo(
    () => octaveRangeToMidi(settings.fromOctave, settings.toOctave),
    [settings.fromOctave, settings.toOctave],
  )

  // Live context read by the (stable) question generator, so the session
  // never needs recreating when settings change — the reset effect below
  // handles it.
  const context: QuestionContext = { mode: settings.mode, fromMidi, toMidi }
  const contextRef = useRef(context)
  contextRef.current = context

  const sessionRef = useRef<QuizSession<TrainerQuestion, TrainerAnswer> | null>(null)
  const [question, setQuestion] = useState<TrainerQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [result, setResult] = useState<AnswerResult<TrainerQuestion, TrainerAnswer> | null>(null)

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

  // Reset the session and draw a fresh question whenever the answerable set
  // changes (mode or octave range). Also runs on mount.
  const contextKey = `${settings.mode}|${fromMidi}|${toMidi}`
  useEffect(() => {
    clearPendingAdvance()
    if (!sessionRef.current) {
      sessionRef.current = new QuizSession<TrainerQuestion, TrainerAnswer>({
        generate: (previous, rng) => generateQuestion(contextRef.current, previous, rng),
        check: checkAnswer,
        clock: () => performance.now(),
      })
    } else {
      sessionRef.current.reset()
    }
    sessionRef.current.next()
    setQuestion(sessionRef.current.current)
    setStats(sessionRef.current.stats)
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contextKey])

  useEffect(() => () => clearPendingAdvance(), [clearPendingAdvance])

  const submit = useCallback(
    (answer: TrainerAnswer, midiToPlay: number) => {
      const session = sessionRef.current
      if (!session || !session.current || session.isAnswered) return
      const res = session.answer(answer)
      setResult(res)
      setStats(session.stats)

      // Aural feedback. ensureRunning is safe: we are inside a click handler.
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

  const handleKeyClick = useCallback(
    (key: { midi: number }) => {
      submit({ kind: 'key', midi: key.midi }, key.midi)
    },
    [submit],
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
  const markers = useMemo(
    () => buildMarkers(question, result, prefer),
    [question, result, prefer],
  )

  const answered = result !== null

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
      </div>

      <div className="fnt-prompt" role="status" aria-live="polite">
        <Prompt question={question} result={result} prefer={prefer} />
      </div>

      <Keyboard
        fromOctave={settings.fromOctave}
        toOctave={settings.toOctave}
        markers={markers}
        prefer={prefer}
        showLabels="c"
        onKeyClick={settings.mode === 'find' && !answered ? handleKeyClick : undefined}
        ariaLabel={
          settings.mode === 'find' ? 'piano keyboard — tap the requested key' : 'piano keyboard — name the highlighted key'
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
    </div>
  )
}

interface PromptProps {
  question: TrainerQuestion | null
  result: AnswerResult<TrainerQuestion, TrainerAnswer> | null
  prefer: 'sharp' | 'flat'
}

function Prompt({ question, result, prefer }: PromptProps) {
  if (!question) return <span className="fnt-prompt-text">Loading…</span>

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

/** Build keyboard markers for the current question + feedback state. */
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
