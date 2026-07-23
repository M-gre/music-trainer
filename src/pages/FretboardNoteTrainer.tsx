/**
 * Fretboard Note Trainer — the app's first quiz tool. It is a thin React shell
 * over two pure cores:
 *  - `src/lib/quiz.ts` (`QuizSession`): score/streak/response-time tracking,
 *    reused by every future quiz tool.
 *  - `src/lib/fretboardTrainer.ts`: question generation, answer checking and
 *    persisted settings for this tool specifically.
 *
 * Two modes: "Find the note" (prompt names a note + string, tap the fret) and
 * "Name the note" (a fret is highlighted, pick the note). The shared
 * `Fretboard` renders the selected instrument/tuning, and marker variants show
 * correct/incorrect feedback. Audio only starts from the answer click
 * (`ensureRunning`), never at mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fretboard, type FretboardMarker, type FretPosition } from '../components/Fretboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { fretMidi } from '../lib/theory/instruments.ts'
import { midiToName, midiToPc, pcToName, type PitchClass } from '../lib/theory/notes.ts'
import {
  emptyStats,
  QuizSession,
  type AnswerResult,
  type QuizStats,
} from '../lib/quiz.ts'
import {
  checkAnswer,
  FRET_RANGE_PRESETS,
  generateQuestion,
  normalizeTrainerSettings,
  resolveIncludedStrings,
  trainerSettingsStore,
  type FretboardTrainerSettings,
  type QuestionContext,
  type QuizMode,
  type TrainerAnswer,
  type TrainerQuestion,
} from '../lib/fretboardTrainer.ts'

const PITCH_CLASSES: PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

/** How long the answer stays on screen before auto-advancing. */
const ADVANCE_MS_CORRECT = 900
const ADVANCE_MS_WRONG = 1700

const MODE_OPTIONS: { value: QuizMode; label: string }[] = [
  { value: 'find', label: 'Find the note' },
  { value: 'name', label: 'Name the note' },
]

export function FretboardNoteTrainer() {
  const { tuning, setTuningId } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())
  const timeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<FretboardTrainerSettings>(() =>
    normalizeTrainerSettings(trainerSettingsStore.get()),
  )

  useEffect(() => {
    trainerSettingsStore.set(settings)
  }, [settings])

  const stringCount = tuning.strings.length
  const includedStrings = useMemo(
    () => resolveIncludedStrings(settings.excludedStrings, stringCount),
    [settings.excludedStrings, stringCount],
  )

  // Live context read by the (stable) question generator, so the session never
  // needs recreating when settings change — the reset effect below handles it.
  const context: QuestionContext = {
    tuning,
    mode: settings.mode,
    fromFret: settings.fromFret,
    toFret: settings.toFret,
    includedStrings,
  }
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
  // changes (mode, range, strings, or tuning). Also runs on mount.
  const contextKey = `${tuning.id}|${settings.mode}|${settings.fromFret}|${settings.toFret}|${includedStrings.join(',')}`
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

  const handleFretClick = useCallback(
    (pos: FretPosition) => {
      submit({ kind: 'position', string: pos.string, fret: pos.fret }, pos.midi)
    },
    [submit],
  )

  const handlePcClick = useCallback(
    (pc: PitchClass) => {
      const q = sessionRef.current?.current
      if (!q || q.mode !== 'name') return
      submit({ kind: 'pc', pc }, fretMidi(tuning, q.string, q.fret))
    },
    [submit, tuning],
  )

  const prefer = settings.accidentals
  const markers = useMemo(
    () => buildMarkers(question, result, tuning, prefer),
    [question, result, tuning, prefer],
  )

  const answered = result !== null
  const openStringName = (index: number): string => midiToName(fretMidi(tuning, index, 0), prefer)

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Fretboard Note Trainer</h1>
        <p className="tool-page-lead">
          Learn every note on the neck for any bass or guitar tuning. Sound plays only when you
          answer.
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
          <span className="tool-control-label">Fret range</span>
          <div className="mn-segmented" role="group">
            {FRET_RANGE_PRESETS.map((preset) => {
              const active = settings.fromFret === preset.from && settings.toFret === preset.to
              return (
                <button
                  key={preset.id}
                  type="button"
                  className={`mn-segment${active ? ' mn-segment-active' : ''}`}
                  aria-pressed={active}
                  onClick={() =>
                    setSettings((s) => ({ ...s, fromFret: preset.from, toFret: preset.to }))
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

        <div className="tool-control-group">
          <span className="tool-control-label">Strings</span>
          <div className="mn-segmented" role="group">
            {Array.from({ length: stringCount }, (_, i) => stringCount - 1 - i).map((s) => {
              const on = includedStrings.includes(s)
              return (
                <button
                  key={s}
                  type="button"
                  className={`mn-segment${on ? ' mn-segment-active' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggleString(setSettings, s, includedStrings)}
                >
                  {openStringName(s)}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <InstrumentPicker value={tuning} onChange={(t) => setTuningId(t.id)} />

      <div className="fnt-prompt" role="status" aria-live="polite">
        <Prompt question={question} result={result} tuning={tuning} prefer={prefer} />
      </div>

      <Fretboard
        tuning={tuning}
        fromFret={settings.fromFret}
        toFret={settings.toFret}
        markers={markers}
        prefer={prefer}
        onFretClick={settings.mode === 'find' && !answered ? handleFretClick : undefined}
        ariaLabel={`${tuning.name} — ${settings.mode === 'find' ? 'tap the requested note' : 'name the highlighted note'}`}
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
  tuning: { strings: number[] }
  prefer: 'sharp' | 'flat'
}

function Prompt({ question, result, tuning, prefer }: PromptProps) {
  if (!question) return <span className="fnt-prompt-text">Loading…</span>

  if (result) {
    const feedback = result.correct ? 'Correct!' : 'Not quite —'
    const cls = `fnt-prompt-feedback ${result.correct ? 'fnt-correct' : 'fnt-wrong'}`
    let reveal = ''
    if (question.mode === 'name') {
      reveal = ` that note is ${pcToName(question.pc, prefer)}.`
    } else {
      reveal = ` ${pcToName(question.pc, prefer)} on that string is fret ${question.answerFrets
        .map(String)
        .join(' or ')}.`
    }
    return (
      <span className={cls}>
        {feedback}
        {result.correct ? '' : reveal}
      </span>
    )
  }

  if (question.mode === 'find') {
    const openMidi = tuning.strings[question.string]
    const stringLabel = openMidi === undefined ? `string ${question.string + 1}` : `${midiToName(openMidi, prefer)} string`
    return (
      <span className="fnt-prompt-text">
        Find <strong className="fnt-target">{pcToName(question.pc, prefer)}</strong> on the{' '}
        <strong>{stringLabel}</strong>
      </span>
    )
  }

  return <span className="fnt-prompt-text">Name the highlighted note</span>
}

/** Build fretboard markers for the current question + feedback state. */
function buildMarkers(
  question: TrainerQuestion | null,
  result: AnswerResult<TrainerQuestion, TrainerAnswer> | null,
  tuning: Parameters<typeof fretMidi>[0],
  prefer: 'sharp' | 'flat',
): FretboardMarker[] {
  if (!question) return []

  if (question.mode === 'name') {
    if (!result) {
      // Highlight the fret but hide its name — that's the question.
      return [{ string: question.string, fret: question.fret, variant: 'root', label: '?' }]
    }
    return [
      {
        string: question.string,
        fret: question.fret,
        variant: result.correct ? 'correct' : 'incorrect',
        label: pcToName(question.pc, prefer),
      },
    ]
  }

  // find mode
  if (!result || result.answer.kind !== 'position') return []
  const clicked = result.answer
  const markers: FretboardMarker[] = [
    {
      string: clicked.string,
      fret: clicked.fret,
      variant: result.correct ? 'correct' : 'incorrect',
      label: pcToName(midiToPc(fretMidi(tuning, clicked.string, clicked.fret)), prefer),
    },
  ]
  if (!result.correct) {
    for (const fret of question.answerFrets) {
      markers.push({
        string: question.string,
        fret,
        variant: 'correct',
        label: pcToName(question.pc, prefer),
      })
    }
  }
  return markers
}

/** Toggle a string in/out of the quiz, never leaving zero strings selected. */
function toggleString(
  setSettings: React.Dispatch<React.SetStateAction<FretboardTrainerSettings>>,
  index: number,
  includedStrings: number[],
): void {
  const currentlyOn = includedStrings.includes(index)
  if (currentlyOn && includedStrings.length === 1) return // keep at least one
  setSettings((s) => {
    const excluded = new Set(s.excludedStrings)
    if (currentlyOn) excluded.add(index)
    else excluded.delete(index)
    return { ...s, excludedStrings: Array.from(excluded).sort((a, b) => a - b) }
  })
}
