/**
 * Scales & Modes explorer — pick a root and a scale/mode and see it laid out on
 * both the fretboard (using the global instrument/tuning) and a two-octave
 * keyboard, with markers labelled as note names or scale degrees. An info line
 * shows the spelled scale and its step pattern, and the scale can be played
 * ascending or descending.
 *
 * All musical logic lives in `../lib/scaleExplorer.ts` (pure, unit-tested);
 * this component stays thin — it owns React state, persistence, and the
 * click-triggered playback. The AudioContext is only created/resumed inside
 * handlers (`ensureRunning`), matching the other tool pages, so the page never
 * triggers the browser's autoplay block.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { Fretboard } from '../components/Fretboard.tsx'
import { Keyboard } from '../components/Keyboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { getScale, MODE_IDS, SCALES } from '../lib/theory/scales.ts'
import { pcToName } from '../lib/theory/notes.ts'
import { prefersFlats } from '../lib/theory/spell.ts'
import {
  buildFretboardMarkers,
  buildKeyboardMarkers,
  buildScaleSequence,
  playbackRootMidi,
  scaleDegreeLabels,
  scaleNoteNames,
  scaleStepPattern,
  type AccidentalPreference,
  type ScaleDirection,
  type ScaleDisplayMode,
} from '../lib/scaleExplorer.ts'
import {
  normalizeScaleExplorerSettings,
  scaleExplorerSettingsStore,
} from '../lib/scaleExplorerSettings.ts'

// ~120 BPM eighth notes: quarter = 0.5s, eighth = 0.25s per step.
const NOTE_GAP = 0.25
const NOTE_DURATION = 0.22

const PITCH_CLASSES = Array.from({ length: 12 }, (_, i) => i)

// Scales split so the seven modes group visually apart from the rest.
const MODE_SCALES = SCALES.filter((s) => (MODE_IDS as readonly string[]).includes(s.id))
const OTHER_SCALES = SCALES.filter((s) => !(MODE_IDS as readonly string[]).includes(s.id))

function rootLabel(pc: number): string {
  return pcToName(pc, prefersFlats(pc) ? 'flat' : 'sharp')
}

export function ScalesExplorer() {
  const engineRef = useRef(getAudioEngine())
  const { tuning, setTuningId } = useInstrumentSettings()

  const [settings, setSettings] = useState(() =>
    normalizeScaleExplorerSettings(scaleExplorerSettingsStore.get()),
  )
  const [busy, setBusy] = useState(false)

  const update = useCallback((patch: Partial<typeof settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      scaleExplorerSettingsStore.set(next)
      return next
    })
  }, [])

  const { rootPc, scaleId, display, fullRange } = settings
  const scale = useMemo(() => getScale(scaleId), [scaleId])
  const prefer: AccidentalPreference = prefersFlats(rootPc) ? 'flat' : 'sharp'
  const toFret = fullRange ? 24 : 12

  const noteNames = useMemo(() => scaleNoteNames(rootPc, scale), [rootPc, scale])
  const degrees = useMemo(() => scaleDegreeLabels(scale.intervals), [scale])
  const stepPattern = useMemo(() => scaleStepPattern(scale.intervals), [scale])

  const fretMarkers = useMemo(
    () => buildFretboardMarkers(tuning, 0, toFret, rootPc, scale.intervals, { display, prefer }),
    [tuning, toFret, rootPc, scale, display, prefer],
  )

  // Two octaves of keys, anchored so the root sits at the left of the keybed.
  const keyboardRoot = playbackRootMidi(rootPc)
  const keyMarkers = useMemo(
    () => buildKeyboardMarkers(keyboardRoot, scale.intervals, { display, prefer, octaves: 2 }),
    [keyboardRoot, scale, display, prefer],
  )

  const play = useCallback(
    async (direction: ScaleDirection) => {
      const engine = engineRef.current
      await engine.ensureRunning()
      setBusy(true)
      const sequence = buildScaleSequence(playbackRootMidi(rootPc), scale.intervals, direction)
      const now = engine.currentTime
      sequence.forEach((midi, i) => {
        engine.playNote(midi, NOTE_DURATION, { when: now + i * NOTE_GAP })
      })
      window.setTimeout(() => setBusy(false), sequence.length * NOTE_GAP * 1000)
    },
    [rootPc, scale],
  )

  const scaleName = scale.name
  const rootName = rootLabel(rootPc)

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Scales &amp; Modes</h1>
        <p className="tool-page-lead">
          Pick a root and a scale to see it on the fretboard and keyboard at once, labelled with
          note names or scale degrees. Audio starts only when you press a play button.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group se-root-group">
          <span className="tool-control-label">Root</span>
          <div className="se-roots" role="group" aria-label="Root note">
            {PITCH_CLASSES.map((pc) => (
              <button
                key={pc}
                type="button"
                className={`se-root${pc === rootPc ? ' se-root-active' : ''}`}
                aria-pressed={pc === rootPc}
                onClick={() => update({ rootPc: pc })}
              >
                {rootLabel(pc)}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Scale / mode</span>
          <select
            className="se-select"
            value={scaleId}
            aria-label="Scale or mode"
            onChange={(e) => update({ scaleId: e.target.value })}
          >
            <optgroup label="Modes of the major scale">
              {MODE_SCALES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Other scales">
              {OTHER_SCALES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          </select>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Labels</span>
          <div className="se-segmented" role="group" aria-label="Marker labels">
            {(['degrees', 'names'] as ScaleDisplayMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`se-segment${display === mode ? ' se-segment-active' : ''}`}
                aria-pressed={display === mode}
                onClick={() => update({ display: mode })}
              >
                {mode === 'degrees' ? 'Degrees' : 'Note names'}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="se-info">
        <div className="se-info-row">
          <span className="tool-control-label">
            {rootName} {scaleName}
          </span>
          <div className="se-chips">
            {noteNames.map((name, i) => (
              <span key={i} className={`se-chip${i === 0 ? ' se-chip-root' : ''}`}>
                <span className="se-chip-note">{name}</span>
                <span className="se-chip-degree">{degrees[i]}</span>
              </span>
            ))}
          </div>
        </div>
        <p className="se-pattern">
          <span className="se-pattern-label">Steps</span> {stepPattern.join(' – ')}
        </p>
      </div>

      <div className="se-transport">
        <button
          type="button"
          className="se-play"
          disabled={busy}
          onClick={() => void play('up')}
        >
          ▲ Play ascending
        </button>
        <button
          type="button"
          className="se-play"
          disabled={busy}
          onClick={() => void play('down')}
        >
          ▼ Play descending
        </button>
      </div>

      <InstrumentPicker value={tuning} onChange={(t) => setTuningId(t.id)} />

      <div className="se-views">
        <section className="se-view">
          <div className="se-view-head">
            <h2 className="se-view-title">Fretboard</h2>
            <button
              type="button"
              className={`se-segment se-range-toggle${fullRange ? ' se-segment-active' : ''}`}
              aria-pressed={fullRange}
              onClick={() => update({ fullRange: !fullRange })}
            >
              {fullRange ? 'Frets 0–24' : 'Frets 0–12'}
            </button>
          </div>
          <Fretboard
            tuning={tuning}
            fromFret={0}
            toFret={toFret}
            markers={fretMarkers}
            prefer={prefer}
            ariaLabel={`${rootName} ${scaleName} on ${tuning.name}`}
          />
        </section>

        <section className="se-view">
          <h2 className="se-view-title">Keyboard</h2>
          <Keyboard
            from={keyboardRoot}
            to={keyboardRoot + 24}
            markers={keyMarkers}
            prefer={prefer}
            showLabels="c"
            ariaLabel={`${rootName} ${scaleName} on the keyboard`}
          />
        </section>
      </div>
    </div>
  )
}
