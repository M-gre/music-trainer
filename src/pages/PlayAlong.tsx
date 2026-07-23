/**
 * Play-Along — drum-groove backing track. Picks a groove, drives it with the
 * pure `Scheduler` + `GroovePlayer` (which own all the rhythmic math), and lets
 * the player mute individual voices, toggle a count-in and set master volume,
 * all live mid-playback.
 *
 * Like the Metronome it stays thin: React owns UI state + persistence + the
 * requestAnimationFrame beat indicator, while the AudioContext is created and
 * resumed only inside the Start handler (`ensureRunning`), never at mount, so
 * the page never trips the browser's autoplay block.
 *
 * The layout keeps the drum controls in one `pa-section` so the upcoming chord
 * progression accompaniment (next roadmap item) can slot in as a sibling
 * section below without disturbing the transport.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DRUM_VOICES,
  getAudioEngine,
  GROOVES,
  GroovePlayer,
  grooveBeatsPerBar,
  Scheduler,
  type DrumVoice,
  type Groove,
} from '../lib/audio/index.ts'
import {
  clampPlayAlongTempo,
  getGroove,
  grooveVoices,
  MAX_PLAY_ALONG_TEMPO,
  MIN_PLAY_ALONG_TEMPO,
  normalizePlayAlongSettings,
  playAlongSettingsStore,
  VOICE_LABELS,
} from '../lib/playAlongSettings.ts'

/** Short "4/4 · 8ths" style meta line for a groove card. */
const SUBDIVISION_META: Record<Groove['subdivision'], string> = {
  '8th': '8ths',
  '16th': '16ths',
  triplet: 'triplet',
}

function grooveMeta(groove: Groove): string {
  return `${grooveBeatsPerBar(groove)}/4 · ${SUBDIVISION_META[groove.subdivision]}`
}

export function PlayAlong() {
  const engineRef = useRef(getAudioEngine())
  const schedulerRef = useRef<Scheduler | null>(null)
  const playerRef = useRef<GroovePlayer | null>(null)
  const rafRef = useRef<number | null>(null)

  const [settings] = useState(() => normalizePlayAlongSettings(playAlongSettingsStore.get()))
  const [grooveId, setGrooveId] = useState(settings.grooveId)
  const [tempo, setTempo] = useState(settings.bpm)
  const [countIn, setCountIn] = useState(settings.countIn)
  const [masterVolume, setMasterVolume] = useState(settings.masterVolume)
  const [muted, setMuted] = useState<DrumVoice[]>(settings.mutedVoices)
  const [running, setRunning] = useState(false)
  const [activeBeat, setActiveBeat] = useState<number | null>(null)
  const [countingIn, setCountingIn] = useState(false)

  const groove = getGroove(grooveId)
  const voices = grooveVoices(groove)
  const beatCount = grooveBeatsPerBar(groove)

  // Persist preferences whenever they change.
  useEffect(() => {
    playAlongSettingsStore.set({
      grooveId,
      bpm: tempo,
      countIn,
      masterVolume,
      mutedVoices: muted,
    })
  }, [grooveId, tempo, countIn, masterVolume, muted])

  // Apply changes to the live transport/player without stopping playback.
  useEffect(() => {
    schedulerRef.current?.setTempo(tempo)
  }, [tempo])
  useEffect(() => {
    playerRef.current?.setGroove(getGroove(grooveId))
  }, [grooveId])
  useEffect(() => {
    playerRef.current?.setCountIn({ bars: countIn ? 1 : 0 })
  }, [countIn])
  useEffect(() => {
    engineRef.current.setMasterVolume(masterVolume)
  }, [masterVolume])
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    for (const voice of DRUM_VOICES) player.setMuted(voice, muted.includes(voice))
  }, [muted])

  // Drive the beat indicator + count-in state from the audio-accurate position.
  const runIndicator = useCallback(() => {
    const scheduler = schedulerRef.current
    const player = playerRef.current
    if (scheduler && player) {
      const pos = scheduler.currentPosition()
      if (!pos) {
        setActiveBeat((prev) => (prev === null ? prev : null))
        setCountingIn((prev) => (prev ? false : prev))
      } else {
        const inCountIn = pos.bar < player.countInBars
        setActiveBeat((prev) => (prev === pos.beat ? prev : pos.beat))
        setCountingIn((prev) => (prev === inCountIn ? prev : inCountIn))
      }
    }
    rafRef.current = requestAnimationFrame(runIndicator)
  }, [])

  const start = useCallback(async () => {
    const engine = engineRef.current
    await engine.ensureRunning()
    engine.setMasterVolume(masterVolume)

    let scheduler = schedulerRef.current
    let player = playerRef.current
    if (!scheduler || !player) {
      scheduler = new Scheduler(engine, { bpm: tempo })
      player = new GroovePlayer(scheduler, engine, {
        groove: getGroove(grooveId),
        countIn: { bars: countIn ? 1 : 0 },
        muted,
      })
      schedulerRef.current = scheduler
      playerRef.current = player
    } else {
      scheduler.setTempo(tempo)
      player.setGroove(getGroove(grooveId))
      player.setCountIn({ bars: countIn ? 1 : 0 })
      for (const voice of DRUM_VOICES) player.setMuted(voice, muted.includes(voice))
    }
    player.start()
    setRunning(true)
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(runIndicator)
  }, [tempo, grooveId, countIn, masterVolume, muted, runIndicator])

  const stop = useCallback(() => {
    playerRef.current?.stop()
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setRunning(false)
    setActiveBeat(null)
    setCountingIn(false)
  }, [])

  // Tidy up the transport and animation frame on unmount.
  useEffect(
    () => () => {
      playerRef.current?.stop()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const changeTempo = useCallback((next: number) => setTempo(clampPlayAlongTempo(next)), [])

  const toggleMute = useCallback((voice: DrumVoice) => {
    setMuted((prev) => (prev.includes(voice) ? prev.filter((v) => v !== voice) : [...prev, voice]))
  }, [])

  const beats = Array.from({ length: beatCount }, (_, i) => i)
  const volumePercent = Math.round(masterVolume * 100)

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Play-Along</h1>
        <p className="tool-page-lead">
          Pick a drum groove and jam over it. Adjust the tempo, mute voices you want to cover
          yourself, and use the count-in to catch the "1". Audio starts only when you press Start.
        </p>
      </div>

      <section className="pa-section" aria-label="Drum groove">
        <div className="tool-control-group pa-groove-group">
          <span className="tool-control-label">Groove</span>
          <div className="pa-grooves" role="radiogroup" aria-label="Groove">
            {GROOVES.map((g) => (
              <button
                key={g.id}
                type="button"
                role="radio"
                aria-checked={g.id === grooveId}
                className={`pa-groove${g.id === grooveId ? ' pa-groove-active' : ''}`}
                onClick={() => setGrooveId(g.id)}
              >
                <span className="pa-groove-name">{g.name}</span>
                <span className="pa-groove-meta">{grooveMeta(g)}</span>
                <span className="pa-groove-desc">{g.description}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          className="pa-beats"
          role="group"
          aria-label="Beat indicator"
          data-counting-in={countingIn}
        >
          {beats.map((i) => {
            const active = running && activeBeat === i
            const isDownbeat = i === 0
            return (
              <span
                key={i}
                className={`pa-dot${isDownbeat ? ' pa-dot-downbeat' : ''}${
                  active ? ' pa-dot-active' : ''
                }`}
                aria-hidden="true"
              />
            )
          })}
        </div>
        <p className="pa-beats-hint">
          {countingIn ? 'Counting in…' : running ? 'Playing' : 'Beat 1 is highlighted'}
        </p>

        <div className="tool-controls">
          <div className="tool-control-group pa-tempo-group">
            <span className="tool-control-label">Tempo</span>
            <div className="pa-tempo-readout">
              <span className="pa-tempo-value">{tempo}</span>
              <span className="pa-tempo-unit">BPM</span>
            </div>
            <div className="pa-steppers">
              <button type="button" className="pa-stepper" onClick={() => changeTempo(tempo - 5)}>
                −5
              </button>
              <button type="button" className="pa-stepper" onClick={() => changeTempo(tempo - 1)}>
                −1
              </button>
              <button type="button" className="pa-stepper" onClick={() => changeTempo(tempo + 1)}>
                +1
              </button>
              <button type="button" className="pa-stepper" onClick={() => changeTempo(tempo + 5)}>
                +5
              </button>
            </div>
            <input
              type="range"
              className="pa-slider"
              min={MIN_PLAY_ALONG_TEMPO}
              max={MAX_PLAY_ALONG_TEMPO}
              value={tempo}
              aria-label="Tempo in beats per minute"
              onChange={(e) => changeTempo(Number(e.target.value))}
            />
          </div>

          <div className="tool-control-group pa-mute-group">
            <span className="tool-control-label">Mute voices</span>
            <div className="pa-chips" role="group" aria-label="Mute drum voices">
              {voices.map((voice) => {
                const isMuted = muted.includes(voice)
                return (
                  <button
                    key={voice}
                    type="button"
                    aria-pressed={isMuted}
                    className={`pa-chip${isMuted ? ' pa-chip-muted' : ''}`}
                    onClick={() => toggleMute(voice)}
                  >
                    {VOICE_LABELS[voice]}
                    <span className="pa-chip-state">{isMuted ? 'muted' : 'on'}</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="tool-control-group pa-options-group">
            <span className="tool-control-label">Count-in</span>
            <button
              type="button"
              role="switch"
              aria-checked={countIn}
              className={`pa-toggle${countIn ? ' pa-toggle-on' : ''}`}
              onClick={() => setCountIn((prev) => !prev)}
            >
              <span className="pa-toggle-track">
                <span className="pa-toggle-thumb" />
              </span>
              <span className="pa-toggle-label">{countIn ? 'One bar' : 'Off'}</span>
            </button>

            <span className="tool-control-label pa-volume-label">Master volume</span>
            <div className="pa-volume">
              <input
                type="range"
                className="pa-slider"
                min={0}
                max={100}
                value={volumePercent}
                aria-label="Master volume"
                onChange={(e) => setMasterVolume(Number(e.target.value) / 100)}
              />
              <span className="pa-volume-value">{volumePercent}%</span>
            </div>
          </div>
        </div>

        <div className="pa-transport">
          <button
            type="button"
            className={`pa-start${running ? ' pa-start-active' : ''}`}
            onClick={() => (running ? stop() : void start())}
          >
            {running ? 'Stop' : 'Start'}
          </button>
        </div>
      </section>

      {/* Chord progression accompaniment (next roadmap item) slots in here as a
          sibling <section className="pa-section"> below the drum controls. */}
    </div>
  )
}
