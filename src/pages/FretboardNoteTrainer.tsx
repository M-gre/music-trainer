/**
 * Fretboard Note Trainer — the app's first quiz tool. It is a thin React shell
 * over two pure cores:
 *  - `src/lib/quiz.ts`: `QuizSession` (score/streak/response-time for the
 *    single-answer modes) and `FindAllSession` (the multi-answer "find all"
 *    mode), reused by every future quiz tool.
 *  - `src/lib/fretboardTrainer.ts`: question generation, answer checking and
 *    persisted settings for this tool specifically.
 *
 * Three modes: "Find the note" (prompt names a note + string, tap the fret),
 * "Name the note" (a fret is highlighted, pick the note) and "Find all" (tap
 * every fret in range matching the prompted note; found ones stay lit). The
 * shared `Fretboard` renders the selected instrument/tuning, and marker
 * variants show correct/incorrect feedback. Audio only starts from the answer
 * click (`ensureRunning`), never at mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fretboard, type FretboardMarker, type FretPosition } from '../components/Fretboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { NoteStatsPanel } from '../components/NoteStatsPanel.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { fretMidi } from '../lib/theory/instruments.ts'
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
  fretboardStatsStore,
  normalizeNoteStats,
  recordFindAllRound,
  recordOutcome,
  type NoteStatsData,
} from '../lib/noteStats.ts'
import {
  checkAnswer,
  findAllTargetKeys,
  fretboardSrsStore,
  FRET_RANGE_PRESETS,
  generateQuestion,
  MAX_FRET,
  normalizeTrainerSettings,
  positionKey,
  resolveIncludedStrings,
  srsKeyForPc,
  trainerSettingsStore,
  type FindAllQuestion,
  type FretboardTrainerSettings,
  type Position,
  type QuestionContext,
  type QuizMode,
  type TrainerAnswer,
  type TrainerQuestion,
} from '../lib/fretboardTrainer.ts'
import {
  normalizeSrsData,
  qualityFromOutcome,
  reviewKey,
  type SrsData,
} from '../lib/spacedRepetition.ts'
import { useAnswerShortcuts } from '../hooks/useAnswerShortcuts.ts'
import { shortcutLabel } from '../lib/answerShortcuts.ts'

const PITCH_CLASSES: PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

/** How long the answer stays on screen before auto-advancing. */
const ADVANCE_MS_CORRECT = 900
const ADVANCE_MS_WRONG = 1700
/** How long a wrong tap flashes red in find-all mode. */
const WRONG_FLASH_MS = 650

const EMPTY_PROGRESS: FindAllProgress = { found: 0, total: 0, mistakes: 0, complete: false }

const MODE_OPTIONS: { value: QuizMode; label: string }[] = [
  { value: 'find', label: 'Find the note' },
  { value: 'name', label: 'Name the note' },
  { value: 'findAll', label: 'Find all' },
]

const FRET_OPTIONS = Array.from({ length: MAX_FRET + 1 }, (_, f) => f)

export function FretboardNoteTrainer() {
  const { tuning, setTuningId } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())
  const timeoutRef = useRef<number | null>(null)
  const wrongTimeoutRef = useRef<number | null>(null)

  const [settings, setSettings] = useState<FretboardTrainerSettings>(() =>
    normalizeTrainerSettings(trainerSettingsStore.get()),
  )

  useEffect(() => {
    trainerSettingsStore.set(settings)
  }, [settings])

  const [noteStats, setNoteStats] = useState<NoteStatsData>(() =>
    normalizeNoteStats(fretboardStatsStore.get()),
  )
  // Spaced-repetition schedule (per pitch class); blended into weakest-first
  // picking so notes that are due for review resurface.
  const [srs, setSrs] = useState<SrsData>(() => normalizeSrsData(fretboardSrsStore.get()))
  // Refs so the stable question generator reads the latest stats / toggle.
  const statsRef = useRef(noteStats)
  statsRef.current = noteStats
  const srsRef = useRef(srs)
  srsRef.current = srs
  const focusWeakRef = useRef(settings.focusWeak)
  focusWeakRef.current = settings.focusWeak

  const stringCount = tuning.strings.length
  const includedStrings = useMemo(
    () => resolveIncludedStrings(settings.excludedStrings, stringCount),
    [settings.excludedStrings, stringCount],
  )

  // Live context read by the (stable) question generator.
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
  const faSessionRef = useRef<FindAllSession<FindAllQuestion, Position> | null>(null)
  const [question, setQuestion] = useState<TrainerQuestion | null>(null)
  const [stats, setStats] = useState<QuizStats>(emptyStats)
  const [result, setResult] = useState<AnswerResult<TrainerQuestion, TrainerAnswer> | null>(null)
  const [faProgress, setFaProgress] = useState<FindAllProgress>(EMPTY_PROGRESS)
  const [faFound, setFaFound] = useState<readonly string[]>([])
  const [faWrong, setFaWrong] = useState<Position | null>(null)

  // Weakest-first picking parameters, or `undefined` when the toggle is off.
  // Reads refs so the (stable) generator always sees the current stats/toggle.
  const picking = useCallback(
    () =>
      focusWeakRef.current
        ? { stats: statsRef.current, now: Date.now(), srs: srsRef.current }
        : undefined,
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

  // Reset and draw a fresh question whenever the answerable set changes (mode,
  // range, strings, or tuning). Also runs on mount.
  const contextKey = `${tuning.id}|${settings.mode}|${settings.fromFret}|${settings.toFret}|${includedStrings.join(',')}`
  useEffect(() => {
    clearPendingAdvance()
    clearWrongFlash()
    if (settings.mode === 'findAll') {
      const session = new FindAllSession<FindAllQuestion, Position>({
        generate: (previous, rng) =>
          generateQuestion(contextRef.current, previous, rng, picking()) as FindAllQuestion,
        targetsOf: findAllTargetKeys,
        keyOf: (p) => positionKey(p.string, p.fret),
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
      const now = Date.now()
      setNoteStats(
        fretboardStatsStore.update((d) =>
          recordOutcome(d, res.question.pc, res.correct, res.responseMs, now),
        ),
      )
      setSrs(
        fretboardSrsStore.update((d) =>
          reviewKey(
            d,
            srsKeyForPc(res.question.pc),
            qualityFromOutcome(res.correct, res.responseMs),
            now,
          ),
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
    (pos: FretPosition) => {
      const session = faSessionRef.current
      if (!session || !session.current || session.isComplete) return
      const res = session.submit({ string: pos.string, fret: pos.fret })
      setFaProgress(res.progress)
      setFaFound(session.foundKeys)
      setStats(session.stats)

      const engine = engineRef.current
      void engine.ensureRunning().then(() => engine.playNote(pos.midi, 0.7))

      if (res.outcome === 'wrong') {
        setFaWrong({ string: pos.string, fret: pos.fret })
        clearWrongFlash()
        wrongTimeoutRef.current = window.setTimeout(() => {
          setFaWrong(null)
          wrongTimeoutRef.current = null
        }, WRONG_FLASH_MS)
      }
      if (res.justCompleted) {
        const q = session.current
        if (q) {
          const now = Date.now()
          setNoteStats(
            fretboardStatsStore.update((d) =>
              recordFindAllRound(d, [q.pc], q.pc, res.progress.mistakes, now),
            ),
          )
          // A clean round is a full pass; wrong taps drop the review quality
          // below the pass threshold so the note is scheduled sooner.
          const quality = res.progress.mistakes === 0 ? 1 : 0.4
          setSrs(
            fretboardSrsStore.update((d) => reviewKey(d, srsKeyForPc(q.pc), quality, now)),
          )
        }
        clearPendingAdvance()
        timeoutRef.current = window.setTimeout(advance, ADVANCE_MS_CORRECT)
      }
    },
    [advance, clearPendingAdvance, clearWrongFlash],
  )

  const handleFretClick = useCallback(
    (pos: FretPosition) => {
      if (settings.mode === 'findAll') faSubmit(pos)
      else submit({ kind: 'position', string: pos.string, fret: pos.fret }, pos.midi)
    },
    [settings.mode, faSubmit, submit],
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
  const markers = useMemo(() => {
    if (settings.mode === 'findAll')
      return buildFindAllMarkers(question, faFound, faWrong, tuning, prefer)
    return buildMarkers(question, result, tuning, prefer)
  }, [settings.mode, question, faFound, faWrong, result, tuning, prefer])

  const answered = result !== null
  const findClickable = settings.mode === 'find' && !answered
  const findAllClickable = settings.mode === 'findAll' && !faProgress.complete
  const openStringName = (index: number): string => midiToName(fretMidi(tuning, index, 0), prefer)

  // In "Name the note" mode, number keys 1–9 pick the first nine note buttons
  // (C … G♯); the remaining notes stay tap-only. Disabled once answered or in
  // the tap-the-fret modes, which have no fixed button order to bind.
  const nameMode = settings.mode === 'name'
  const selectNote = useCallback(
    (index: number) => {
      const pc = PITCH_CLASSES[index]
      if (pc !== undefined) handlePcClick(pc)
    },
    [handlePcClick],
  )
  useAnswerShortcuts({
    optionCount: nameMode && !answered ? PITCH_CLASSES.length : 0,
    onSelect: selectNote,
  })

  const resetStats = useCallback(() => {
    fretboardStatsStore.clear()
    setNoteStats(emptyNoteStats())
    fretboardSrsStore.clear()
    setSrs({})
  }, [])

  const setFret = (which: 'fromFret' | 'toFret', value: number): void => {
    setSettings((s) => {
      const next = { ...s, [which]: value }
      // Keep the range ordered without silently reordering the user's pick.
      if (which === 'fromFret' && value > s.toFret) next.toFret = value
      if (which === 'toFret' && value < s.fromFret) next.fromFret = value
      return next
    })
  }

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
          <div className="mn-segmented" role="group" aria-label="Quiz mode">
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
          <div className="mn-segmented" role="group" aria-label="Fret range preset">
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
          <div className="fnt-range-row">
            <label className="fnt-range-field">
              <span>Min</span>
              <select
                className="fnt-range-select"
                value={settings.fromFret}
                onChange={(e) => setFret('fromFret', Number(e.target.value))}
                aria-label="Lowest fret"
              >
                {FRET_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <span className="fnt-range-sep" aria-hidden="true">
              –
            </span>
            <label className="fnt-range-field">
              <span>Max</span>
              <select
                className="fnt-range-select"
                value={settings.toFret}
                onChange={(e) => setFret('toFret', Number(e.target.value))}
                aria-label="Highest fret"
              >
                {FRET_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Accidentals</span>
          <div className="mn-segmented" role="group" aria-label="Accidentals">
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
          <div className="mn-segmented" role="group" aria-label="Strings included in the quiz">
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

        <div className="tool-control-group">
          <span className="tool-control-label">Focus</span>
          <div className="mn-segmented" role="group" aria-label="Focus weak notes">
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

      <InstrumentPicker value={tuning} onChange={(t) => setTuningId(t.id)} />

      <div className="fnt-prompt" role="status" aria-live="polite">
        <Prompt
          question={question}
          result={result}
          faProgress={faProgress}
          tuning={tuning}
          prefer={prefer}
        />
      </div>

      <Fretboard
        tuning={tuning}
        fromFret={settings.fromFret}
        toFret={settings.toFret}
        markers={markers}
        prefer={prefer}
        onFretClick={findClickable || findAllClickable ? handleFretClick : undefined}
        ariaLabel={`${tuning.name} — ${
          settings.mode === 'name' ? 'name the highlighted note' : 'tap the requested note'
        }`}
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
            const key = shortcutLabel(pc)
            return (
              <button
                key={pc}
                type="button"
                className={cls.join(' ')}
                disabled={answered}
                title={key ? `Shortcut: press ${key}` : undefined}
                onClick={() => handlePcClick(pc)}
              >
                {key && (
                  <span className="sc-key" aria-hidden="true">
                    {key}
                  </span>
                )}
                {pcToName(pc, prefer)}
              </button>
            )
          })}
        </div>
      )}

      {settings.mode === 'findAll' && (
        <p className="fnt-hint">
          Streak counts a note only when you find every position with no wrong taps.
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
  tuning: { strings: number[] }
  prefer: 'sharp' | 'flat'
}

function Prompt({ question, result, faProgress, tuning, prefer }: PromptProps) {
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
    const stringLabel =
      openMidi === undefined
        ? `string ${question.string + 1}`
        : `${midiToName(openMidi, prefer)} string`
    return (
      <span className="fnt-prompt-text">
        Find <strong className="fnt-target">{pcToName(question.pc, prefer)}</strong> on the{' '}
        <strong>{stringLabel}</strong>
      </span>
    )
  }

  return <span className="fnt-prompt-text">Name the highlighted note</span>
}

/** Build fretboard markers for the single-answer (find / name) modes. */
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

  if (question.mode !== 'find') return []

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

/** Build fretboard markers for find-all mode: found positions plus a wrong flash. */
function buildFindAllMarkers(
  question: TrainerQuestion | null,
  found: readonly string[],
  wrong: Position | null,
  tuning: Parameters<typeof fretMidi>[0],
  prefer: 'sharp' | 'flat',
): FretboardMarker[] {
  if (!question || question.mode !== 'findAll') return []
  const foundSet = new Set(found)
  const markers: FretboardMarker[] = []
  for (const t of question.targets) {
    if (foundSet.has(positionKey(t.string, t.fret))) {
      markers.push({
        string: t.string,
        fret: t.fret,
        variant: 'correct',
        label: pcToName(question.pc, prefer),
      })
    }
  }
  if (wrong) {
    markers.push({
      string: wrong.string,
      fret: wrong.fret,
      variant: 'incorrect',
      label: pcToName(midiToPc(fretMidi(tuning, wrong.string, wrong.fret)), prefer),
    })
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
