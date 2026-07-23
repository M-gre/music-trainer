/**
 * Chord Explorer — pick a root and chord quality and see it on both
 * instruments: every chord-tone position lit up across the whole fretboard
 * neck, and a concrete voicing (not just pitch classes) on the keyboard with
 * an inversion selector. "Play chord" sounds the keyboard voicing together;
 * "Play arpeggio" plays it as a timed up-then-down sequence.
 *
 * All chord math (tones, symbol, voicings/inversions, marker placement,
 * interval labeling) lives in `src/lib/chordExplorer.ts`, fully unit-tested.
 * This component stays thin: React state, persistence, and the click-time
 * audio (`ensureRunning` only ever runs inside the Play handlers, never at
 * mount, matching the Metronome/Circle of Fifths pattern).
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Fretboard } from '../components/Fretboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { Keyboard, type KeyboardMarker } from '../components/Keyboard.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import {
  arpeggioSteps,
  buildChordFretboardMarkers,
  buildChordKeyboardMarkers,
  chordExplorerSettingsStore,
  chordSymbol,
  chordTones,
  groupedQualities,
  inversionCount,
  normalizeChordExplorerSettings,
  QUALITY_GROUP_LABELS,
  QUALITY_GROUP_ORDER,
  voicingMidis,
  type ChordExplorerSettings,
  type ChordLabelMode,
} from '../lib/chordExplorer.ts'
import { CHORD_QUALITIES, getChordQuality, type ChordQuality } from '../lib/theory/chords.ts'
import { pcToName, type PitchClass } from '../lib/theory/notes.ts'
import { prefersFlats } from '../lib/theory/spell.ts'

const ROOTS: PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

const CHORD_DURATION = 1.4
const ARPEGGIO_NOTE_DURATION = 0.55
const ARPEGGIO_STEP_SECONDS = 0.24

const INVERSION_LABELS = ['Root position', '1st inversion', '2nd inversion', '3rd inversion']

const GROUPED_QUALITIES = groupedQualities(CHORD_QUALITIES)

export function ChordExplorer() {
  const { tuning, setTuningId } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())

  const [settings, setSettings] = useState<ChordExplorerSettings>(() =>
    normalizeChordExplorerSettings(chordExplorerSettingsStore.get()),
  )
  const [labelMode, setLabelMode] = useState<ChordLabelMode>('interval')
  const [busy, setBusy] = useState(false)

  const quality = getChordQuality(settings.qualityId)
  const prefer = prefersFlats(settings.root) ? 'flat' : 'sharp'

  const updateSettings = useCallback((next: ChordExplorerSettings) => {
    const normalized = normalizeChordExplorerSettings(next)
    setSettings(normalized)
    chordExplorerSettingsStore.set(normalized)
  }, [])

  const selectRoot = useCallback(
    (root: PitchClass) => updateSettings({ ...settings, root }),
    [settings, updateSettings],
  )

  const selectQuality = useCallback(
    (q: ChordQuality) => updateSettings({ ...settings, qualityId: q.id, inversion: 0 }),
    [settings, updateSettings],
  )

  const selectInversion = useCallback(
    (inversion: number) => updateSettings({ ...settings, inversion }),
    [settings, updateSettings],
  )

  const symbol = chordSymbol(settings.root, quality, prefer)
  const tones = useMemo(() => chordTones(settings.root, quality), [settings.root, quality])

  const voicing = useMemo(
    () => voicingMidis(settings.root, quality, settings.inversion),
    [settings.root, quality, settings.inversion],
  )

  const fretMarkers = useMemo(
    () => buildChordFretboardMarkers(tuning, settings.root, quality, 0, 12, labelMode, prefer),
    [tuning, settings.root, quality, labelMode, prefer],
  )

  const keyboardMarkers: KeyboardMarker[] = useMemo(
    () => buildChordKeyboardMarkers(settings.root, quality, settings.inversion, labelMode, prefer),
    [settings.root, quality, settings.inversion, labelMode, prefer],
  )

  // Keyboard range: snug around the actual voicing (padded a few semitones,
  // the component snaps to white keys), rather than a fixed span, so wide
  // voicings (e.g. add9 with a high root) never get clipped.
  const keyboardFrom = Math.min(...voicing) - 3
  const keyboardTo = Math.max(...voicing) + 3

  const playChord = useCallback(async () => {
    const engine = engineRef.current
    await engine.ensureRunning()
    setBusy(true)
    engine.playChord(voicing, CHORD_DURATION, { when: engine.currentTime })
    window.setTimeout(() => setBusy(false), CHORD_DURATION * 1000)
  }, [voicing])

  const playArpeggio = useCallback(async () => {
    const engine = engineRef.current
    await engine.ensureRunning()
    setBusy(true)
    const steps = arpeggioSteps(voicing, ARPEGGIO_STEP_SECONDS, engine.currentTime, true)
    for (const step of steps) engine.playNote(step.midi, ARPEGGIO_NOTE_DURATION, { when: step.when })
    const totalMs = (steps.length - 1) * ARPEGGIO_STEP_SECONDS * 1000 + ARPEGGIO_NOTE_DURATION * 1000
    window.setTimeout(() => setBusy(false), totalMs)
  }, [voicing])

  const inversionOptions = Array.from({ length: inversionCount(quality) }, (_, i) => i)

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Chord Explorer</h1>
        <p className="tool-page-lead">
          Pick a root and a chord quality to see every chord tone across the whole fretboard neck
          and a concrete voicing on the keyboard, with inversions and playback.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Root</span>
          <div className="mn-segmented" role="group">
            {ROOTS.map((pc) => (
              <button
                key={pc}
                type="button"
                className={`mn-segment${settings.root === pc ? ' mn-segment-active' : ''}`}
                aria-pressed={settings.root === pc}
                onClick={() => selectRoot(pc)}
              >
                {pcToName(pc, prefer)}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Inversion</span>
          <div className="mn-segmented" role="group">
            {inversionOptions.map((i) => (
              <button
                key={i}
                type="button"
                className={`mn-segment${settings.inversion === i ? ' mn-segment-active' : ''}`}
                aria-pressed={settings.inversion === i}
                onClick={() => selectInversion(i)}
              >
                {INVERSION_LABELS[i] ?? `Inversion ${i}`}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Fretboard labels</span>
          <div className="mn-segmented" role="group">
            {(['interval', 'note'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`mn-segment${labelMode === mode ? ' mn-segment-active' : ''}`}
                aria-pressed={labelMode === mode}
                onClick={() => setLabelMode(mode)}
              >
                {mode === 'interval' ? 'Intervals' : 'Note names'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="tool-control-group ce-quality-panel">
        <span className="tool-control-label">Quality</span>
        {QUALITY_GROUP_ORDER.map((group) => (
          <div key={group} className="ce-quality-subgroup">
            <span className="ce-quality-subgroup-label">{QUALITY_GROUP_LABELS[group]}</span>
            <div className="mn-segmented" role="group">
              {GROUPED_QUALITIES[group].map((q) => (
                <button
                  key={q.id}
                  type="button"
                  className={`mn-segment${settings.qualityId === q.id ? ' mn-segment-active' : ''}`}
                  aria-pressed={settings.qualityId === q.id}
                  onClick={() => selectQuality(q)}
                >
                  {q.name}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <InstrumentPicker value={tuning} onChange={(t) => setTuningId(t.id)} />

      <div className="ce-chord-header">
        <div className="ce-symbol-row">
          <h2 className="ce-symbol">{symbol}</h2>
          <div className="ce-tones" role="list" aria-label="Chord tones">
            {tones.map((tone, i) => (
              <span key={i} className={`ce-tone-chip${tone.semitones === 0 ? ' ce-tone-chip-root' : ''}`}>
                <span className="ce-tone-name">{pcToName(tone.pc, prefer)}</span>
                <span className="ce-tone-interval">{tone.label}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="ce-playback">
          <button type="button" className="cf-play-button" disabled={busy} onClick={() => void playChord()}>
            Play chord
          </button>
          <button type="button" className="cf-play-button" disabled={busy} onClick={() => void playArpeggio()}>
            Play arpeggio
          </button>
        </div>
      </div>

      <section className="ce-view">
        <h3 className="ce-view-title">Fretboard — every {symbol} tone, frets 0–12</h3>
        <Fretboard
          tuning={tuning}
          fromFret={0}
          toFret={12}
          markers={fretMarkers}
          prefer={prefer}
          ariaLabel={`${tuning.name} fretboard with every ${symbol} chord tone highlighted`}
        />
      </section>

      <section className="ce-view">
        <h3 className="ce-view-title">
          Keyboard — {symbol} voicing, {(INVERSION_LABELS[settings.inversion] ?? 'root position').toLowerCase()}
        </h3>
        <Keyboard
          from={keyboardFrom}
          to={keyboardTo}
          markers={keyboardMarkers}
          showLabels="c"
          prefer={prefer}
          ariaLabel={`Keyboard showing the ${symbol} voicing`}
        />
      </section>
    </div>
  )
}
