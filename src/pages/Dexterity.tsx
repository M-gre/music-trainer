/**
 * Dexterity Exercises (M5) — renders fret/finger exercise patterns on the shared
 * `Fretboard` with the finger number as each dot's label, plays them back in
 * time with the metronome `Scheduler`, and advances a highlighted current-step
 * marker in sync.
 *
 * All the musical thinking lives in the pure, tested `src/lib/exercises.ts`
 * (pattern format + expansion + step sequencing + position advance) and
 * `src/lib/dexteritySettings.ts` (persisted preferences). This component is the
 * thin impure shell: React state, the `Scheduler`/`AudioEngine` wiring, a
 * requestAnimationFrame indicator driven by `scheduler.currentPosition()`, and
 * persistence. Following the other tool pages, the AudioContext is created and
 * resumed only inside the Start handler (`ensureRunning`), never at mount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fretboard, type FretboardMarker, type MarkerVariant } from '../components/Fretboard.tsx'
import { Keyboard, type KeyboardMarker } from '../components/Keyboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import {
  DEFAULT_CLICK_VOICE_ID,
  getAudioEngine,
  resolveClickParams,
  Scheduler,
  secondsPerSubdivision,
  type SchedulerEvent,
} from '../lib/audio/index.ts'
import {
  clampBpm,
  clampFret,
  dexteritySettingsStore,
  MAX_BPM,
  MAX_FRET,
  MIN_BPM,
  MIN_FRET,
  normalizeDexteritySettings,
  type DexterityMode,
} from '../lib/dexteritySettings.ts'
import {
  ANCHOR_SAME_STRING,
  applyDirection,
  BUILTIN_PATTERNS,
  CHROMATIC_POSITION_SHIFT,
  DIRECTIONS,
  expandPattern,
  getPattern,
  LEGATO_HAMMER_ASC,
  locateStep,
  positionForLoop,
  ROLL_ONE_FINGER,
  STRETCH_124,
  STRING_CROSSING_12,
  TRILL_12,
  type Direction,
  type ExerciseStep,
  type PatternCategory,
} from '../lib/exercises.ts'
import {
  ACCENT_EVERY_N_OPTIONS,
  type AccentEveryN,
  applyAccent,
  getRhythm,
  noteDurationsTicks,
  RHYTHM_RESOLUTION,
  RHYTHMS,
  rhythmizeSteps,
  rhythmTiming,
  type RhythmId,
} from '../lib/rhythmVariations.ts'
import {
  applyPianoDirection,
  buildFiveFinger,
  buildScale,
  clampPianoOctave,
  FIVE_FINGER_PATTERNS,
  FIVE_FINGER_QUALITIES,
  type FiveFingerPatternId,
  type FiveFingerQuality,
  getFiveFingerPattern,
  type Hand,
  HANDS,
  MAX_PIANO_OCTAVE,
  MIN_PIANO_OCTAVE,
  type PianoExerciseKind,
  PIANO_EXERCISE_KINDS,
  type PianoStep,
  rootMidi,
  SCALE_OCTAVE_OPTIONS,
  type ScaleOctaves,
} from '../lib/pianoExercises.ts'
import { midiToName, pcToName, type PitchClass } from '../lib/theory/notes.ts'
import { getScale, SCALES } from '../lib/theory/scales.ts'
import {
  expandScaleSequence,
  getSequencePattern,
  SEQUENCE_PATTERNS,
  type SequencePatternId,
} from '../lib/scaleSequences.ts'
import {
  arpeggioQualityGroups,
  expandArpeggio,
  getArpeggioQuality,
  inversionsForIntervals,
  type Inversion,
} from '../lib/arpeggioDrills.ts'
import {
  ALL_PERMUTATION_PATTERNS,
  dailyPermutationSet,
  dateKey,
  getPermutationPattern,
  permutationId,
} from '../lib/permutations.ts'
import {
  DEFAULT_STEP_DURATION,
  type DrillConfig,
  drillConfigLabel,
  estimateRoutineSeconds,
  expandDrillConfig,
  MAX_STEP_LOOPS,
  MAX_STEP_MINUTES,
  MIN_STEP_LOOPS,
  MIN_STEP_MINUTES,
  moveStep,
  normalizeRoutinesState,
  removeStep,
  type Routine,
  type RoutineStep,
  routinesStore,
  type StepDuration,
  stepIsComplete,
} from '../lib/warmupRoutines.ts'

/** Labels for the accent-every-N control (0 = the accent layer is off). */
const ACCENT_LABELS: Record<number, string> = {
  0: 'Off',
  2: '2',
  3: '3',
  4: '4',
}

const DIRECTION_LABELS: Record<Direction, string> = {
  forward: 'Forward',
  reverse: 'Reverse',
  'forward-reverse': 'Forward + Reverse',
}

const HAND_LABELS: Record<Hand, string> = { right: 'Right', left: 'Left' }
const QUALITY_LABELS: Record<FiveFingerQuality, string> = { major: 'Major', minor: 'Minor' }

/**
 * Adapt piano steps to the fretted `ExerciseStep` shape the rhythm layer and
 * scheduler consume. Only the midi is meaningful for playback; the board fields
 * are placeholders (piano mode renders the `Keyboard`, not the fretboard, and
 * reads finger/hand from the `PianoStep`s directly). Keeping the same array
 * length + order as the display steps keeps the active-step index aligned.
 */
function pianoStepsAsExercise(steps: readonly PianoStep[]): ExerciseStep[] {
  return steps.map((s) => ({ string: 0, fret: 0, finger: 1, duration: 1, midi: s.midi }))
}

/**
 * The flat catalog of exercise *types*. Each is a small number of patterns (or
 * a whole scale/arpeggio family) reached through per-drill parameters, rather
 * than one card per pattern. The pattern-backed drills map onto a
 * `PatternCategory`; `scale` and `arpeggio` map onto the two non-pattern modes.
 */
type DrillType = PatternCategory | 'scale' | 'arpeggio'

interface DrillMeta {
  id: DrillType
  name: string
  tagline: string
}

const DRILLS: readonly DrillMeta[] = [
  { id: 'spider', name: 'Spider walk', tagline: 'One finger per fret — any of 24 finger orders' },
  { id: 'crossing', name: 'String crossing', tagline: 'Clean changes across adjacent & skipped strings' },
  { id: 'shift', name: 'Position shift', tagline: 'Move the hand up the neck mid-phrase' },
  { id: 'roll', name: 'Finger rolls', tagline: 'Same fret rolled across adjacent strings' },
  { id: 'trill', name: 'Trills & bursts', tagline: 'Rapid two-finger alternation per string' },
  { id: 'stretch', name: 'Wide stretch', tagline: 'Finger-independence spans — 1-2-4, 1-3-4, 5-fret' },
  { id: 'anchor', name: 'Anchor hold', tagline: 'Hold one finger while the others move' },
  { id: 'legato', name: 'Legato slurs', tagline: 'Hammer-on / pull-off runs, shown with H / P' },
  { id: 'scale', name: 'Scale sequence', tagline: 'Run a scale through a sequence pattern' },
  { id: 'arpeggio', name: 'Arpeggio', tagline: 'Chord tones across strings & inversions' },
]

/** The pattern id a pattern-backed drill lands on when first selected. */
const CATEGORY_DEFAULT_PATTERN: Record<PatternCategory, string> = {
  spider: permutationId([1, 2, 3, 4]),
  crossing: STRING_CROSSING_12.id,
  shift: CHROMATIC_POSITION_SHIFT.id,
  roll: ROLL_ONE_FINGER.id,
  trill: TRILL_12.id,
  stretch: STRETCH_124.id,
  anchor: ANCHOR_SAME_STRING.id,
  legato: LEGATO_HAMMER_ASC.id,
}

/** The pattern-backed drills, in `DRILLS` order — used to build the "Variant" pickers. */
const PATTERN_DRILLS: readonly PatternCategory[] = [
  'spider',
  'crossing',
  'shift',
  'roll',
  'trill',
  'stretch',
  'anchor',
  'legato',
]

function isPatternDrill(d: DrillType): d is PatternCategory {
  return (PATTERN_DRILLS as readonly string[]).includes(d)
}

/** The twelve pitch classes as root options for the scale-sequence picker. */
const ROOT_PCS: readonly PitchClass[] = Array.from({ length: 12 }, (_, i) => i)

/** Fraction of a grid step a note sounds for, leaving a small gap between notes. */
const NOTE_LENGTH = 0.9

export function Dexterity() {
  const engineRef = useRef(getAudioEngine())
  const schedulerRef = useRef<Scheduler | null>(null)
  const rafRef = useRef<number | null>(null)

  const instrument = useInstrumentSettings()
  const tuning = instrument.tuning

  const [settings] = useState(() => normalizeDexteritySettings(dexteritySettingsStore.get()))
  const [mode, setMode] = useState<DexterityMode>(settings.mode)
  const [patternId, setPatternId] = useState(settings.patternId)
  const [scaleRootPc, setScaleRootPc] = useState<PitchClass>(settings.scaleRootPc)
  const [scaleId, setScaleId] = useState(settings.scaleId)
  const [sequenceId, setSequenceId] = useState<SequencePatternId>(settings.sequenceId)
  const [arpRootPc, setArpRootPc] = useState<PitchClass>(settings.arpRootPc)
  const [arpQualityId, setArpQualityId] = useState(settings.arpQualityId)
  const [arpInversion, setArpInversion] = useState<Inversion>(settings.arpInversion)
  const [position, setPosition] = useState(settings.position)
  const [bpm, setBpm] = useState(settings.bpm)
  const [rhythmId, setRhythmId] = useState<RhythmId>(settings.rhythmId)
  const [accentEveryN, setAccentEveryN] = useState<AccentEveryN>(settings.accentEveryN)
  const [autoAdvance, setAutoAdvance] = useState(settings.autoAdvance)
  const [advanceMin, setAdvanceMin] = useState(settings.advanceMin)
  const [advanceMax, setAdvanceMax] = useState(settings.advanceMax)
  const [direction, setDirection] = useState<Direction>(settings.direction)
  const [clickOn, setClickOn] = useState(true)

  // Piano (keyboard) mode — a page-local instrument context alongside the
  // fretted instrument picker. When on, the catalog/board/player switch to the
  // piano exercises and the fret-based settings hide.
  const [pianoMode, setPianoMode] = useState(settings.pianoMode)
  const [pianoKind, setPianoKind] = useState<PianoExerciseKind>(settings.pianoKind)
  const [pianoRootPc, setPianoRootPc] = useState<PitchClass>(settings.pianoRootPc)
  const [pianoOctave, setPianoOctave] = useState(settings.pianoOctave)
  const [pianoQuality, setPianoQuality] = useState<FiveFingerQuality>(settings.pianoQuality)
  const [pianoPatternId, setPianoPatternId] = useState<FiveFingerPatternId>(settings.pianoPatternId)
  const [pianoHand, setPianoHand] = useState<Hand>(settings.pianoHand)
  const [pianoOctaves, setPianoOctaves] = useState<ScaleOctaves>(settings.pianoOctaves)

  const [running, setRunning] = useState(false)
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null)
  const [activeLoop, setActiveLoop] = useState(0)

  // --- Warm-up routine builder + player -------------------------------------
  // The working (unsaved) routine being built/played; saved routines live in
  // the versioned `routinesStore`. The active routine step index is `null` when
  // no routine is playing. Advancement is driven from the rAF indicator below.
  const [savedState, setSavedState] = useState(() => normalizeRoutinesState(routinesStore.get()))
  // Reopen with the last-played routine loaded into the builder, if any.
  const lastUsedRoutine = savedState.routines.find((r) => r.id === savedState.lastUsedId)
  const [routineSteps, setRoutineSteps] = useState<RoutineStep[]>(() =>
    lastUsedRoutine ? [...lastUsedRoutine.steps] : [],
  )
  const [routineName, setRoutineName] = useState(() => lastUsedRoutine?.name ?? '')
  const [routineIndex, setRoutineIndex] = useState<number | null>(null)
  const [transitionLabel, setTransitionLabel] = useState<string | null>(null)

  const routineStepsRef = useRef<RoutineStep[]>([])
  const routineIndexRef = useRef<number | null>(null)
  const stepStartStepRef = useRef<number | null>(null)
  const stepStartTimeRef = useRef(0)
  const bannerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const advanceRoutineRef = useRef<() => void>(() => {})

  const pattern = useMemo(() => getPermutationPattern(patternId) ?? getPattern(patternId), [patternId])
  const rhythm = useMemo(() => getRhythm(rhythmId), [rhythmId])
  const scale = useMemo(() => getScale(scaleId), [scaleId])
  const sequence = useMemo(() => getSequencePattern(sequenceId), [sequenceId])
  const arpQuality = useMemo(() => getArpeggioQuality(arpQualityId), [arpQualityId])
  const arpQualityGroups = useMemo(() => arpeggioQualityGroups(), [])
  // 3rd inversion only offered for 4-note (7th) chords; snap back if the chord
  // shrinks to a triad while '3rd' is selected.
  const availableInversions = useMemo(
    () => inversionsForIntervals(arpQuality.intervals.length),
    [arpQuality],
  )
  useEffect(() => {
    if (!availableInversions.some((i) => i.id === arpInversion)) setArpInversion('root')
  }, [availableInversions, arpInversion])

  // "Today" is read from the wall clock once, here at the page level, and
  // handed to the pure daily-set generator as a plain date string — the
  // permutation lib itself never touches `Date.now()`/`new Date()` so it stays
  // deterministic and unit-testable.
  const today = useMemo(() => new Date(), [])
  const todayKey = useMemo(() => dateKey(today), [today])
  const dailySet = useMemo(() => dailyPermutationSet(todayKey), [todayKey])
  const range = useMemo(
    () => (autoAdvance ? { min: Math.min(advanceMin, advanceMax), max: Math.max(advanceMin, advanceMax) } : undefined),
    [autoAdvance, advanceMin, advanceMax],
  )

  // The position currently on the board: the chosen start when stopped, or the
  // auto-advanced position for the loop being heard when running.
  const displayPosition = running ? positionForLoop(activeLoop, position, range) : position

  const displaySteps = useMemo(() => {
    let raw: ExerciseStep[]
    if (mode === 'scale') {
      raw = expandScaleSequence({ tuning, root: scaleRootPc, scale, patternId: sequenceId, anchor: displayPosition })
    } else if (mode === 'arpeggio') {
      raw = expandArpeggio({
        tuning,
        root: arpRootPc,
        intervals: arpQuality.intervals,
        inversion: arpInversion,
        anchor: displayPosition,
      })
    } else {
      raw = expandPattern(pattern, { tuning, position: displayPosition })
    }
    return applyDirection(raw, direction)
  }, [mode, pattern, tuning, scaleRootPc, scale, sequenceId, arpRootPc, arpQuality, arpInversion, displayPosition, direction])

  // Piano steps, ascending, then with the playback direction applied — the
  // keyboard analog of `displaySteps`. `fiveFinger` also stores the chosen
  // pattern def for the description panel.
  const fiveFingerDef = useMemo(() => getFiveFingerPattern(pianoPatternId), [pianoPatternId])
  const pianoAscending = useMemo(() => {
    if (pianoKind === 'scale') {
      return buildScale({ root: pianoRootPc, octave: pianoOctave, octaves: pianoOctaves, hand: pianoHand })
    }
    return buildFiveFinger({
      root: pianoRootPc,
      octave: pianoOctave,
      quality: pianoQuality,
      patternId: pianoPatternId,
      hand: pianoHand,
    })
  }, [pianoKind, pianoRootPc, pianoOctave, pianoOctaves, pianoHand, pianoQuality, pianoPatternId])
  const displayPianoSteps = useMemo(
    () => applyPianoDirection(pianoAscending, direction),
    [pianoAscending, direction],
  )

  // The step sequence the rhythm layer + scheduler operate on: the piano steps
  // (adapted to the fretted step shape) in piano mode, else the fretted steps.
  // Same length/order as the mode's display steps, so the active index aligns.
  const activeSteps = useMemo(
    () => (pianoMode ? pianoStepsAsExercise(displayPianoSteps) : displaySteps),
    [pianoMode, displayPianoSteps, displaySteps],
  )

  // Lay the steps onto the chosen rhythm, then apply the accent layer. The
  // rhythmized events drive the strip's accent emphasis; their grid timing (at
  // the fine RHYTHM_RESOLUTION) is shared by the rAF indicator and the audio
  // callback. Step count is independent of the position, so this is valid for
  // every loop.
  const rhythmized = useMemo(() => rhythmizeSteps(activeSteps, rhythm), [activeSteps, rhythm])
  const displayEvents = useMemo(
    () => applyAccent(rhythmized.events, accentEveryN),
    [rhythmized, accentEveryN],
  )
  const timing = useMemo(() => rhythmTiming(rhythmized), [rhythmized])
  const timingRef = useRef(timing)
  timingRef.current = timing

  // Live values the stable scheduler callback reads (so its identity never
  // changes as settings do), mirroring the Metronome page.
  const patternRef = useRef(pattern)
  const tuningRef = useRef(tuning)
  const positionRef = useRef(position)
  const rangeRef = useRef(range)
  const rhythmRef = useRef(rhythm)
  const accentNRef = useRef(accentEveryN)
  const bpmRef = useRef(bpm)
  const clickRef = useRef(clickOn)
  const directionRef = useRef(direction)
  const modeRef = useRef(mode)
  const scaleRootPcRef = useRef(scaleRootPc)
  const scaleRef = useRef(scale)
  const sequenceIdRef = useRef(sequenceId)
  const arpRootPcRef = useRef(arpRootPc)
  const arpQualityRef = useRef(arpQuality)
  const arpInversionRef = useRef(arpInversion)
  const pianoModeRef = useRef(pianoMode)
  const pianoKindRef = useRef(pianoKind)
  const pianoRootPcRef = useRef(pianoRootPc)
  const pianoOctaveRef = useRef(pianoOctave)
  const pianoQualityRef = useRef(pianoQuality)
  const pianoPatternIdRef = useRef(pianoPatternId)
  const pianoHandRef = useRef(pianoHand)
  const pianoOctavesRef = useRef(pianoOctaves)
  patternRef.current = pattern
  tuningRef.current = tuning
  positionRef.current = position
  rangeRef.current = range
  rhythmRef.current = rhythm
  accentNRef.current = accentEveryN
  bpmRef.current = bpm
  clickRef.current = clickOn
  directionRef.current = direction
  modeRef.current = mode
  scaleRootPcRef.current = scaleRootPc
  scaleRef.current = scale
  sequenceIdRef.current = sequenceId
  arpRootPcRef.current = arpRootPc
  arpQualityRef.current = arpQuality
  arpInversionRef.current = arpInversion
  pianoModeRef.current = pianoMode
  pianoKindRef.current = pianoKind
  pianoRootPcRef.current = pianoRootPc
  pianoOctaveRef.current = pianoOctave
  pianoQualityRef.current = pianoQuality
  pianoPatternIdRef.current = pianoPatternId
  pianoHandRef.current = pianoHand
  pianoOctavesRef.current = pianoOctaves

  // Persist preferences whenever they change.
  useEffect(() => {
    dexteritySettingsStore.set({
      mode,
      patternId,
      scaleRootPc,
      scaleId,
      sequenceId,
      arpRootPc,
      arpQualityId,
      arpInversion,
      position,
      bpm,
      rhythmId,
      accentEveryN,
      autoAdvance,
      advanceMin,
      advanceMax,
      direction,
      pianoMode,
      pianoKind,
      pianoRootPc,
      pianoOctave,
      pianoQuality,
      pianoPatternId,
      pianoHand,
      pianoOctaves,
    })
  }, [
    mode,
    patternId,
    scaleRootPc,
    scaleId,
    sequenceId,
    arpRootPc,
    arpQualityId,
    arpInversion,
    position,
    bpm,
    rhythmId,
    accentEveryN,
    autoAdvance,
    advanceMin,
    advanceMax,
    direction,
    pianoMode,
    pianoKind,
    pianoRootPc,
    pianoOctave,
    pianoQuality,
    pianoPatternId,
    pianoHand,
    pianoOctaves,
  ])

  // Apply tempo changes to a live scheduler without stopping it. The grid runs
  // at a fixed fine resolution (RHYTHM_RESOLUTION), so rhythm changes need no
  // meter change — the audio callback re-reads the rhythm from a ref.
  useEffect(() => {
    schedulerRef.current?.setTempo(bpm)
  }, [bpm])

  // Per grid-step: play the current step's note (on its onset) plus an optional
  // metronome click on the beat. Reads everything from refs so its identity is
  // stable across the scheduler's lifetime.
  const handleEvent = useCallback((event: SchedulerEvent, when: number) => {
    const engine = engineRef.current
    const currentTuning = tuningRef.current

    // Build the current step sequence for a given anchor/position, dispatching
    // on the active mode — a built-in pattern or a scale-sequence drill. Reads
    // everything from refs so the callback identity stays stable.
    const buildSteps = (pos: number): ExerciseStep[] => {
      // Piano mode ignores the fret position: build the keyboard steps from the
      // piano refs, apply the shared direction, and adapt to the step shape.
      if (pianoModeRef.current) {
        const ascending =
          pianoKindRef.current === 'scale'
            ? buildScale({
                root: pianoRootPcRef.current,
                octave: pianoOctaveRef.current,
                octaves: pianoOctavesRef.current,
                hand: pianoHandRef.current,
              })
            : buildFiveFinger({
                root: pianoRootPcRef.current,
                octave: pianoOctaveRef.current,
                quality: pianoQualityRef.current,
                patternId: pianoPatternIdRef.current,
                hand: pianoHandRef.current,
              })
        return pianoStepsAsExercise(applyPianoDirection(ascending, directionRef.current))
      }
      let raw: ExerciseStep[]
      if (modeRef.current === 'scale') {
        raw = expandScaleSequence({
          tuning: currentTuning,
          root: scaleRootPcRef.current,
          scale: scaleRef.current,
          patternId: sequenceIdRef.current,
          anchor: pos,
        })
      } else if (modeRef.current === 'arpeggio') {
        raw = expandArpeggio({
          tuning: currentTuning,
          root: arpRootPcRef.current,
          intervals: arpQualityRef.current.intervals,
          inversion: arpInversionRef.current,
          anchor: pos,
        })
      } else {
        raw = expandPattern(patternRef.current, { tuning: currentTuning, position: pos })
      }
      return applyDirection(raw, directionRef.current)
    }

    // Rhythmize this loop's steps and locate the current fine-grid step within
    // the rhythm's timing; notes sound only on an onset tick.
    const seq = rhythmizeSteps(buildSteps(positionRef.current), rhythmRef.current)
    const loopTiming = rhythmTiming(seq)
    const loc = locateStep(event.step, loopTiming)

    if (loc && loc.isOnset) {
      const loopPosition = positionForLoop(loc.loop, positionRef.current, rangeRef.current)
      const notes = buildSteps(loopPosition)
      const step = notes[loc.stepIndex]
      if (step) {
        const events = applyAccent(seq.events, accentNRef.current)
        const accent = events[loc.stepIndex]?.accent ?? false
        const durTicks = noteDurationsTicks(loopTiming)[loc.stepIndex] ?? 1
        const seconds = durTicks * secondsPerSubdivision(bpmRef.current, RHYTHM_RESOLUTION) * NOTE_LENGTH
        // Accented notes hit harder for an audible pulse/displacement feel.
        engine.playNote(step.midi, seconds, { when, velocity: accent ? 1 : 0.68 })
      }
    }

    // Metronome pulse once per beat (grid subdivision 0), accented on the
    // bar's downbeat; the rhythm's own notes carry the subdivision feel.
    if (clickRef.current && event.subdivision === 0) {
      const level = event.beat === 0 ? 'high' : 'low'
      const spec = resolveClickParams(DEFAULT_CLICK_VOICE_ID, level, event.beat !== 0)
      if (spec) engine.playClick({ ...spec, when })
    }
  }, [])

  // Drive the current-step indicator from the audio-accurate position, and —
  // when a routine is playing — count off the active step's duration and
  // advance to the next step once it is met (see `advanceRoutine`).
  const runIndicator = useCallback(() => {
    const scheduler = schedulerRef.current
    if (scheduler) {
      const pos = scheduler.currentPosition()
      if (pos) {
        const loc = locateStep(pos.step, timingRef.current)
        if (loc) {
          setActiveStepIndex((prev) => (prev === loc.stepIndex ? prev : loc.stepIndex))
          setActiveLoop((prev) => (prev === loc.loop ? prev : loc.loop))
        }

        const idx = routineIndexRef.current
        if (idx !== null) {
          const rstep = routineStepsRef.current[idx]
          if (rstep) {
            // Anchor the step's elapsed measure to the first heard grid step
            // after it became active (config + timing refs are settled by now).
            if (stepStartStepRef.current === null) {
              stepStartStepRef.current = pos.step
              stepStartTimeRef.current = engineRef.current.currentTime
            }
            const gridElapsed = pos.step - stepStartStepRef.current
            const secondsElapsed = engineRef.current.currentTime - stepStartTimeRef.current
            if (stepIsComplete(rstep, gridElapsed, timingRef.current.totalGridSteps, secondsElapsed)) {
              advanceRoutineRef.current()
            }
          }
        }
      }
    }
    rafRef.current = requestAnimationFrame(runIndicator)
  }, [])

  const start = useCallback(async () => {
    const engine = engineRef.current
    await engine.ensureRunning()
    let scheduler = schedulerRef.current
    if (!scheduler) {
      scheduler = new Scheduler(engine, {
        bpm: bpmRef.current,
        beatsPerBar: 4,
        subdivisionsPerBeat: RHYTHM_RESOLUTION,
        onEvent: handleEvent,
      })
      schedulerRef.current = scheduler
    } else {
      scheduler.setTempo(bpmRef.current)
      scheduler.setMeter({ beatsPerBar: 4, subdivisionsPerBeat: RHYTHM_RESOLUTION })
    }
    setActiveStepIndex(null)
    setActiveLoop(0)
    scheduler.start()
    setRunning(true)
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(runIndicator)
  }, [handleEvent, runIndicator])

  const stop = useCallback(() => {
    schedulerRef.current?.stop()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setRunning(false)
    setActiveStepIndex(null)
    setActiveLoop(0)
    // Also tear down any routine that was playing.
    routineIndexRef.current = null
    stepStartStepRef.current = null
    setRoutineIndex(null)
    setTransitionLabel(null)
    if (bannerTimeoutRef.current !== null) clearTimeout(bannerTimeoutRef.current)
  }, [])

  useEffect(
    () => () => {
      schedulerRef.current?.stop()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      if (bannerTimeoutRef.current !== null) clearTimeout(bannerTimeoutRef.current)
    },
    [],
  )

  // Apply a drill config to the page's React state (so the board/controls
  // reflect the step being played) — used by the routine player on each advance.
  const applyDrillConfig = useCallback((c: DrillConfig) => {
    setMode(c.mode)
    setPatternId(c.patternId)
    setScaleRootPc(c.scaleRootPc)
    setScaleId(c.scaleId)
    setSequenceId(c.sequenceId)
    setArpRootPc(c.arpRootPc)
    setArpQualityId(c.arpQualityId)
    setArpInversion(c.arpInversion)
    setPosition(c.position)
    setBpm(c.bpm)
    setRhythmId(c.rhythmId)
    setAccentEveryN(c.accentEveryN)
    setDirection(c.direction)
  }, [])

  // Mirror a drill config straight onto the scheduler-callback refs, so the very
  // next grid step plays the new step's exercise without waiting for the React
  // re-render (which then rewrites these same refs to identical values).
  const syncConfigRefs = useCallback((c: DrillConfig) => {
    modeRef.current = c.mode
    patternRef.current = getPermutationPattern(c.patternId) ?? getPattern(c.patternId)
    scaleRootPcRef.current = c.scaleRootPc
    scaleRef.current = getScale(c.scaleId)
    sequenceIdRef.current = c.sequenceId
    arpRootPcRef.current = c.arpRootPc
    arpQualityRef.current = getArpeggioQuality(c.arpQualityId)
    arpInversionRef.current = c.arpInversion
    positionRef.current = c.position
    rhythmRef.current = getRhythm(c.rhythmId)
    accentNRef.current = c.accentEveryN
    directionRef.current = c.direction
    bpmRef.current = c.bpm
    rangeRef.current = undefined
  }, [])

  // A distinct two-note rising chime (triangle, unlike the sawtooth exercise
  // voice) marking a step transition, plus the "Next: …" banner.
  const cueTransition = useCallback((label: string) => {
    const engine = engineRef.current
    const t = engine.currentTime
    engine.playNote(76, 0.16, { when: t + 0.001, velocity: 0.9, type: 'triangle', detune: 0 })
    engine.playNote(83, 0.24, { when: t + 0.11, velocity: 0.9, type: 'triangle', detune: 0 })
    setTransitionLabel(label)
    if (bannerTimeoutRef.current !== null) clearTimeout(bannerTimeoutRef.current)
    bannerTimeoutRef.current = setTimeout(() => setTransitionLabel(null), 1800)
  }, [])

  // Advance the running routine to its next step, or stop when it is complete.
  // Reads/writes the routine refs so the rAF loop can call it via a stable ref.
  const advanceRoutine = useCallback(() => {
    const idx = routineIndexRef.current
    if (idx === null) return
    const next = routineStepsRef.current[idx + 1]
    if (!next) {
      stop()
      return
    }
    routineIndexRef.current = idx + 1
    stepStartStepRef.current = null
    setRoutineIndex(idx + 1)
    applyDrillConfig(next.config)
    syncConfigRefs(next.config)
    schedulerRef.current?.setTempo(next.config.bpm)
    cueTransition(drillConfigLabel(next.config))
  }, [stop, applyDrillConfig, syncConfigRefs, cueTransition])
  advanceRoutineRef.current = advanceRoutine

  // Start playing a routine from step 0, driving the existing scheduler.
  const startRoutine = useCallback(
    async (steps: readonly RoutineStep[]) => {
      if (steps.length === 0) return
      const first = steps[0]!
      setAutoAdvance(false)
      routineStepsRef.current = [...steps]
      routineIndexRef.current = 0
      stepStartStepRef.current = null
      setRoutineIndex(0)
      applyDrillConfig(first.config)
      syncConfigRefs(first.config)
      await start()
      cueTransition(drillConfigLabel(first.config))
    },
    [start, applyDrillConfig, syncConfigRefs, cueTransition],
  )

  const stopRoutine = useCallback(() => stop(), [stop])

  // --- Routine builder actions (edit the working step list) ------------------
  const currentDrillConfig = useCallback(
    (): DrillConfig => ({
      mode,
      patternId,
      scaleRootPc,
      scaleId,
      sequenceId,
      arpRootPc,
      arpQualityId,
      arpInversion,
      position,
      bpm,
      rhythmId,
      accentEveryN,
      direction,
    }),
    [
      mode,
      patternId,
      scaleRootPc,
      scaleId,
      sequenceId,
      arpRootPc,
      arpQualityId,
      arpInversion,
      position,
      bpm,
      rhythmId,
      accentEveryN,
      direction,
    ],
  )

  const addCurrentDrill = useCallback(() => {
    setRoutineSteps((s) => [...s, { config: currentDrillConfig(), duration: DEFAULT_STEP_DURATION }])
  }, [currentDrillConfig])

  const setStepDuration = useCallback((index: number, duration: StepDuration) => {
    setRoutineSteps((s) => s.map((step, i) => (i === index ? { ...step, duration } : step)))
  }, [])

  const persistSaved = useCallback((next: ReturnType<typeof normalizeRoutinesState>) => {
    setSavedState(next)
    routinesStore.set(next)
  }, [])

  const saveRoutine = useCallback(() => {
    if (routineSteps.length === 0) return
    const id = `r-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
    const routine: Routine = { id, name: routineName.trim() || 'Routine', steps: routineSteps }
    persistSaved(
      normalizeRoutinesState({ routines: [...savedState.routines, routine], lastUsedId: id }),
    )
  }, [routineSteps, routineName, savedState, persistSaved])

  const loadRoutine = useCallback(
    (routine: Routine) => {
      setRoutineSteps([...routine.steps])
      setRoutineName(routine.name)
      persistSaved({ ...savedState, lastUsedId: routine.id })
    },
    [savedState, persistSaved],
  )

  const deleteRoutine = useCallback(
    (id: string) => {
      persistSaved(
        normalizeRoutinesState({
          routines: savedState.routines.filter((r) => r.id !== id),
          lastUsedId: savedState.lastUsedId,
        }),
      )
    },
    [savedState, persistSaved],
  )

  const changeBpm = useCallback((next: number) => setBpm(clampBpm(next)), [])
  const changePosition = useCallback((next: number) => setPosition(clampFret(next)), [])

  // Estimated total time of the working routine (minutes-steps exact; loops-
  // steps derived from each exercise's note count at the current tuning).
  const routineTotalSeconds = useMemo(
    () =>
      estimateRoutineSeconds({ id: '', name: '', steps: routineSteps }, (c) => expandDrillConfig(c, tuning).length),
    [routineSteps, tuning],
  )

  // Board fret range: pad one fret either side of the notes on show.
  const frets = displaySteps.map((s) => s.fret)
  const minFret = frets.length ? Math.min(...frets) : displayPosition
  const maxFret = frets.length ? Math.max(...frets) : displayPosition + 4
  const fromFret = Math.max(0, minFret - 1)
  const toFret = Math.min(MAX_FRET + 2, maxFret + 1)

  const markers = buildMarkers(displaySteps, running, activeStepIndex)

  const rootName = pcToName(scaleRootPc)
  const arpTitle = `${pcToName(arpRootPc)}${arpQuality.symbol} arpeggio — ${
    availableInversions.find((i) => i.id === arpInversion)?.name ?? 'Root position'
  }`

  // The currently selected exercise *type*: scale/arpeggio come straight from
  // the mode, every pattern-backed drill from the active pattern's category
  // (so a permutation picked in the Spider dropdown still reads as "spider").
  const activeDrill: DrillType = mode === 'scale' ? 'scale' : mode === 'arpeggio' ? 'arpeggio' : pattern.category

  // Switch drill type. Scale/arpeggio just flip the mode; a pattern drill flips
  // to pattern mode and, only when leaving its category, resets to that
  // category's default pattern — so switching away and back keeps the variant.
  const selectDrill = (d: DrillType) => {
    if (d === 'scale') {
      setMode('scale')
    } else if (d === 'arpeggio') {
      setMode('arpeggio')
    } else {
      setMode('pattern')
      if (pattern.category !== d) setPatternId(CATEGORY_DEFAULT_PATTERN[d])
    }
  }

  // The spider drill's finger order, derived from the motif's finger sequence
  // so it works for both `perm-####` ids and the legacy hand-picked spider
  // patterns; the dropdown/chip selection round-trips through the perm id.
  const spiderOrderId = permutationId(pattern.motif.map((c) => c.finger))
  const spiderOrderLabel = pattern.motif.map((c) => c.finger).join('-')

  const title =
    activeDrill === 'scale'
      ? `${rootName} ${scale.name} — ${sequence.name}`
      : activeDrill === 'arpeggio'
        ? arpTitle
        : pattern.name

  // Single description panel for the selected drill only (no per-card blurbs).
  const panelTitle =
    activeDrill === 'spider'
      ? `Spider walk · ${spiderOrderLabel}`
      : activeDrill === 'scale' || activeDrill === 'arpeggio'
        ? title
        : `${DRILLS.find((d) => d.id === activeDrill)?.name ?? ''} · ${pattern.name}`
  const panelDesc =
    activeDrill === 'scale'
      ? sequence.description
      : activeDrill === 'arpeggio'
        ? `Play the ${arpTitle.toLowerCase()} one note at a time across the strings — trains chord-tone shapes and clean string changes.`
        : pattern.description

  // --- Piano display values -------------------------------------------------
  const pianoRootName = pcToName(pianoRootPc, 'flat')
  const pianoTitle =
    pianoKind === 'scale'
      ? `${pianoRootName} major scale — ${pianoOctaves} octave${pianoOctaves > 1 ? 's' : ''} · ${HAND_LABELS[pianoHand]} hand`
      : `${pianoRootName} ${QUALITY_LABELS[pianoQuality].toLowerCase()} five-finger — ${fiveFingerDef.name} · ${HAND_LABELS[pianoHand]} hand`
  const pianoPanelDesc =
    pianoKind === 'scale'
      ? `Play the ${pianoRootName} major scale with its standard fingering, ${pianoOctaves} octave${pianoOctaves > 1 ? 's' : ''}, ${HAND_LABELS[pianoHand].toLowerCase()} hand. Finger numbers show on each key; use Forward + Reverse to run it up and back down.`
      : fiveFingerDef.description
  const pianoMarkers = buildKeyboardMarkers(displayPianoSteps, running, activeStepIndex)
  const pianoMidiList = displayPianoSteps.map((s) => s.midi)
  const pianoFrom = pianoMidiList.length ? Math.min(...pianoMidiList) - 2 : rootMidi(pianoRootPc, pianoOctave)
  const pianoTo = pianoMidiList.length ? Math.max(...pianoMidiList) + 2 : rootMidi(pianoRootPc, pianoOctave) + 12

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Dexterity Exercises</h1>
        <p className="tool-page-lead">
          Fretting-hand and piano drills rendered with finger numbers and played in time. The
          current step lights up as it sounds. Audio starts only when you press Start.
        </p>
        <div className="dx-mode" role="radiogroup" aria-label="Instrument type">
          <button
            type="button"
            role="radio"
            aria-checked={!pianoMode}
            className={`dx-segment${!pianoMode ? ' dx-segment-active' : ''}`}
            onClick={() => setPianoMode(false)}
          >
            Bass / Guitar
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={pianoMode}
            className={`dx-segment${pianoMode ? ' dx-segment-active' : ''}`}
            onClick={() => setPianoMode(true)}
          >
            Piano
          </button>
        </div>
      </div>

      <div className="dx-main">
        <div className="dx-picker">
          <span className="tool-control-label">Exercise</span>
          {!pianoMode && (
          <>
          <div className="dx-drill-list" role="radiogroup" aria-label="Exercise type">
            {DRILLS.map((d) => (
              <button
                key={d.id}
                type="button"
                role="radio"
                aria-checked={d.id === activeDrill}
                className={`dx-drill${d.id === activeDrill ? ' dx-drill-active' : ''}`}
                onClick={() => selectDrill(d.id)}
              >
                <span className="dx-drill-name">{d.name}</span>
                <span className="dx-drill-tag">{d.tagline}</span>
              </button>
            ))}
          </div>

          <div className="dx-panel">
            <div className="dx-panel-title">{panelTitle}</div>
            <p className="dx-panel-desc">{panelDesc}</p>

            {activeDrill === 'spider' && (
              <div className="dx-variant">
                <label className="dx-field">
                  <span className="tool-control-label">Finger order (all 24)</span>
                  <select
                    className="dx-select"
                    value={spiderOrderId}
                    aria-label="Spider-walk finger order"
                    onChange={(e) => setPatternId(e.target.value)}
                  >
                    {ALL_PERMUTATION_PATTERNS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.motif.map((c) => c.finger).join('-')}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="tool-control-label">Today&rsquo;s set · {todayKey}</span>
                <div className="dx-chips" role="group" aria-label="Suggested finger orders for today">
                  {dailySet.map((p) => {
                    const label = p.motif.map((c) => c.finger).join('-')
                    const active = p.id === spiderOrderId
                    return (
                      <button
                        key={p.id}
                        type="button"
                        className={`dx-chip${active ? ' dx-chip-active' : ''}`}
                        aria-pressed={active}
                        onClick={() => setPatternId(p.id)}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {isPatternDrill(activeDrill) && activeDrill !== 'spider' && (
              <label className="dx-field">
                <span className="tool-control-label">Variant</span>
                <select
                  className="dx-select"
                  value={patternId}
                  aria-label="Exercise variant"
                  onChange={(e) => setPatternId(e.target.value)}
                >
                  {BUILTIN_PATTERNS.filter((p) => p.category === activeDrill).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {activeDrill === 'scale' && (
              <div className="dx-scale-fields">
                <label className="dx-scale-field">
                  <span className="tool-control-label">Root</span>
                  <select
                    className="dx-select"
                    value={scaleRootPc}
                    aria-label="Scale root"
                    onChange={(e) => setScaleRootPc(Number(e.target.value) as PitchClass)}
                  >
                    {ROOT_PCS.map((pc) => (
                      <option key={pc} value={pc}>
                        {pcToName(pc)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dx-scale-field">
                  <span className="tool-control-label">Scale</span>
                  <select
                    className="dx-select"
                    value={scaleId}
                    aria-label="Scale type"
                    onChange={(e) => setScaleId(e.target.value)}
                  >
                    {SCALES.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dx-scale-field">
                  <span className="tool-control-label">Sequence</span>
                  <select
                    className="dx-select"
                    value={sequenceId}
                    aria-label="Sequence pattern"
                    onChange={(e) => setSequenceId(e.target.value as SequencePatternId)}
                  >
                    {SEQUENCE_PATTERNS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {activeDrill === 'arpeggio' && (
              <div className="dx-scale-fields">
                <label className="dx-scale-field">
                  <span className="tool-control-label">Root</span>
                  <select
                    className="dx-select"
                    value={arpRootPc}
                    aria-label="Chord root"
                    onChange={(e) => setArpRootPc(Number(e.target.value) as PitchClass)}
                  >
                    {ROOT_PCS.map((pc) => (
                      <option key={pc} value={pc}>
                        {pcToName(pc)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="dx-scale-field">
                  <span className="tool-control-label">Quality</span>
                  <select
                    className="dx-select"
                    value={arpQualityId}
                    aria-label="Chord quality"
                    onChange={(e) => setArpQualityId(e.target.value)}
                  >
                    {arpQualityGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.qualities.map((q) => (
                          <option key={q.id} value={q.id}>
                            {q.name}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </label>
                <label className="dx-scale-field">
                  <span className="tool-control-label">Inversion</span>
                  <select
                    className="dx-select"
                    value={arpInversion}
                    aria-label="Chord inversion"
                    onChange={(e) => setArpInversion(e.target.value as Inversion)}
                  >
                    {availableInversions.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </div>
          </>
          )}

          {pianoMode && (
          <>
          <div className="dx-drill-list" role="radiogroup" aria-label="Piano exercise type">
            {PIANO_EXERCISE_KINDS.map((k) => (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={k.id === pianoKind}
                className={`dx-drill${k.id === pianoKind ? ' dx-drill-active' : ''}`}
                onClick={() => setPianoKind(k.id)}
              >
                <span className="dx-drill-name">{k.name}</span>
                <span className="dx-drill-tag">{k.tagline}</span>
              </button>
            ))}
          </div>

          <div className="dx-panel">
            <div className="dx-panel-title">{pianoTitle}</div>
            <p className="dx-panel-desc">{pianoPanelDesc}</p>

            <div className="dx-scale-fields">
              <label className="dx-scale-field">
                <span className="tool-control-label">Root</span>
                <select
                  className="dx-select"
                  value={pianoRootPc}
                  aria-label="Piano exercise root"
                  onChange={(e) => setPianoRootPc(Number(e.target.value) as PitchClass)}
                >
                  {ROOT_PCS.map((pc) => (
                    <option key={pc} value={pc}>
                      {pcToName(pc, 'flat')}
                    </option>
                  ))}
                </select>
              </label>
              <label className="dx-scale-field">
                <span className="tool-control-label">Octave</span>
                <select
                  className="dx-select"
                  value={pianoOctave}
                  aria-label="Root octave"
                  onChange={(e) => setPianoOctave(clampPianoOctave(Number(e.target.value)))}
                >
                  {Array.from({ length: MAX_PIANO_OCTAVE - MIN_PIANO_OCTAVE + 1 }, (_, i) => MIN_PIANO_OCTAVE + i).map(
                    (oct) => (
                      <option key={oct} value={oct}>
                        {pcToName(pianoRootPc, 'flat')}
                        {oct}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {pianoKind === 'five-finger' && (
                <label className="dx-scale-field">
                  <span className="tool-control-label">Variation</span>
                  <select
                    className="dx-select"
                    value={pianoPatternId}
                    aria-label="Five-finger pattern"
                    onChange={(e) => setPianoPatternId(e.target.value as FiveFingerPatternId)}
                  >
                    {FIVE_FINGER_PATTERNS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>

            <div className="dx-piano-toggles">
              <div className="dx-setting">
                <span className="tool-control-label">Hand</span>
                <div className="dx-segmented" role="group" aria-label="Hand">
                  {HANDS.map((h) => (
                    <button
                      key={h}
                      type="button"
                      className={`dx-segment${h === pianoHand ? ' dx-segment-active' : ''}`}
                      aria-pressed={h === pianoHand}
                      onClick={() => setPianoHand(h)}
                    >
                      {HAND_LABELS[h]}
                    </button>
                  ))}
                </div>
              </div>

              {pianoKind === 'five-finger' && (
                <div className="dx-setting">
                  <span className="tool-control-label">Quality</span>
                  <div className="dx-segmented" role="group" aria-label="Five-finger quality">
                    {FIVE_FINGER_QUALITIES.map((q) => (
                      <button
                        key={q}
                        type="button"
                        className={`dx-segment${q === pianoQuality ? ' dx-segment-active' : ''}`}
                        aria-pressed={q === pianoQuality}
                        onClick={() => setPianoQuality(q)}
                      >
                        {QUALITY_LABELS[q]}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {pianoKind === 'scale' && (
                <div className="dx-setting">
                  <span className="tool-control-label">Octaves</span>
                  <div className="dx-segmented" role="group" aria-label="Scale octaves">
                    {SCALE_OCTAVE_OPTIONS.map((o) => (
                      <button
                        key={o}
                        type="button"
                        className={`dx-segment${o === pianoOctaves ? ' dx-segment-active' : ''}`}
                        aria-pressed={o === pianoOctaves}
                        onClick={() => setPianoOctaves(o)}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          </>
          )}
        </div>

        <div className="dx-stage">
          {pianoMode ? (
            <div className="dx-board">
              <Keyboard
                from={pianoFrom}
                to={pianoTo}
                markers={pianoMarkers}
                showLabels="c"
                ariaLabel={`${pianoTitle} on a piano keyboard`}
              />
            </div>
          ) : (
          <div className="dx-board">
            <Fretboard
              tuning={tuning}
              fromFret={fromFret}
              toFret={toFret}
              markers={markers}
              ariaLabel={`${title} on ${tuning.name}`}
            />
          </div>
          )}

          {pianoMode ? (
            <div className="dx-strip" role="list" aria-label="Piano step sequence">
              {displayPianoSteps.map((step, i) => {
                const active = running && i === activeStepIndex
                const accented = displayEvents[i]?.accent ?? false
                return (
                  <div
                    key={`${i}-${step.midi}`}
                    role="listitem"
                    className={`dx-strip-step${active ? ' dx-strip-active' : ''}${accented ? ' dx-strip-accent' : ''}`}
                  >
                    <span className="dx-strip-order">{i + 1}</span>
                    <span className="dx-strip-finger">{step.finger}</span>
                    <span className="dx-strip-meta">{midiToName(step.midi)}</span>
                  </div>
                )
              })}
            </div>
          ) : (
          <div className="dx-strip" role="list" aria-label="Exercise step sequence">
            {displaySteps.map((step, i) => {
              const active = running && i === activeStepIndex
              const accented = displayEvents[i]?.accent ?? false
              return (
                <div
                  key={`${i}-${step.string}-${step.fret}`}
                  role="listitem"
                  className={`dx-strip-step${active ? ' dx-strip-active' : ''}${accented ? ' dx-strip-accent' : ''}`}
                >
                  <span className="dx-strip-order">
                    {i + 1}
                    {step.articulation && (
                      <span
                        className={`dx-strip-slur dx-strip-slur-${step.articulation}`}
                        title={step.articulation === 'hammer' ? 'Hammer-on (slur)' : 'Pull-off (slur)'}
                      >
                        {step.articulation === 'hammer' ? 'H' : 'P'}
                      </span>
                    )}
                  </span>
                  <span className="dx-strip-finger">{step.finger}</span>
                  <span className="dx-strip-meta">
                    {midiToName(step.midi)} · str {step.string + 1} · fr {step.fret}
                  </span>
                </div>
              )
            })}
          </div>
          )}

          <div className="dx-transport">
            <button
              type="button"
              className={`dx-start${running ? ' dx-start-active' : ''}`}
              onClick={() => (running ? stop() : void start())}
            >
              {running ? 'Stop' : 'Start'}
            </button>
            {routineIndex !== null && (
              <span className="dx-routine-progress" aria-live="polite">
                Routine · step {routineIndex + 1}/{routineStepsRef.current.length}
              </span>
            )}
          </div>

          {transitionLabel !== null && (
            <div className="dx-routine-banner" role="status">
              Next: {transitionLabel}
            </div>
          )}
        </div>
      </div>

      <div className="dx-settings">
        <div className="dx-settings-row">
          {!pianoMode && (
            <div className="dx-setting">
              <span className="tool-control-label">Instrument</span>
              <InstrumentPicker
                value={tuning}
                onChange={(t) => instrument.setTuningId(t.id)}
                className="dx-instrument"
              />
            </div>
          )}

          {!pianoMode && (
          <div className="dx-setting">
            <span className="tool-control-label">Starting fret</span>
            <div className="dx-position">
              <button
                type="button"
                className="dx-stepper"
                onClick={() => changePosition(position - 1)}
                aria-label="Lower starting fret"
                disabled={running && autoAdvance}
              >
                −
              </button>
              <span className="dx-position-value">{displayPosition}</span>
              <button
                type="button"
                className="dx-stepper"
                onClick={() => changePosition(position + 1)}
                aria-label="Raise starting fret"
                disabled={running && autoAdvance}
              >
                +
              </button>
            </div>
            <input
              type="range"
              className="dx-slider"
              min={MIN_FRET}
              max={MAX_FRET}
              value={position}
              aria-label="Starting fret"
              onChange={(e) => changePosition(Number(e.target.value))}
            />
          </div>
          )}

          <div className="dx-setting">
            <span className="tool-control-label">Tempo</span>
            <div className="dx-tempo-readout">
              <span className="dx-tempo-value">{bpm}</span>
              <span className="dx-tempo-unit">BPM</span>
            </div>
            <div className="dx-steppers">
              <button type="button" className="dx-stepper" onClick={() => changeBpm(bpm - 5)}>
                −5
              </button>
              <button type="button" className="dx-stepper" onClick={() => changeBpm(bpm - 1)}>
                −1
              </button>
              <button type="button" className="dx-stepper" onClick={() => changeBpm(bpm + 1)}>
                +1
              </button>
              <button type="button" className="dx-stepper" onClick={() => changeBpm(bpm + 5)}>
                +5
              </button>
            </div>
            <input
              type="range"
              className="dx-slider"
              min={MIN_BPM}
              max={MAX_BPM}
              value={bpm}
              aria-label="Tempo in beats per minute"
              onChange={(e) => changeBpm(Number(e.target.value))}
            />
          </div>
        </div>

        <details className="dx-more">
          <summary className="dx-more-summary">Feel &amp; motion</summary>
          <div className="dx-settings-row">
            <div className="dx-setting">
              <span className="tool-control-label">Rhythm</span>
              <select
                className="dx-select"
                value={rhythmId}
                aria-label="Rhythm pattern"
                onChange={(e) => setRhythmId(e.target.value as RhythmId)}
              >
                {RHYTHMS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <span className="dx-rhythm-desc">{rhythm.description}</span>
            </div>

            <div className="dx-setting">
              <span className="tool-control-label">Accent every N notes</span>
              <div className="dx-segmented" role="group" aria-label="Accent every N notes">
                {ACCENT_EVERY_N_OPTIONS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`dx-segment${n === accentEveryN ? ' dx-segment-active' : ''}`}
                    aria-pressed={n === accentEveryN}
                    onClick={() => setAccentEveryN(n)}
                  >
                    {ACCENT_LABELS[n] ?? String(n)}
                  </button>
                ))}
              </div>
              <span className="dx-rhythm-desc">
                {accentEveryN === 0
                  ? 'Natural pulse — first note of each beat accented.'
                  : `Accents every ${accentEveryN} notes for a displacement drill.`}
              </span>
            </div>

            <div className="dx-setting">
              <span className="tool-control-label">Direction</span>
              <div className="dx-segmented" role="group" aria-label="Playback direction">
                {DIRECTIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className={`dx-segment${d === direction ? ' dx-segment-active' : ''}`}
                    aria-pressed={d === direction}
                    onClick={() => setDirection(d)}
                  >
                    {DIRECTION_LABELS[d]}
                  </button>
                ))}
              </div>
            </div>

            <div className="dx-setting">
              <span className="tool-control-label">{pianoMode ? 'Metronome' : 'Auto-advance position'}</span>
              {!pianoMode && (
                <>
                  <label className="dx-toggle">
                    <input
                      type="checkbox"
                      checked={autoAdvance}
                      onChange={(e) => setAutoAdvance(e.target.checked)}
                    />
                    <span>Move up one fret each loop</span>
                  </label>
                  <div className={`dx-range${autoAdvance ? '' : ' dx-range-off'}`}>
                    <label className="dx-range-field">
                      <span>From</span>
                      <input
                        type="number"
                        min={MIN_FRET}
                        max={MAX_FRET}
                        value={advanceMin}
                        disabled={!autoAdvance}
                        onChange={(e) => setAdvanceMin(clampFret(Number(e.target.value)))}
                      />
                    </label>
                    <label className="dx-range-field">
                      <span>To</span>
                      <input
                        type="number"
                        min={MIN_FRET}
                        max={MAX_FRET}
                        value={advanceMax}
                        disabled={!autoAdvance}
                        onChange={(e) => setAdvanceMax(clampFret(Number(e.target.value)))}
                      />
                    </label>
                  </div>
                </>
              )}
              <label className="dx-toggle">
                <input type="checkbox" checked={clickOn} onChange={(e) => setClickOn(e.target.checked)} />
                <span>Metronome click</span>
              </label>
            </div>
          </div>
        </details>
      </div>

      {!pianoMode && (
      <details className="dx-more dx-routine">
        <summary className="dx-more-summary">
          Warm-up routine{routineSteps.length > 0 ? ` · ${routineSteps.length} steps · ${formatDuration(routineTotalSeconds)}` : ''}
        </summary>

        <div className="dx-routine-body">
          <div className="dx-routine-toolbar">
            <button type="button" className="dx-routine-add" onClick={addCurrentDrill}>
              + Add current drill
            </button>
            <span className="dx-routine-total">
              {routineSteps.length === 0
                ? 'No steps yet'
                : `Total ~${formatDuration(routineTotalSeconds)}`}
            </span>
          </div>

          {routineSteps.length === 0 ? (
            <p className="dx-routine-empty">
              Set up a drill above, then “Add current drill” to build a timed routine. Each step runs
              for a number of minutes or loops, then auto-advances to the next.
            </p>
          ) : (
            <ol className="dx-routine-list">
              {routineSteps.map((rstep, i) => {
                const isMinutes = rstep.duration.kind === 'minutes'
                const durValue = isMinutes ? rstep.duration.minutes : rstep.duration.loops
                const active = routineIndex === i
                return (
                  <li key={i} className={`dx-routine-step${active ? ' dx-routine-step-active' : ''}`}>
                    <span className="dx-routine-step-order">{i + 1}</span>
                    <span className="dx-routine-step-label">{drillConfigLabel(rstep.config)}</span>
                    <div className="dx-routine-step-dur">
                      <div className="dx-segmented" role="group" aria-label={`Step ${i + 1} duration mode`}>
                        <button
                          type="button"
                          className={`dx-segment${isMinutes ? ' dx-segment-active' : ''}`}
                          aria-pressed={isMinutes}
                          onClick={() => setStepDuration(i, { kind: 'minutes', minutes: isMinutes ? durValue : 2 })}
                        >
                          min
                        </button>
                        <button
                          type="button"
                          className={`dx-segment${!isMinutes ? ' dx-segment-active' : ''}`}
                          aria-pressed={!isMinutes}
                          onClick={() => setStepDuration(i, { kind: 'loops', loops: isMinutes ? 4 : durValue })}
                        >
                          loops
                        </button>
                      </div>
                      <input
                        type="number"
                        className="dx-routine-dur-input"
                        min={isMinutes ? MIN_STEP_MINUTES : MIN_STEP_LOOPS}
                        max={isMinutes ? MAX_STEP_MINUTES : MAX_STEP_LOOPS}
                        value={durValue}
                        aria-label={`Step ${i + 1} ${isMinutes ? 'minutes' : 'loops'}`}
                        onChange={(e) => {
                          const raw = Number(e.target.value)
                          const lo = isMinutes ? MIN_STEP_MINUTES : MIN_STEP_LOOPS
                          const hi = isMinutes ? MAX_STEP_MINUTES : MAX_STEP_LOOPS
                          const n = Number.isFinite(raw) ? Math.min(hi, Math.max(lo, Math.round(raw))) : lo
                          setStepDuration(i, isMinutes ? { kind: 'minutes', minutes: n } : { kind: 'loops', loops: n })
                        }}
                      />
                    </div>
                    <div className="dx-routine-step-btns">
                      <button
                        type="button"
                        className="dx-routine-btn"
                        aria-label={`Move step ${i + 1} up`}
                        disabled={i === 0}
                        onClick={() => setRoutineSteps((s) => moveStep(s, i, -1))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="dx-routine-btn"
                        aria-label={`Move step ${i + 1} down`}
                        disabled={i === routineSteps.length - 1}
                        onClick={() => setRoutineSteps((s) => moveStep(s, i, 1))}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="dx-routine-btn dx-routine-btn-remove"
                        aria-label={`Remove step ${i + 1}`}
                        onClick={() => setRoutineSteps((s) => removeStep(s, i))}
                      >
                        ✕
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}

          {routineSteps.length > 0 && (
            <div className="dx-routine-actions">
              <button
                type="button"
                className={`dx-start${routineIndex !== null ? ' dx-start-active' : ''}`}
                onClick={() => (routineIndex !== null ? stopRoutine() : void startRoutine(routineSteps))}
              >
                {routineIndex !== null ? 'Stop routine' : 'Play routine'}
              </button>
              <input
                type="text"
                className="dx-routine-name"
                placeholder="Routine name"
                value={routineName}
                aria-label="Routine name"
                onChange={(e) => setRoutineName(e.target.value)}
              />
              <button type="button" className="dx-routine-btn dx-routine-save" onClick={saveRoutine}>
                Save
              </button>
            </div>
          )}

          {savedState.routines.length > 0 && (
            <div className="dx-saved">
              <span className="tool-control-label">Saved routines</span>
              <ul className="dx-saved-list">
                {savedState.routines.map((r) => (
                  <li key={r.id} className="dx-saved-item">
                    <span className="dx-saved-name">{r.name}</span>
                    <span className="dx-saved-meta">{r.steps.length} steps</span>
                    <button type="button" className="dx-routine-btn" onClick={() => loadRoutine(r)}>
                      Load
                    </button>
                    <button
                      type="button"
                      className="dx-routine-btn"
                      onClick={() => void startRoutine(r.steps)}
                    >
                      Play
                    </button>
                    <button
                      type="button"
                      className="dx-routine-btn dx-routine-btn-remove"
                      aria-label={`Delete routine ${r.name}`}
                      onClick={() => deleteRoutine(r.id)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
      )}
    </div>
  )
}

/** Format a duration in seconds as `m:ss` (e.g. 150 → "2:30"). */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Build one marker per unique board cell: the finger number as its label, the
 * current step accented, other steps dimmed while running (or the first step
 * marked as the start position when stopped). Patterns that revisit a cell
 * (e.g. an up-and-down spider walk) collapse to a single marker, and the
 * highlighted variant always wins the cell.
 */
function buildMarkers(
  steps: readonly ExerciseStep[],
  running: boolean,
  activeStepIndex: number | null,
): FretboardMarker[] {
  const byCell = new Map<string, FretboardMarker>()
  steps.forEach((step, i) => {
    const key = `${step.string}-${step.fret}`
    const highlighted = running ? i === activeStepIndex : i === 0
    const variant: MarkerVariant = running
      ? i === activeStepIndex
        ? 'accent'
        : 'dim'
      : i === 0
        ? 'root'
        : 'default'
    const existing = byCell.get(key)
    // Keep an already-claimed highlight; otherwise (re)write the cell.
    if (existing && (existing.variant === 'accent' || existing.variant === 'root') && !highlighted) {
      return
    }
    byCell.set(key, { string: step.string, fret: step.fret, label: String(step.finger), variant })
  })
  return [...byCell.values()]
}

/**
 * Keyboard analog of `buildMarkers`: one marker per unique midi (a scale played
 * up and down revisits the same key), labelled with the finger, the current
 * step accented, others dimmed while running (or the first key marked as the
 * start when stopped). The highlighted variant always wins a shared key.
 */
function buildKeyboardMarkers(
  steps: readonly PianoStep[],
  running: boolean,
  activeStepIndex: number | null,
): KeyboardMarker[] {
  const byMidi = new Map<number, KeyboardMarker>()
  steps.forEach((step, i) => {
    const highlighted = running ? i === activeStepIndex : i === 0
    const variant: MarkerVariant = running
      ? i === activeStepIndex
        ? 'accent'
        : 'dim'
      : i === 0
        ? 'root'
        : 'default'
    const existing = byMidi.get(step.midi)
    if (existing && (existing.variant === 'accent' || existing.variant === 'root') && !highlighted) {
      return
    }
    byMidi.set(step.midi, { midi: step.midi, label: String(step.finger), variant })
  })
  return [...byMidi.values()]
}
