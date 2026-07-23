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
  DEXTERITY_MODES,
  dexteritySettingsStore,
  MAX_BPM,
  MAX_FRET,
  MIN_BPM,
  MIN_FRET,
  NOTES_PER_BEAT_OPTIONS,
  normalizeDexteritySettings,
  type DexterityMode,
} from '../lib/dexteritySettings.ts'
import {
  applyDirection,
  DIRECTIONS,
  expandPattern,
  getPattern,
  locateStep,
  patternsByCategory,
  positionForLoop,
  stepTimings,
  type Direction,
  type ExerciseStep,
} from '../lib/exercises.ts'
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
  isPermutationId,
} from '../lib/permutations.ts'

const NOTES_PER_BEAT_LABELS: Record<number, string> = {
  1: 'Quarter',
  2: 'Eighth',
  3: 'Triplet',
  4: 'Sixteenth',
}

const DIRECTION_LABELS: Record<Direction, string> = {
  forward: 'Forward',
  reverse: 'Reverse',
  'forward-reverse': 'Forward + Reverse',
}

const MODE_LABELS: Record<DexterityMode, string> = {
  pattern: 'Patterns',
  scale: 'Scale sequences',
  arpeggio: 'Arpeggios',
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
  const [notesPerBeat, setNotesPerBeat] = useState(settings.notesPerBeat)
  const [autoAdvance, setAutoAdvance] = useState(settings.autoAdvance)
  const [advanceMin, setAdvanceMin] = useState(settings.advanceMin)
  const [advanceMax, setAdvanceMax] = useState(settings.advanceMax)
  const [direction, setDirection] = useState<Direction>(settings.direction)
  const [clickOn, setClickOn] = useState(true)

  const [running, setRunning] = useState(false)
  const [activeStepIndex, setActiveStepIndex] = useState<number | null>(null)
  const [activeLoop, setActiveLoop] = useState(0)

  const pattern = useMemo(() => getPermutationPattern(patternId) ?? getPattern(patternId), [patternId])
  const patternGroups = useMemo(() => patternsByCategory(), [])
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

  // Step count + durations are independent of the position, so this timing is
  // valid for every loop; the rAF indicator and the audio callback share it.
  const timing = useMemo(() => stepTimings(displaySteps), [displaySteps])
  const timingRef = useRef(timing)
  timingRef.current = timing

  // Live values the stable scheduler callback reads (so its identity never
  // changes as settings do), mirroring the Metronome page.
  const patternRef = useRef(pattern)
  const tuningRef = useRef(tuning)
  const positionRef = useRef(position)
  const rangeRef = useRef(range)
  const notesPerBeatRef = useRef(notesPerBeat)
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
  notesPerBeatRef.current = notesPerBeat
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
      notesPerBeat,
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
    notesPerBeat,
    autoAdvance,
    advanceMin,
    advanceMax,
    direction,
  ])

  // Apply tempo / subdivision changes to a live scheduler without stopping it.
  useEffect(() => {
    schedulerRef.current?.setTempo(bpm)
  }, [bpm])
  useEffect(() => {
    schedulerRef.current?.setMeter({ subdivisionsPerBeat: notesPerBeat })
  }, [notesPerBeat])

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

    const stepList = buildSteps(positionRef.current)
    const loopTiming = stepTimings(stepList)
    const loc = locateStep(event.step, loopTiming)
    if (!loc) return

    if (loc.isOnset) {
      const loopPosition = positionForLoop(loc.loop, positionRef.current, rangeRef.current)
      const notes = buildSteps(loopPosition)
      const step = notes[loc.stepIndex]
      if (step) {
        const stepSeconds = secondsPerSubdivision(bpmRef.current, notesPerBeatRef.current)
        engine.playNote(step.midi, step.duration * stepSeconds * NOTE_LENGTH, { when, velocity: 0.9 })
      }
    }

    // Metronome pulse on the beat (grid subdivision 0), quieter off-beats.
    if (clickRef.current) {
      const level = event.subdivision === 0 ? 'high' : 'low'
      const spec = resolveClickParams(DEFAULT_CLICK_VOICE_ID, level, event.subdivision !== 0)
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
        subdivisionsPerBeat: notesPerBeatRef.current,
        onEvent: handleEvent,
      })
      schedulerRef.current = scheduler
    } else {
      scheduler.setTempo(bpmRef.current)
      scheduler.setMeter({ beatsPerBar: 4, subdivisionsPerBeat: notesPerBeatRef.current })
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
  const title =
    mode === 'scale'
      ? `${rootName} ${scale.name} — ${sequence.name}`
      : mode === 'arpeggio'
        ? arpTitle
        : pattern.name

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Dexterity Exercises</h1>
        <p className="tool-page-lead">
          Fretting-hand drills rendered with finger numbers and played in time. The current step
          lights up as it sounds. Audio starts only when you press Start.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Drill type</span>
          <div className="dx-segmented" role="group" aria-label="Drill type">
            {DEXTERITY_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`dx-segment${m === mode ? ' dx-segment-active' : ''}`}
                aria-pressed={m === mode}
                onClick={() => setMode(m)}
              >
                {MODE_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        {mode === 'pattern' && (
          <>
            <div className="tool-control-group dx-pattern-group">
              <span className="tool-control-label">Pattern</span>
              <div className="dx-patterns" role="radiogroup" aria-label="Exercise pattern">
            {patternGroups.map(
              (group) =>
                group.patterns.length > 0 && (
                  <div className="dx-pattern-category" key={group.category}>
                    <span className="dx-pattern-category-label">{group.label}</span>
                    {group.patterns.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="radio"
                        aria-checked={p.id === patternId}
                        className={`dx-pattern${p.id === patternId ? ' dx-pattern-active' : ''}`}
                        onClick={() => setPatternId(p.id)}
                      >
                        <span className="dx-pattern-name">{p.name}</span>
                        <span className="dx-pattern-desc">{p.description}</span>
                      </button>
                    ))}
                  </div>
                ),
            )}
          </div>
        </div>

        <div className="tool-control-group dx-pattern-group">
          <span className="tool-control-label">Daily permutations — {todayKey}</span>
          <div className="dx-patterns" role="radiogroup" aria-label="Today's permutation set">
            <div className="dx-pattern-category">
              <span className="dx-pattern-category-label">
                Today&rsquo;s set of {dailySet.length} (cycles through all 24 over ~6 days)
              </span>
              {dailySet.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={p.id === patternId}
                  className={`dx-pattern${p.id === patternId ? ' dx-pattern-active' : ''}`}
                  onClick={() => setPatternId(p.id)}
                >
                  <span className="dx-pattern-name">{p.name}</span>
                  <span className="dx-pattern-desc">{p.description}</span>
                </button>
              ))}
            </div>
          </div>
          <label className="dx-permutation-picker">
            <span className="tool-control-label">All permutations (free practice)</span>
            <select
              className="dx-select"
              value={isPermutationId(patternId) ? patternId : ''}
              aria-label="Choose any of the 24 finger permutations"
              onChange={(e) => {
                if (e.target.value) setPatternId(e.target.value)
              }}
            >
              <option value="" disabled>
                Choose a permutation…
              </option>
              {ALL_PERMUTATION_PATTERNS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
          </>
        )}

        {mode === 'scale' && (
          <div className="tool-control-group dx-scale-group">
            <span className="tool-control-label">Scale sequence</span>
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
            </div>
            <div className="dx-patterns" role="radiogroup" aria-label="Sequence pattern">
              <div className="dx-pattern-category">
                {SEQUENCE_PATTERNS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={p.id === sequenceId}
                    className={`dx-pattern${p.id === sequenceId ? ' dx-pattern-active' : ''}`}
                    onClick={() => setSequenceId(p.id)}
                  >
                    <span className="dx-pattern-name">{p.name}</span>
                    <span className="dx-pattern-desc">{p.description}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {mode === 'arpeggio' && (
          <div className="tool-control-group dx-scale-group">
            <span className="tool-control-label">Arpeggio</span>
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
          </div>
        )}

        <div className="tool-control-group">
          <span className="tool-control-label">Instrument</span>
          <InstrumentPicker
            value={tuning}
            onChange={(t) => instrument.setTuningId(t.id)}
            className="dx-instrument"
          />
        </div>

        <div className="tool-control-group">
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

        <div className="tool-control-group">
          <span className="tool-control-label">Notes per beat</span>
          <div className="dx-segmented" role="group">
            {NOTES_PER_BEAT_OPTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`dx-segment${n === notesPerBeat ? ' dx-segment-active' : ''}`}
                aria-pressed={n === notesPerBeat}
                onClick={() => setNotesPerBeat(n)}
              >
                {NOTES_PER_BEAT_LABELS[n] ?? String(n)}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
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

        <div className="tool-control-group dx-tempo-group">
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

        <div className="tool-control-group dx-advance-group">
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
          return (
            <div
              key={`${i}-${step.string}-${step.fret}`}
              role="listitem"
              className={`dx-strip-step${active ? ' dx-strip-active' : ''}`}
            >
              <span className="dx-strip-order">{i + 1}</span>
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
