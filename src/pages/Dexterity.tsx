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

  const [running, setRunning] = useState(false)
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null)
  const [activeLoop, setActiveLoop] = useState(0)

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

  // Lay the steps onto the chosen rhythm, then apply the accent layer. The
  // rhythmized events drive the strip's accent emphasis; their grid timing (at
  // the fine RHYTHM_RESOLUTION) is shared by the rAF indicator and the audio
  // callback. Step count is independent of the position, so this is valid for
  // every loop.
  const rhythmized = useMemo(() => rhythmizeSteps(displaySteps, rhythm), [displaySteps, rhythm])
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

  // Drive the current-step indicator from the audio-accurate position.
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
  }, [])

  useEffect(
    () => () => {
      schedulerRef.current?.stop()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const changeBpm = useCallback((next: number) => setBpm(clampBpm(next)), [])
  const changePosition = useCallback((next: number) => setPosition(clampFret(next)), [])

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

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Dexterity Exercises</h1>
        <p className="tool-page-lead">
          Fretting-hand drills rendered with finger numbers and played in time. The current step
          lights up as it sounds. Audio starts only when you press Start.
        </p>
      </div>

      <div className="dx-main">
        <div className="dx-picker">
          <span className="tool-control-label">Exercise</span>
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
        </div>

        <div className="dx-stage">
          <div className="dx-board">
            <Fretboard
              tuning={tuning}
              fromFret={fromFret}
              toFret={toFret}
              markers={markers}
              ariaLabel={`${title} on ${tuning.name}`}
            />
          </div>

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

          <div className="dx-transport">
            <button
              type="button"
              className={`dx-start${running ? ' dx-start-active' : ''}`}
              onClick={() => (running ? stop() : void start())}
            >
              {running ? 'Stop' : 'Start'}
            </button>
          </div>
        </div>
      </div>

      <div className="dx-settings">
        <div className="dx-settings-row">
          <div className="dx-setting">
            <span className="tool-control-label">Instrument</span>
            <InstrumentPicker
              value={tuning}
              onChange={(t) => instrument.setTuningId(t.id)}
              className="dx-instrument"
            />
          </div>

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
              <span className="tool-control-label">Auto-advance position</span>
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
              <label className="dx-toggle">
                <input type="checkbox" checked={clickOn} onChange={(e) => setClickOn(e.target.checked)} />
                <span>Metronome click</span>
              </label>
            </div>
          </div>
        </details>
      </div>
    </div>
  )
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
