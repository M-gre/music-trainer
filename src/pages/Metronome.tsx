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
  getAudioEngine,
  registerTap,
  Scheduler,
  type ClickOptions,
  type SchedulerEvent,
} from '../lib/audio/index.ts'
import {
  BEATS_PER_BAR_OPTIONS,
  clampTempo,
  MAX_TEMPO,
  metronomeSettingsStore,
  MIN_TEMPO,
  normalizeMetronomeSettings,
  SUBDIVISION_OPTIONS,
} from '../lib/metronomeSettings.ts'

// Click voices. Accent (beat 1) is highest + loudest; subdivisions are quieter
// and shorter so the main pulse stays clear.
const ACCENT_CLICK: Omit<ClickOptions, 'when'> = { frequency: 1900, gain: 0.75, duration: 0.045 }
const BEAT_CLICK: Omit<ClickOptions, 'when'> = { frequency: 1250, gain: 0.5, duration: 0.04 }
const SUB_CLICK: Omit<ClickOptions, 'when'> = { frequency: 950, gain: 0.26, duration: 0.022 }

const SUBDIVISION_LABELS: Record<number, string> = {
  1: 'Quarter',
  2: 'Eighth',
  3: 'Triplet',
  4: 'Sixteenth',
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
  const [running, setRunning] = useState(false)
  const [activeBeat, setActiveBeat] = useState<number | null>(null)

  // Persist preferences whenever they change.
  useEffect(() => {
    metronomeSettingsStore.set({ bpm: tempo, beatsPerBar, subdivisionsPerBeat })
  }, [tempo, beatsPerBar, subdivisionsPerBeat])

  // Apply changes to a live scheduler without stopping it.
  useEffect(() => {
    schedulerRef.current?.setTempo(tempo)
  }, [tempo])
  useEffect(() => {
    schedulerRef.current?.setMeter({ beatsPerBar, subdivisionsPerBeat })
  }, [beatsPerBar, subdivisionsPerBeat])

  // Click voice per grid step: accent on beat 1, plain click on other beats,
  // quiet click on off-beat subdivisions. Depends only on the event, so stable.
  const handleEvent = useCallback((event: SchedulerEvent, when: number) => {
    const engine = engineRef.current
    if (event.subdivision !== 0) engine.playClick({ ...SUB_CLICK, when })
    else if (event.beat === 0) engine.playClick({ ...ACCENT_CLICK, when })
    else engine.playClick({ ...BEAT_CLICK, when })
  }, [])

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

      <div
        className="mn-beats"
        role="img"
        aria-label={`${beatsPerBar} beats per bar, accent on beat 1`}
      >
        {beats.map((i) => {
          const classes = ['mn-dot']
          if (i === 0) classes.push('mn-dot-one')
          if (running && activeBeat === i) classes.push('mn-dot-active')
          return <span key={i} className={classes.join(' ')} />
        })}
      </div>

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
