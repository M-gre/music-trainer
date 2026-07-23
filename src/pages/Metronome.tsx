/**
 * Metronome — the first tool page. It establishes the layout patterns future
 * tools copy: a `.tool-page` wrapper, a lead paragraph, and `.tool-control-*`
 * control groups.
 *
 * The audio/timing is delegated to `src/lib/audio`: the pure `Scheduler` drives
 * the beat grid (tempo/meter/subdivision applied live via `setTempo`/
 * `setMeter`), the `AudioEngine` synthesizes the click blips, and the pure
 * `registerTap` handles tap-tempo averaging. This component stays thin — it
 * owns React state, the requestAnimationFrame beat indicator, and persistence.
 *
 * The AudioContext is only created/resumed inside the Start click handler
 * (`ensureRunning`), never at mount, so the page never triggers the browser's
 * autoplay block.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CLICK_VOICES,
  cycleAccent,
  getAudioEngine,
  registerTap,
  resolveClickParams,
  Scheduler,
  type AccentLevel,
  type ClickVoiceId,
  type SchedulerEvent,
} from '../lib/audio/index.ts'
import {
  BEATS_PER_BAR_OPTIONS,
  clampTempo,
  MAX_TEMPO,
  metronomeSettingsStore,
  MIN_TEMPO,
  normalizeMetronomeSettings,
  resizeAccents,
  SUBDIVISION_OPTIONS,
} from '../lib/metronomeSettings.ts'

const SUBDIVISION_LABELS: Record<number, string> = {
  1: 'Quarter',
  2: 'Eighth',
  3: 'Triplet',
  4: 'Sixteenth',
}

/** Off-beat subdivisions always tick at a fixed quiet level, under the beats. */
const SUBDIVISION_ACCENT: AccentLevel = 'low'

const ACCENT_LABELS: Record<AccentLevel, string> = {
  off: 'off',
  low: 'low',
  mid: 'mid',
  high: 'high',
}

export function Metronome() {
  const engineRef = useRef(getAudioEngine())
  const schedulerRef = useRef<Scheduler | null>(null)
  const rafRef = useRef<number | null>(null)
  const tapsRef = useRef<number[]>([])

  const [settings] = useState(() => normalizeMetronomeSettings(metronomeSettingsStore.get()))
  const [tempo, setTempo] = useState(settings.bpm)
  const [beatsPerBar, setBeatsPerBar] = useState(settings.beatsPerBar)
  const [subdivisionsPerBeat, setSubdivisionsPerBeat] = useState(settings.subdivisionsPerBeat)
  const [soundId, setSoundId] = useState<ClickVoiceId>(settings.soundId)
  const [accents, setAccents] = useState<AccentLevel[]>(settings.accents)
  const [running, setRunning] = useState(false)
  const [activeBeat, setActiveBeat] = useState<number | null>(null)

  // The scheduler's onEvent callback is set once and must stay stable, so it
  // reads the live voice + accent pattern from refs rather than closures.
  const soundIdRef = useRef(soundId)
  const accentsRef = useRef(accents)
  soundIdRef.current = soundId
  accentsRef.current = accents

  // Persist preferences whenever they change.
  useEffect(() => {
    metronomeSettingsStore.set({ bpm: tempo, beatsPerBar, subdivisionsPerBeat, soundId, accents })
  }, [tempo, beatsPerBar, subdivisionsPerBeat, soundId, accents])

  // Keep the accent pattern sized to the meter: preserve existing beats, fill
  // new ones with the default (mid), drop removed ones.
  useEffect(() => {
    setAccents((prev) => resizeAccents(prev, beatsPerBar))
  }, [beatsPerBar])

  // Apply changes to a live scheduler without stopping it.
  useEffect(() => {
    schedulerRef.current?.setTempo(tempo)
  }, [tempo])
  useEffect(() => {
    schedulerRef.current?.setMeter({ beatsPerBar, subdivisionsPerBeat })
  }, [beatsPerBar, subdivisionsPerBeat])

  // Click voice per grid step: the beat's own accent level on the beat, a fixed
  // quiet tick on off-beat subdivisions. Reads voice + accents from refs so the
  // callback identity stays stable across setting changes.
  const handleEvent = useCallback((event: SchedulerEvent, when: number) => {
    const engine = engineRef.current
    const voice = soundIdRef.current
    if (event.subdivision !== 0) {
      const spec = resolveClickParams(voice, SUBDIVISION_ACCENT, true)
      if (spec) engine.playClick({ ...spec, when })
      return
    }
    const level = accentsRef.current[event.beat] ?? 'mid'
    const spec = resolveClickParams(voice, level, false)
    if (spec) engine.playClick({ ...spec, when })
  }, [])

  // Play a single preview click at the given level via the shared engine,
  // ensuring the AudioContext is running (this runs inside a user gesture).
  const previewClick = useCallback((voice: ClickVoiceId, level: AccentLevel) => {
    const engine = engineRef.current
    void engine.ensureRunning().then(() => {
      const spec = resolveClickParams(voice, level, false)
      if (spec) engine.playClick({ ...spec })
    })
  }, [])

  const changeSound = useCallback(
    (id: ClickVoiceId) => {
      setSoundId(id)
      previewClick(id, 'high')
    },
    [previewClick],
  )

  const cycleBeatAccent = useCallback(
    (index: number) => {
      const nextLevel = cycleAccent(accentsRef.current[index] ?? 'mid')
      setAccents((prev) => {
        const next = [...prev]
        next[index] = nextLevel
        return next
      })
      if (nextLevel !== 'off') previewClick(soundIdRef.current, nextLevel)
    },
    [previewClick],
  )

  // Drive the beat indicator from the audio-accurate position, only
  // re-rendering when the lit beat actually changes.
  const runIndicator = useCallback(() => {
    const scheduler = schedulerRef.current
    if (scheduler) {
      const pos = scheduler.currentPosition()
      const beat = pos ? pos.beat : null
      setActiveBeat((prev) => (prev === beat ? prev : beat))
    }
    rafRef.current = requestAnimationFrame(runIndicator)
  }, [])

  const start = useCallback(async () => {
    const engine = engineRef.current
    await engine.ensureRunning()
    let scheduler = schedulerRef.current
    if (!scheduler) {
      scheduler = new Scheduler(engine, {
        bpm: tempo,
        beatsPerBar,
        subdivisionsPerBeat,
        onEvent: handleEvent,
      })
      schedulerRef.current = scheduler
    } else {
      scheduler.setTempo(tempo)
      scheduler.setMeter({ beatsPerBar, subdivisionsPerBeat })
    }
    scheduler.start()
    setRunning(true)
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(runIndicator)
  }, [tempo, beatsPerBar, subdivisionsPerBeat, handleEvent, runIndicator])

  const stop = useCallback(() => {
    schedulerRef.current?.stop()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setRunning(false)
    setActiveBeat(null)
  }, [])

  // Tidy up the transport and animation frame on unmount.
  useEffect(
    () => () => {
      schedulerRef.current?.stop()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const changeTempo = useCallback((next: number) => setTempo(clampTempo(next)), [])

  const handleTap = useCallback(() => {
    const { taps, bpm } = registerTap(tapsRef.current, performance.now())
    tapsRef.current = taps
    if (bpm !== null) setTempo(clampTempo(bpm))
  }, [])

  const beats = Array.from({ length: beatsPerBar }, (_, i) => i)

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Metronome</h1>
        <p className="tool-page-lead">
          Accented downbeats, subdivisions, and tap tempo. Audio starts only when you press
          Start.
        </p>
      </div>

      <div className="mn-beats" role="group" aria-label="Per-beat accents — tap a beat to change its accent">
        {beats.map((i) => {
          const level = accents[i] ?? 'mid'
          const active = running && activeBeat === i
          return (
            <button
              key={i}
              type="button"
              className={`mn-dot-btn${active ? ' mn-dot-active' : ''}`}
              onClick={() => cycleBeatAccent(i)}
              aria-label={`Beat ${i + 1} accent: ${ACCENT_LABELS[level]}. Tap to change.`}
            >
              <span className={`mn-dot mn-dot-${level}`} />
            </button>
          )
        })}
      </div>
      <p className="mn-beats-hint">Tap a beat to cycle its accent: off → low → mid → high.</p>

      <div className="tool-controls">
        <div className="tool-control-group mn-tempo-group">
          <span className="tool-control-label">Tempo</span>
          <div className="mn-tempo-readout">
            <span className="mn-tempo-value">{tempo}</span>
            <span className="mn-tempo-unit">BPM</span>
          </div>
          <div className="mn-steppers">
            <button type="button" className="mn-stepper" onClick={() => changeTempo(tempo - 5)}>
              −5
            </button>
            <button type="button" className="mn-stepper" onClick={() => changeTempo(tempo - 1)}>
              −1
            </button>
            <button type="button" className="mn-stepper" onClick={() => changeTempo(tempo + 1)}>
              +1
            </button>
            <button type="button" className="mn-stepper" onClick={() => changeTempo(tempo + 5)}>
              +5
            </button>
          </div>
          <input
            type="range"
            className="mn-slider"
            min={MIN_TEMPO}
            max={MAX_TEMPO}
            value={tempo}
            aria-label="Tempo in beats per minute"
            onChange={(e) => changeTempo(Number(e.target.value))}
          />
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Beats per bar</span>
          <Segmented
            options={BEATS_PER_BAR_OPTIONS}
            value={beatsPerBar}
            onChange={setBeatsPerBar}
            renderLabel={(n) => String(n)}
          />
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Subdivision</span>
          <Segmented
            options={SUBDIVISION_OPTIONS}
            value={subdivisionsPerBeat}
            onChange={setSubdivisionsPerBeat}
            renderLabel={(n) => SUBDIVISION_LABELS[n] ?? String(n)}
          />
        </div>

        <div className="tool-control-group mn-sound-group">
          <span className="tool-control-label">Click sound</span>
          <div className="mn-sounds" role="radiogroup" aria-label="Click sound">
            {CLICK_VOICES.map((voice) => (
              <button
                key={voice.id}
                type="button"
                role="radio"
                aria-checked={voice.id === soundId}
                className={`mn-sound${voice.id === soundId ? ' mn-sound-active' : ''}`}
                title={voice.description}
                onClick={() => changeSound(voice.id)}
              >
                <span className="mn-sound-name">{voice.label}</span>
                <span className="mn-sound-desc">{voice.description}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mn-transport">
        <button
          type="button"
          className={`mn-start${running ? ' mn-start-active' : ''}`}
          onClick={() => (running ? stop() : void start())}
        >
          {running ? 'Stop' : 'Start'}
        </button>
        <button type="button" className="mn-tap" onClick={handleTap}>
          Tap tempo
        </button>
      </div>
    </div>
  )
}

interface SegmentedProps<T extends number> {
  options: readonly T[]
  value: T
  onChange: (value: T) => void
  renderLabel: (value: T) => string
}

function Segmented<T extends number>({ options, value, onChange, renderLabel }: SegmentedProps<T>) {
  return (
    <div className="mn-segmented" role="group">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={`mn-segment${option === value ? ' mn-segment-active' : ''}`}
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {renderLabel(option)}
        </button>
      ))}
    </div>
  )
}
