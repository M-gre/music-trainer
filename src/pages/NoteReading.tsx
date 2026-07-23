/**
 * Note Reading — draws a single random note on a staff and asks the player to
 * identify it through one of three input modes: name buttons, the on-screen
 * Fretboard (using the global tuning), or the Keyboard.
 *
 * The component stays thin: staff placement lives in `staffGeometry.ts`, and
 * the range/answer/persistence logic in `src/lib/noteReading.ts`, both pure and
 * unit-tested. This page owns React state (current note, streak/score,
 * feedback), the persisted settings, and audio playback.
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
import { midiToName, midiToPc, SHARP_NAMES } from '../lib/theory/notes.ts'
import {
  checkFretboardAnswer,
  checkKeyboardAnswer,
  checkNameAnswer,
  CLEF_RANGE,
  noteReadingSettingsStore,
  normalizeNoteReadingSettings,
  randomNote,
  type InputMode,
} from '../lib/noteReading.ts'

const FROM_FRET = 0
const TO_FRET = 12
const REVEAL_MS = 1200
/** Notes are drawn with sharps; a key picker (flat spelling) is a follow-up. */
const PREFER = 'sharp' as const

type Feedback = 'idle' | 'correct' | 'wrong'

const CLEF_LABEL: Record<Clef, string> = { bass: 'Bass', treble: 'Treble' }
const MODE_LABEL: Record<InputMode, string> = {
  name: 'Name',
  fretboard: 'Fretboard',
  keyboard: 'Keyboard',
}

export function NoteReading() {
  const { tuning } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [settings] = useState(() => normalizeNoteReadingSettings(noteReadingSettingsStore.get()))
  const [clef, setClef] = useState<Clef>(settings.clef)
  const [inputMode, setInputMode] = useState<InputMode>(settings.inputMode)

  const [target, setTarget] = useState<number>(() => randomNote(settings.clef))
  const [feedback, setFeedback] = useState<Feedback>('idle')
  const [streak, setStreak] = useState(0)
  const [best, setBest] = useState(0)
  const [score, setScore] = useState({ correct: 0, total: 0 })

  const locked = feedback !== 'idle'

  // Persist preferences whenever they change.
  useEffect(() => {
    noteReadingSettingsStore.set({ clef, inputMode })
  }, [clef, inputMode])

  const clearPending = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const nextQuestion = useCallback(
    (nextClef: Clef = clef) => {
      clearPending()
      setTarget((prev) => randomNote(nextClef, Math.random, prev))
      setFeedback('idle')
    },
    [clef, clearPending],
  )

  // Grade an answer, play the note so the ear learns it, and auto-advance.
  const submit = useCallback(
    (correct: boolean) => {
      if (locked) return
      const engine = engineRef.current
      void engine
        .ensureRunning()
        .then(() => engine.playNote(target, 1.1))
        .catch(() => {})
      setScore((s) => ({ correct: s.correct + (correct ? 1 : 0), total: s.total + 1 }))
      setStreak((s) => {
        const next = correct ? s + 1 : 0
        setBest((b) => Math.max(b, next))
        return next
      })
      setFeedback(correct ? 'correct' : 'wrong')
      timeoutRef.current = setTimeout(() => nextQuestion(), REVEAL_MS)
    },
    [locked, target, nextQuestion],
  )

  const changeClef = useCallback(
    (next: Clef) => {
      setClef(next)
      nextQuestion(next)
    },
    [nextQuestion],
  )

  // Tidy the auto-advance timer on unmount.
  useEffect(() => clearPending, [clearPending])

  // Reveal markers only after an answer, so the board doesn't give it away.
  const fretMarkers = useMemo<FretboardMarker[]>(() => {
    if (!locked) return []
    const markers: FretboardMarker[] = []
    const exactReachable = boardHas(tuning.strings.length, (s, f) => fretMidi(tuning, s, f) === target)
    for (let s = 0; s < tuning.strings.length; s++) {
      for (let f = FROM_FRET; f <= TO_FRET; f++) {
        const midi = fretMidi(tuning, s, f)
        const isTarget = exactReachable
          ? midi === target
          : midiToPc(midi) === midiToPc(target)
        if (isTarget) markers.push({ string: s, fret: f, variant: 'root', label: midiToName(midi, PREFER) })
      }
    }
    return markers
  }, [locked, tuning, target])

  const keyMarkers = useMemo<KeyboardMarker[]>(
    () => (locked ? [{ midi: target, variant: 'root', label: midiToName(target, PREFER) }] : []),
    [locked, target],
  )

  const range = CLEF_RANGE[clef]
  const answerName = midiToName(target, PREFER)

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Note Reading</h1>
        <p className="tool-page-lead">
          Read the note on the staff, then answer with the name buttons, the fretboard, or the
          keyboard. The note plays back so you connect the dots between page and sound.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Clef</span>
          <div className="nr-segmented" role="group" aria-label="Clef">
            {(['bass', 'treble'] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={`nr-segment${c === clef ? ' nr-segment-active' : ''}`}
                aria-pressed={c === clef}
                onClick={() => changeClef(c)}
              >
                {CLEF_LABEL[c]}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Answer with</span>
          <div className="nr-segmented" role="group" aria-label="Input mode">
            {(['name', 'fretboard', 'keyboard'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`nr-segment${m === inputMode ? ' nr-segment-active' : ''}`}
                aria-pressed={m === inputMode}
                onClick={() => setInputMode(m)}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={`nr-stage nr-stage-${feedback}`}>
        <Staff midi={target} clef={clef} prefer={PREFER} className="nr-staff" />
        <div className="nr-feedback" role="status" aria-live="polite">
          {feedback === 'idle' && <span className="nr-prompt">Name this note</span>}
          {feedback === 'correct' && <span className="nr-correct">Correct — {answerName}</span>}
          {feedback === 'wrong' && <span className="nr-wrong">It was {answerName}</span>}
        </div>
      </div>

      <div className="nr-scores">
        <div className="nr-score">
          <span className="nr-score-value">{streak}</span>
          <span className="nr-score-label">Streak</span>
        </div>
        <div className="nr-score">
          <span className="nr-score-value">{best}</span>
          <span className="nr-score-label">Best</span>
        </div>
        <div className="nr-score">
          <span className="nr-score-value">
            {score.correct}/{score.total}
          </span>
          <span className="nr-score-label">Correct</span>
        </div>
      </div>

      <div className="nr-answer">
        {inputMode === 'name' && (
          <div className="nr-names" role="group" aria-label="Note names">
            {SHARP_NAMES.map((name, pc) => (
              <button
                key={name}
                type="button"
                className="nr-name"
                disabled={locked}
                onClick={() => submit(checkNameAnswer(pc, target))}
              >
                {name}
              </button>
            ))}
          </div>
        )}

        {inputMode === 'fretboard' && (
          <Fretboard
            tuning={tuning}
            fromFret={FROM_FRET}
            toFret={TO_FRET}
            markers={fretMarkers}
            prefer={PREFER}
            onFretClick={
              locked
                ? undefined
                : (pos) =>
                    submit(checkFretboardAnswer(tuning, pos.midi, target, FROM_FRET, TO_FRET))
            }
            ariaLabel={`${tuning.name} — click the fret of the note`}
          />
        )}

        {inputMode === 'keyboard' && (
          <Keyboard
            from={range.low}
            to={range.high}
            markers={keyMarkers}
            prefer={PREFER}
            showLabels="c"
            onKeyClick={locked ? undefined : ({ midi }) => submit(checkKeyboardAnswer(midi, target))}
            ariaLabel="Click the key of the note"
          />
        )}
      </div>
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
