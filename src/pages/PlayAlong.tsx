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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fretboard, type FretboardMarker } from '../components/Fretboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { buildChordToneMarkers } from '../lib/chordTones.ts'
import {
  DIATONIC_SCALE_OPTIONS,
  keyPrefersFlats,
  type DiatonicScaleId,
} from '../lib/diatonicChords.ts'
import {
  DRUM_VOICES,
  getAudioEngine,
  GROOVES,
  GroovePlayer,
  grooveBeatsPerBar,
  Scheduler,
  subdivisionsPerBeat,
  type DrumVoice,
  type Groove,
} from '../lib/audio/index.ts'
import {
  barToChordIndex,
  ChordCompPlayer,
  COMP_STYLE_LABELS,
  COMP_STYLES,
  CUSTOM_PROGRESSION_ID,
  DEFAULT_COMP_VELOCITY,
  keyOptions,
  MAX_BARS_PER_CHORD,
  MIN_BARS_PER_CHORD,
  getProgressionPreset,
  progressionPresetsForMode,
  resolveAccompaniment,
  type ChordCompConfig,
  type CompStyle,
} from '../lib/accompaniment.ts'
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
import {
  barsToReachMax,
  bpmForBar,
  clampTrainerBpm,
  TRAINER_EVERY_N_OPTIONS,
  TRAINER_STEP_OPTIONS,
  type TempoTrainerConfig,
} from '../lib/tempoTrainer.ts'

const KEY_OPTIONS = keyOptions()
const BARS_PER_CHORD_OPTIONS = Array.from(
  { length: MAX_BARS_PER_CHORD - MIN_BARS_PER_CHORD + 1 },
  (_, i) => MIN_BARS_PER_CHORD + i,
)

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
  const compRef = useRef<ChordCompPlayer | null>(null)
  const rafRef = useRef<number | null>(null)

  // Global instrument/tuning for the chord-tones fretboard panel.
  const { tuning, setTuningId } = useInstrumentSettings()

  const [settings] = useState(() => normalizePlayAlongSettings(playAlongSettingsStore.get()))
  const [grooveId, setGrooveId] = useState(settings.grooveId)
  const [tempo, setTempo] = useState(settings.bpm)
  const [countIn, setCountIn] = useState(settings.countIn)
  const [masterVolume, setMasterVolume] = useState(settings.masterVolume)
  const [drumVolume, setDrumVolume] = useState(settings.drumVolume)
  const [accompanimentVolume, setAccompanimentVolume] = useState(settings.accompanimentVolume)
  const [muted, setMuted] = useState<DrumVoice[]>(settings.mutedVoices)
  const [running, setRunning] = useState(false)
  const [activeBeat, setActiveBeat] = useState<number | null>(null)
  const [countingIn, setCountingIn] = useState(false)

  // Accompaniment (chord-progression) state.
  const [accEnabled, setAccEnabled] = useState(settings.accompaniment.enabled)
  const [accRootPc, setAccRootPc] = useState(settings.accompaniment.rootPc)
  const [accKeyMode, setAccKeyMode] = useState<DiatonicScaleId>(settings.accompaniment.keyMode)
  const [accProgId, setAccProgId] = useState(settings.accompaniment.progressionId)
  const [accCustom, setAccCustom] = useState(settings.accompaniment.customDegrees)
  const [accBarsPerChord, setAccBarsPerChord] = useState(settings.accompaniment.barsPerChord)
  const [accStyle, setAccStyle] = useState<CompStyle>(settings.accompaniment.style)
  const [activeChordIndex, setActiveChordIndex] = useState<number | null>(null)
  const [showChordTones, setShowChordTones] = useState(settings.showChordTones)

  // Tempo trainer: auto-increase the BPM every N bars up to a target. The
  // tempo slider (`tempo`) acts as the start BPM; `currentBpm` is the effective
  // tempo the transport is running at (equal to the slider until the ramp
  // kicks in), shown prominently while playing.
  const [trainerEnabled, setTrainerEnabled] = useState(settings.tempoTrainer.enabled)
  const [trainerStep, setTrainerStep] = useState(settings.tempoTrainer.stepBpm)
  const [trainerEveryN, setTrainerEveryN] = useState(settings.tempoTrainer.everyNBars)
  const [trainerMax, setTrainerMax] = useState(settings.tempoTrainer.maxBpm)
  const [currentBpm, setCurrentBpm] = useState(settings.bpm)

  const groove = getGroove(grooveId)
  const voices = grooveVoices(groove)
  const beatCount = grooveBeatsPerBar(groove)
  const subsPerBeat = subdivisionsPerBeat(groove.subdivision)

  // Resolve the accompaniment settings into chords + voice-led voicings once
  // per change; the audio player and the display both read from this.
  const resolved = useMemo(
    () =>
      resolveAccompaniment({
        enabled: accEnabled,
        rootPc: accRootPc,
        keyMode: accKeyMode,
        progressionId: accProgId,
        customDegrees: accCustom,
        barsPerChord: accBarsPerChord,
        style: accStyle,
      }),
    [accEnabled, accRootPc, accKeyMode, accProgId, accCustom, accBarsPerChord, accStyle],
  )
  const resolvedRef = useRef(resolved)
  resolvedRef.current = resolved
  const countInBarsRef = useRef(0)
  countInBarsRef.current = countIn ? 1 : 0

  // Tempo-trainer config, with the tempo slider as the live start BPM. Held in
  // a ref so the rAF loop reads the latest without re-creating the callback.
  const trainerConfig = useMemo<TempoTrainerConfig>(
    () => ({
      enabled: trainerEnabled,
      startBpm: tempo,
      stepBpm: trainerStep,
      everyNBars: trainerEveryN,
      maxBpm: Math.max(tempo, trainerMax),
    }),
    [trainerEnabled, tempo, trainerStep, trainerEveryN, trainerMax],
  )
  const trainerConfigRef = useRef(trainerConfig)
  trainerConfigRef.current = trainerConfig
  const barsToTarget = barsToReachMax(trainerConfig)

  // Live comp-player configuration. `enabled` also requires a valid, non-empty
  // progression so a parse error silences the comp without stopping playback.
  const compConfig = useMemo<ChordCompConfig>(
    () => ({
      enabled: accEnabled && resolved.error === null && resolved.voicings.length > 0,
      style: accStyle,
      voicings: resolved.voicings,
      barsPerChord: resolved.barsPerChord,
      beatsPerBar: beatCount,
      subdivisionsPerBeat: subsPerBeat,
      // Follow the effective (possibly ramped) tempo so the comp's chord
      // durations track the tempo trainer.
      bpm: currentBpm,
      countInBars: countIn ? 1 : 0,
      velocity: DEFAULT_COMP_VELOCITY,
      volume: accompanimentVolume,
    }),
    [accEnabled, accStyle, resolved, beatCount, subsPerBeat, currentBpm, countIn, accompanimentVolume],
  )

  // Persist preferences whenever they change.
  useEffect(() => {
    playAlongSettingsStore.set({
      grooveId,
      bpm: tempo,
      countIn,
      masterVolume,
      drumVolume,
      accompanimentVolume,
      mutedVoices: muted,
      accompaniment: {
        enabled: accEnabled,
        rootPc: accRootPc,
        keyMode: accKeyMode,
        progressionId: accProgId,
        customDegrees: accCustom,
        barsPerChord: accBarsPerChord,
        style: accStyle,
      },
      showChordTones,
      tempoTrainer: {
        enabled: trainerEnabled,
        startBpm: tempo,
        stepBpm: trainerStep,
        everyNBars: trainerEveryN,
        maxBpm: Math.max(tempo, trainerMax),
      },
    })
  }, [
    grooveId,
    tempo,
    countIn,
    masterVolume,
    drumVolume,
    accompanimentVolume,
    muted,
    accEnabled,
    accRootPc,
    accKeyMode,
    accProgId,
    accCustom,
    accBarsPerChord,
    accStyle,
    showChordTones,
    trainerEnabled,
    trainerStep,
    trainerEveryN,
    trainerMax,
  ])

  // Push accompaniment changes to the live comp player mid-playback.
  useEffect(() => {
    compRef.current?.configure(compConfig)
  }, [compConfig])

  // Apply changes to the live transport/player without stopping playback.
  // With the trainer off the slider drives the transport directly; with it on
  // the rAF ramp (below) owns the tempo and the slider only re-bases the start.
  useEffect(() => {
    if (trainerEnabled) return
    schedulerRef.current?.setTempo(tempo)
  }, [tempo, trainerEnabled])
  // Keep the effective-BPM readout tracking the slider whenever the ramp is not
  // actively driving it (stopped, or trainer disabled).
  useEffect(() => {
    if (!running || !trainerEnabled) setCurrentBpm(tempo)
  }, [tempo, running, trainerEnabled])
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
    playerRef.current?.setVolume(drumVolume)
  }, [drumVolume])
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    for (const voice of DRUM_VOICES) player.setMuted(voice, muted.includes(voice))
  }, [muted])

  // Drive the beat indicator, count-in state and the current-chord display from
  // the audio-accurate position (not the lookahead), so the UI matches what is
  // actually sounding.
  const runIndicator = useCallback(() => {
    const scheduler = schedulerRef.current
    const player = playerRef.current
    if (scheduler && player) {
      const pos = scheduler.currentPosition()
      if (!pos) {
        setActiveBeat((prev) => (prev === null ? prev : null))
        setCountingIn((prev) => (prev ? false : prev))
        setActiveChordIndex((prev) => (prev === null ? prev : null))
      } else {
        const inCountIn = pos.bar < player.countInBars
        setActiveBeat((prev) => (prev === pos.beat ? prev : pos.beat))
        setCountingIn((prev) => (prev === inCountIn ? prev : inCountIn))
        const voicingCount = resolvedRef.current.voicings.length
        const chordIndex = inCountIn
          ? null
          : barToChordIndex(
              pos.bar - countInBarsRef.current,
              voicingCount,
              resolvedRef.current.barsPerChord,
            )
        setActiveChordIndex((prev) => (prev === chordIndex ? prev : chordIndex))

        // Tempo trainer: ramp the transport tempo on bar boundaries. The
        // scheduler's setTempo only re-spaces *future* steps, so the beat math
        // (and the drum/comp players reading these same events) stays
        // continuous across the change — nothing skips or desyncs.
        const cfg = trainerConfigRef.current
        if (cfg.enabled) {
          const patternBar = pos.bar - countInBarsRef.current
          const target = inCountIn ? clampTrainerBpm(cfg.startBpm) : bpmForBar(cfg, patternBar)
          if (scheduler.tempo !== target) scheduler.setTempo(target)
          setCurrentBpm((prev) => (prev === target ? prev : target))
        }
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
    let comp = compRef.current
    if (!scheduler || !player || !comp) {
      scheduler = new Scheduler(engine, { bpm: tempo })
      player = new GroovePlayer(scheduler, engine, {
        groove: getGroove(grooveId),
        countIn: { bars: countIn ? 1 : 0 },
        muted,
        drumVolume,
      })
      comp = new ChordCompPlayer(engine)
      schedulerRef.current = scheduler
      playerRef.current = player
      compRef.current = comp
    } else {
      scheduler.setTempo(tempo)
      player.setCountIn({ bars: countIn ? 1 : 0 })
      player.setVolume(drumVolume)
      for (const voice of DRUM_VOICES) player.setMuted(voice, muted.includes(voice))
    }
    // Apply the groove's meter/swing to the transport (also done by
    // GroovePlayer.start, which we bypass so we can own the event callback).
    player.setGroove(getGroove(grooveId))
    comp.configure(compConfig)

    // Compose both players onto the scheduler's single event callback and wire
    // it BEFORE starting, so the very first bar's chord isn't missed when the
    // count-in is off. Both receive the same events + audio `when`, so the
    // comp stays sample-accurately locked to the drums.
    const drummer = player
    const comper = comp
    scheduler.onEvent = (event, when) => {
      drummer.handleEvent(event, when)
      comper.handleEvent(event, when)
    }
    scheduler.start()
    setRunning(true)
    if (rafRef.current === null) rafRef.current = requestAnimationFrame(runIndicator)
  }, [tempo, grooveId, countIn, masterVolume, drumVolume, muted, compConfig, runIndicator])

  const stop = useCallback(() => {
    const scheduler = schedulerRef.current
    if (scheduler) {
      scheduler.stop()
      scheduler.onEvent = null
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    setRunning(false)
    setActiveBeat(null)
    setCountingIn(false)
    setActiveChordIndex(null)
  }, [])

  // Tidy up the transport and animation frame on unmount.
  useEffect(
    () => () => {
      schedulerRef.current?.stop()
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  const changeTempo = useCallback((next: number) => setTempo(clampPlayAlongTempo(next)), [])
  const changeTrainerMax = useCallback(
    (next: number) => setTrainerMax(clampPlayAlongTempo(next)),
    [],
  )
  const trainerTarget = Math.max(tempo, trainerMax)

  const toggleMute = useCallback((voice: DrumVoice) => {
    setMuted((prev) => (prev.includes(voice) ? prev.filter((v) => v !== voice) : [...prev, voice]))
  }, [])

  // Switch key mode. A custom progression keeps its degrees (they re-resolve to
  // the new mode); a preset that doesn't belong to the new mode falls back to
  // that mode's first preset so the picker never shows an out-of-mode selection.
  const changeKeyMode = useCallback((mode: DiatonicScaleId) => {
    setAccKeyMode(mode)
    setAccProgId((prev) => {
      if (prev === CUSTOM_PROGRESSION_ID) return prev
      if (getProgressionPreset(prev)?.mode === mode) return prev
      return progressionPresetsForMode(mode)[0]?.id ?? prev
    })
  }, [])

  const modePresets = progressionPresetsForMode(accKeyMode)

  const beats = Array.from({ length: beatCount }, (_, i) => i)
  const volumePercent = Math.round(masterVolume * 100)
  const drumVolumePercent = Math.round(drumVolume * 100)
  const accompanimentVolumePercent = Math.round(accompanimentVolume * 100)

  // Chord-tones panel: the current chord (index 0 when stopped, so the upcoming
  // first chord is shown) mapped to fretboard markers on the global tuning.
  const tonePrefer = keyPrefersFlats(accRootPc, accKeyMode) ? 'flat' : 'sharp'
  const currentChordIdx = activeChordIndex ?? 0
  const currentChord = resolved.chords[currentChordIdx] ?? resolved.chords[0]
  const nextChord =
    resolved.chords.length > 0
      ? resolved.chords[(currentChordIdx + 1) % resolved.chords.length]
      : undefined
  const chordToneMarkers = useMemo<FretboardMarker[]>(() => {
    if (!currentChord) return []
    return buildChordToneMarkers(
      { root: currentChord.root, quality: currentChord.quality },
      tuning,
      0,
      12,
      accRootPc,
    ).map((m) => ({ string: m.string, fret: m.fret, label: m.degree, variant: m.variant }))
  }, [currentChord, tuning, accRootPc])

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
              <span className={`pa-tempo-value${trainerEnabled && running ? ' pa-tempo-live' : ''}`}>
                {running ? currentBpm : tempo}
              </span>
              <span className="pa-tempo-unit">BPM</span>
            </div>
            {trainerEnabled && (
              <span className="pa-tempo-note">Trainer on · slider sets the start ({tempo})</span>
            )}
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

          <div className="tool-control-group pa-mix-group">
            <span className="tool-control-label">Mix</span>
            <label className="pa-mix-row">
              <span className="pa-mix-label">Drums</span>
              <input
                type="range"
                className="pa-slider"
                min={0}
                max={100}
                value={drumVolumePercent}
                aria-label="Drums volume"
                onChange={(e) => setDrumVolume(Number(e.target.value) / 100)}
              />
              <span className="pa-volume-value">{drumVolumePercent}%</span>
            </label>
            <label className="pa-mix-row">
              <span className="pa-mix-label">Accompaniment</span>
              <input
                type="range"
                className="pa-slider"
                min={0}
                max={100}
                value={accompanimentVolumePercent}
                aria-label="Accompaniment volume"
                onChange={(e) => setAccompanimentVolume(Number(e.target.value) / 100)}
              />
              <span className="pa-volume-value">{accompanimentVolumePercent}%</span>
            </label>
            <p className="pa-mix-hint">
              Drums are the backbone; the accompaniment sits under them by default.
            </p>
          </div>

          <div className="tool-control-group pa-trainer-group">
            <div className="pa-trainer-head">
              <span className="tool-control-label">Tempo trainer</span>
              <button
                type="button"
                role="switch"
                aria-checked={trainerEnabled}
                className={`pa-toggle${trainerEnabled ? ' pa-toggle-on' : ''}`}
                onClick={() => setTrainerEnabled((prev) => !prev)}
              >
                <span className="pa-toggle-track">
                  <span className="pa-toggle-thumb" />
                </span>
                <span className="pa-toggle-label">{trainerEnabled ? 'On' : 'Off'}</span>
              </button>
            </div>

            {trainerEnabled ? (
              <>
                <p className="pa-trainer-summary">
                  Speeds up from <strong>{tempo}</strong> to <strong>{trainerTarget}</strong> BPM,
                  +{trainerStep} every {trainerEveryN} {trainerEveryN === 1 ? 'bar' : 'bars'}
                  {barsToTarget !== null ? ` · target in ${barsToTarget} bars` : ''}.
                </p>

                <span className="tool-control-label pa-trainer-field-label">Step</span>
                <div className="pa-seg" role="radiogroup" aria-label="Tempo increase per step">
                  {TRAINER_STEP_OPTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={trainerStep === s}
                      className={`pa-seg-btn${trainerStep === s ? ' pa-seg-btn-active' : ''}`}
                      onClick={() => setTrainerStep(s)}
                    >
                      +{s}
                    </button>
                  ))}
                </div>

                <span className="tool-control-label pa-trainer-field-label">Every</span>
                <div className="pa-seg" role="radiogroup" aria-label="Bars between increases">
                  {TRAINER_EVERY_N_OPTIONS.map((n) => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={trainerEveryN === n}
                      className={`pa-seg-btn${trainerEveryN === n ? ' pa-seg-btn-active' : ''}`}
                      onClick={() => setTrainerEveryN(n)}
                    >
                      {n} {n === 1 ? 'bar' : 'bars'}
                    </button>
                  ))}
                </div>

                <span className="tool-control-label pa-trainer-field-label">Target BPM</span>
                <div className="pa-trainer-target">
                  <div className="pa-steppers">
                    <button
                      type="button"
                      className="pa-stepper"
                      onClick={() => changeTrainerMax(trainerTarget - 10)}
                    >
                      −10
                    </button>
                    <button
                      type="button"
                      className="pa-stepper"
                      onClick={() => changeTrainerMax(trainerTarget - 5)}
                    >
                      −5
                    </button>
                    <button
                      type="button"
                      className="pa-stepper"
                      onClick={() => changeTrainerMax(trainerTarget + 5)}
                    >
                      +5
                    </button>
                    <button
                      type="button"
                      className="pa-stepper"
                      onClick={() => changeTrainerMax(trainerTarget + 10)}
                    >
                      +10
                    </button>
                  </div>
                  <span className="pa-trainer-target-value">{trainerTarget} BPM</span>
                </div>
              </>
            ) : (
              <p className="pa-trainer-summary pa-trainer-summary-off">
                Automatically nudges the tempo up as you play — enable to drill a passage while it
                gradually speeds up.
              </p>
            )}
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

      <section className="pa-section pa-accomp" aria-label="Chord accompaniment">
        <div className="pa-accomp-head">
          <span className="tool-control-label">Chord accompaniment</span>
          <button
            type="button"
            role="switch"
            aria-checked={accEnabled}
            className={`pa-toggle${accEnabled ? ' pa-toggle-on' : ''}`}
            onClick={() => setAccEnabled((prev) => !prev)}
          >
            <span className="pa-toggle-track">
              <span className="pa-toggle-thumb" />
            </span>
            <span className="pa-toggle-label">{accEnabled ? 'On' : 'Off'}</span>
          </button>
        </div>
        <p className="pa-beats-hint pa-accomp-hint">
          A synth pad follows your key and progression, in sync with the drums — it plays even with
          every drum voice muted, so you get a harmonic backing track to jam over.
        </p>

        {/* Current / next chord display, driven by the visual beat clock. */}
        <div className="pa-chord-display" aria-live="polite">
          {resolved.error ? (
            <span className="pa-chord-error">{resolved.error}</span>
          ) : resolved.chords.length === 0 ? (
            <span className="pa-chord-error">No chords</span>
          ) : (
            (() => {
              const currentIdx = activeChordIndex ?? 0
              const current = resolved.chords[currentIdx] ?? resolved.chords[0]!
              const next = resolved.chords[(currentIdx + 1) % resolved.chords.length]!
              return (
                <>
                  <span className="pa-chord-symbol">{current.symbol}</span>
                  <span className="pa-chord-next">Next: {next.symbol}</span>
                </>
              )
            })()
          )}
        </div>

        {/* Progression laid out as chips, active chord highlighted. */}
        {resolved.chords.length > 0 && (
          <div className="pa-prog-chips" role="list" aria-label="Progression">
            {resolved.chords.map((chord, i) => (
              <span
                key={i}
                role="listitem"
                className={`pa-prog-chip${i === (activeChordIndex ?? -1) ? ' pa-prog-chip-active' : ''}`}
              >
                {chord.symbol}
              </span>
            ))}
          </div>
        )}

        {/* Chord-tones fretboard panel — build bass lines from the current chord. */}
        <div className="pa-tones-toggle">
          <span className="tool-control-label">Show chord tones on fretboard</span>
          <button
            type="button"
            role="switch"
            aria-checked={showChordTones}
            className={`pa-toggle${showChordTones ? ' pa-toggle-on' : ''}`}
            onClick={() => setShowChordTones((prev) => !prev)}
          >
            <span className="pa-toggle-track">
              <span className="pa-toggle-thumb" />
            </span>
            <span className="pa-toggle-label">{showChordTones ? 'On' : 'Off'}</span>
          </button>
        </div>

        {showChordTones && !resolved.error && currentChord && (
          <div className="pa-tones">
            <div className="pa-tones-bar" aria-live="polite">
              <span className="pa-tones-title">
                <strong>{currentChord.symbol}</strong> chord tones
              </span>
              {nextChord && <span className="pa-tones-next">Next: {nextChord.symbol}</span>}
            </div>
            <InstrumentPicker
              className="pa-tones-picker"
              value={tuning}
              onChange={(t) => setTuningId(t.id)}
            />
            <Fretboard
              tuning={tuning}
              fromFret={0}
              toFret={12}
              markers={chordToneMarkers}
              prefer={tonePrefer}
              ariaLabel={`${tuning.name} fretboard showing the tones of ${currentChord.symbol}`}
            />
            <p className="pa-tones-hint">
              Roots are highlighted; labels show each note's degree (R, 3/b3, 5, b7…) so you can
              build a bass line under the changes.
            </p>
          </div>
        )}

        <div className="tool-controls">
          <div className="tool-control-group pa-key-group">
            <span className="tool-control-label">Key</span>
            <div className="pa-key-grid" role="radiogroup" aria-label="Key">
              {KEY_OPTIONS.map((opt) => (
                <button
                  key={opt.pc}
                  type="button"
                  role="radio"
                  aria-checked={opt.pc === accRootPc}
                  className={`pa-key${opt.pc === accRootPc ? ' pa-key-active' : ''}`}
                  onClick={() => setAccRootPc(opt.pc)}
                >
                  {opt.name}
                </button>
              ))}
            </div>
            <span className="tool-control-label pa-mode-label">Mode</span>
            <div className="pa-seg pa-mode-seg" role="radiogroup" aria-label="Key mode">
              {DIATONIC_SCALE_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={opt.id === accKeyMode}
                  aria-label={`${opt.name} key`}
                  className={`pa-seg-btn${opt.id === accKeyMode ? ' pa-seg-btn-active' : ''}`}
                  onClick={() => changeKeyMode(opt.id)}
                >
                  {opt.name}
                </button>
              ))}
            </div>
          </div>

          <div className="tool-control-group pa-prog-group">
            <span className="tool-control-label">Progression</span>
            <div className="pa-chips" role="radiogroup" aria-label="Progression preset">
              {modePresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={preset.id === accProgId}
                  className={`pa-chip pa-prog-preset${preset.id === accProgId ? ' pa-chip-selected' : ''}`}
                  onClick={() => setAccProgId(preset.id)}
                >
                  {preset.name}
                </button>
              ))}
              <button
                type="button"
                role="radio"
                aria-checked={accProgId === CUSTOM_PROGRESSION_ID}
                className={`pa-chip pa-prog-preset${
                  accProgId === CUSTOM_PROGRESSION_ID ? ' pa-chip-selected' : ''
                }`}
                onClick={() => setAccProgId(CUSTOM_PROGRESSION_ID)}
              >
                Custom
              </button>
            </div>

            {accProgId === CUSTOM_PROGRESSION_ID && (
              <label className="pa-custom">
                <span className="tool-control-label">Degrees (1–7)</span>
                <input
                  type="text"
                  className={`pa-custom-input${resolved.error ? ' pa-custom-input-error' : ''}`}
                  value={accCustom}
                  inputMode="numeric"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="e.g. 1-5-6-4"
                  aria-label="Custom progression degrees"
                  aria-invalid={resolved.error !== null}
                  onChange={(e) => setAccCustom(e.target.value)}
                />
              </label>
            )}
          </div>

          <div className="tool-control-group pa-accomp-options">
            <span className="tool-control-label">Bars per chord</span>
            <div className="pa-seg" role="radiogroup" aria-label="Bars per chord">
              {BARS_PER_CHORD_OPTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  role="radio"
                  aria-checked={resolved.barsPerChord === n}
                  disabled={resolved.barsPerChordLocked}
                  className={`pa-seg-btn${resolved.barsPerChord === n ? ' pa-seg-btn-active' : ''}`}
                  onClick={() => setAccBarsPerChord(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            {resolved.barsPerChordLocked && (
              <span className="pa-seg-note">Fixed by the 12-bar form</span>
            )}

            <span className="tool-control-label pa-style-label">Style</span>
            <div className="pa-seg pa-style-seg" role="radiogroup" aria-label="Comping style">
              {COMP_STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  role="radio"
                  aria-checked={accStyle === style}
                  className={`pa-seg-btn${accStyle === style ? ' pa-seg-btn-active' : ''}`}
                  onClick={() => setAccStyle(style)}
                >
                  {COMP_STYLE_LABELS[style]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
