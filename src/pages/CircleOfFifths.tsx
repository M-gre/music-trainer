/**
 * Circle of Fifths — an interactive SVG diagram of the 12 major keys (outer
 * ring) and their relative minors (inner ring), with key signatures shown per
 * segment. Clicking a key selects it and reveals a detail panel: the
 * correctly-spelled major scale, its key signature, the relative minor, and
 * the seven diatonic triads (with roman numerals), each playable.
 *
 * All angle/path math lives in `../components/circleGeometry.ts` (pure,
 * tested). This component stays thin: it owns the selection state, the
 * persisted last-selected key, and the click-triggered audio playback. The
 * AudioContext is only created/resumed inside click handlers (`ensureRunning`),
 * matching the Metronome page's pattern, so the page never triggers the
 * browser's autoplay block.
 *
 * The detail panel also hosts instrument views (fretboard + keyboard) for the
 * selected key's scale, reusing the Scales explorer's marker-building
 * (`../lib/scaleExplorer.ts`) rather than re-deriving it. A toggle switches
 * the highlighted scale between the key's major scale and its relative
 * natural minor (root marker moves to the relative minor's tonic). Each view
 * is a native `<details>` accordion so it stays collapsible/tappable on a
 * phone without blowing up page height; they default open on wide viewports
 * and collapsed on narrow ones.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  CIRCLE_KEYS,
  ringSegmentPath,
  segmentEndAngle,
  keySpellingPrefer,
  segmentLabelPosition,
  segmentStartAngle,
  signatureLabel,
  signatureNotes,
  type CircleKey,
} from '../components/circleGeometry.ts'
import { Fretboard } from '../components/Fretboard.tsx'
import { Keyboard } from '../components/Keyboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import {
  circleOfFifthsSettingsStore,
  normalizeCircleOfFifthsSettings,
  type CircleOfFifthsSettings,
} from '../lib/circleOfFifthsSettings.ts'
import {
  buildFretboardMarkers,
  buildKeyboardMarkers,
  playbackRootMidi,
} from '../lib/scaleExplorer.ts'
import { diatonicTriads } from '../lib/theory/chords.ts'
import { getScale, prefersFlats, spellScale } from '../lib/theory/index.ts'
import { pcToName } from '../lib/theory/notes.ts'

const MAJOR_INTERVALS = getScale('major').intervals
const MINOR_INTERVALS = getScale('minor').intervals

/** Narrow viewports default the instrument-view accordions to collapsed. */
const NARROW_VIEWPORT_QUERY = '(max-width: 640px)'

function defaultInstrumentViewOpen(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return !window.matchMedia(NARROW_VIEWPORT_QUERY).matches
}

// SVG layout (viewBox units; scales down responsively via width: 100%).
const SIZE = 320
const CENTER = SIZE / 2
const OUTER_R = 150
const MAJOR_INNER_R = 96
const MINOR_INNER_R = 48
const MAJOR_LABEL_R = 124
const MAJOR_SIGNATURE_R = 108
const MINOR_LABEL_R = 74

// Audio timing for scale/chord playback.
const SCALE_NOTE_DURATION = 0.45
const SCALE_NOTE_GAP = 0.42
const CHORD_DURATION = 1.1
const PLAYBACK_BASE_MIDI = 60 // C4 — anchor octave for scale/chord playback.

function majorLabelOf(key: CircleKey): string {
  return key.alt ? `${key.majorName}/${key.alt.majorName}` : key.majorName
}

function minorLabelOf(key: CircleKey): string {
  const primary = key.minorName.toLowerCase()
  return key.alt ? `${primary}/${key.alt.minorName.toLowerCase()}` : primary
}

function signatureTextOf(key: CircleKey): string {
  const primary = signatureLabel(key.signature)
  return key.alt ? `${primary}/${signatureLabel(key.alt.signature)}` : primary
}

export function CircleOfFifths() {
  const engineRef = useRef(getAudioEngine())
  const { tuning, setTuningId } = useInstrumentSettings()
  const [settings, setSettings] = useState<CircleOfFifthsSettings>(() =>
    normalizeCircleOfFifthsSettings(circleOfFifthsSettingsStore.get()),
  )
  const [busy, setBusy] = useState(false)
  const [fretboardOpen, setFretboardOpen] = useState(defaultInstrumentViewOpen)
  const [keyboardOpen, setKeyboardOpen] = useState(defaultInstrumentViewOpen)

  const { selectedIndex, scaleView } = settings

  const selectKey = useCallback((index: number) => {
    setSettings((prev) => {
      const next: CircleOfFifthsSettings = { ...prev, selectedIndex: index }
      circleOfFifthsSettingsStore.set(next)
      return next
    })
  }, [])

  const setScaleView = useCallback((view: CircleOfFifthsSettings['scaleView']) => {
    setSettings((prev) => {
      const next: CircleOfFifthsSettings = { ...prev, scaleView: view }
      circleOfFifthsSettingsStore.set(next)
      return next
    })
  }, [])

  const selected = CIRCLE_KEYS[selectedIndex] ?? CIRCLE_KEYS[0]!

  const scaleNames = useMemo(
    () => spellScale(selected.majorPc, MAJOR_INTERVALS, selected.rootLetter),
    [selected],
  )
  const triads = useMemo(() => diatonicTriads(selected.majorPc), [selected])
  const flats = prefersFlats(selected.majorPc)

  const scaleMidis = useMemo(
    () => MAJOR_INTERVALS.map((i) => PLAYBACK_BASE_MIDI + selected.majorPc + i),
    [selected],
  )

  // Instrument views: highlight either the key's major scale or its relative
  // natural minor, reusing the Scales explorer's marker builders so the
  // fretboard/keyboard shapes stay in sync with that tool.
  const activeRootPc = scaleView === 'major' ? selected.majorPc : selected.minorPc
  const activeIntervals = scaleView === 'major' ? MAJOR_INTERVALS : MINOR_INTERVALS
  const activeRootName = scaleView === 'major' ? selected.majorName : selected.minorName
  const activePrefer = keySpellingPrefer(selected)

  const fretMarkers = useMemo(
    () => buildFretboardMarkers(tuning, 0, 12, activeRootPc, activeIntervals, { display: 'names', prefer: activePrefer }),
    [tuning, activeRootPc, activeIntervals, activePrefer],
  )

  const keyboardRoot = playbackRootMidi(activeRootPc)
  const keyMarkers = useMemo(
    () =>
      buildKeyboardMarkers(keyboardRoot, activeIntervals, {
        display: 'names',
        prefer: activePrefer,
        octaves: 2,
      }),
    [keyboardRoot, activeIntervals, activePrefer],
  )

  const playScale = useCallback(async () => {
    const engine = engineRef.current
    await engine.ensureRunning()
    setBusy(true)
    const now = engine.currentTime
    const notes = [...scaleMidis, PLAYBACK_BASE_MIDI + selected.majorPc + 12]
    notes.forEach((midi, i) => {
      engine.playNote(midi, SCALE_NOTE_DURATION, { when: now + i * SCALE_NOTE_GAP })
    })
    window.setTimeout(() => setBusy(false), notes.length * SCALE_NOTE_GAP * 1000)
  }, [scaleMidis, selected])

  const playTriad = useCallback(async (rootPc: number, intervals: number[]) => {
    const engine = engineRef.current
    await engine.ensureRunning()
    setBusy(true)
    const midis = intervals.map((i) => PLAYBACK_BASE_MIDI + rootPc + i)
    engine.playChord(midis, CHORD_DURATION, { when: engine.currentTime })
    window.setTimeout(() => setBusy(false), CHORD_DURATION * 1000)
  }, [])

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Circle of Fifths</h1>
        <p className="tool-page-lead">
          Click a major key (outer ring) or its relative minor (inner ring) to see the key
          signature, spelled scale, and diatonic chords.
        </p>
      </div>

      <div className="cf-circle-wrap">
        <svg
          className="cf-svg"
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          width="100%"
          role="img"
          aria-label="Circle of fifths, 12 major keys and their relative minors"
        >
          <circle className="cf-hub" cx={CENTER} cy={CENTER} r={MINOR_INNER_R - 6} />
          {CIRCLE_KEYS.map((key) => {
            const start = segmentStartAngle(key.index)
            const end = segmentEndAngle(key.index)
            const isSelected = key.index === selectedIndex
            const majorLabelPos = segmentLabelPosition(CENTER, CENTER, MAJOR_LABEL_R, key.index)
            const signaturePos = segmentLabelPosition(CENTER, CENTER, MAJOR_SIGNATURE_R, key.index)
            const minorLabelPos = segmentLabelPosition(CENTER, CENTER, MINOR_LABEL_R, key.index)
            return (
              <g key={key.index}>
                <path
                  className={`cf-segment cf-segment-major${isSelected ? ' cf-segment-selected' : ''}`}
                  d={ringSegmentPath(CENTER, CENTER, MAJOR_INNER_R, OUTER_R, start, end)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${majorLabelOf(key)} major, ${signatureTextOf(key)}`}
                  aria-pressed={isSelected}
                  onClick={() => selectKey(key.index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') selectKey(key.index)
                  }}
                />
                <path
                  className={`cf-segment cf-segment-minor${isSelected ? ' cf-segment-selected' : ''}`}
                  d={ringSegmentPath(CENTER, CENTER, MINOR_INNER_R, MAJOR_INNER_R, start, end)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${minorLabelOf(key)} minor, relative to ${majorLabelOf(key)} major`}
                  aria-pressed={isSelected}
                  onClick={() => selectKey(key.index)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') selectKey(key.index)
                  }}
                />
                <text
                  className="cf-label cf-label-major"
                  x={majorLabelPos.x}
                  y={majorLabelPos.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {majorLabelOf(key)}
                </text>
                <text
                  className="cf-label cf-signature"
                  x={signaturePos.x}
                  y={signaturePos.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {signatureTextOf(key)}
                </text>
                <text
                  className="cf-label cf-label-minor"
                  x={minorLabelPos.x}
                  y={minorLabelPos.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                >
                  {minorLabelOf(key)}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <div className="cf-detail">
        <div className="cf-detail-header">
          <h2>
            {majorLabelOf(selected)} major
            <span className="cf-detail-relative"> · relative minor {minorLabelOf(selected)}</span>
          </h2>
          <span className="cf-detail-signature">{signatureTextOf(selected)}</span>
        </div>

        <div className="cf-detail-section">
          <span className="tool-control-label">Key signature</span>
          <p className="cf-detail-text">
            {selected.signature === 0 ? (
              'No sharps or flats.'
            ) : (
              <>
                {signatureNotes(selected.signature).join(', ')}
                {selected.alt && (
                  <>
                    {' '}
                    (enharmonic as {selected.alt.majorName}: {signatureNotes(selected.alt.signature).join(', ')})
                  </>
                )}
              </>
            )}
          </p>
        </div>

        <div className="cf-detail-section">
          <div className="cf-detail-row">
            <span className="tool-control-label">Major scale</span>
            <button type="button" className="cf-play-button" disabled={busy} onClick={() => void playScale()}>
              Play scale
            </button>
          </div>
          <div className="cf-scale-chips">
            {scaleNames.map((name, i) => (
              <span key={i} className={`cf-note-chip${i === 0 ? ' cf-note-chip-root' : ''}`}>
                {name}
              </span>
            ))}
          </div>
        </div>

        <div className="cf-detail-section">
          <div className="cf-detail-row">
            <span className="tool-control-label">Instrument views</span>
            <div className="se-segmented" role="group" aria-label="Scale shown on the fretboard and keyboard">
              <button
                type="button"
                className={`se-segment${scaleView === 'major' ? ' se-segment-active' : ''}`}
                aria-pressed={scaleView === 'major'}
                onClick={() => setScaleView('major')}
              >
                Major scale
              </button>
              <button
                type="button"
                className={`se-segment${scaleView === 'minor' ? ' se-segment-active' : ''}`}
                aria-pressed={scaleView === 'minor'}
                onClick={() => setScaleView('minor')}
              >
                Relative minor
              </button>
            </div>
          </div>

          <details
            className="se-view cf-instrument-view"
            open={fretboardOpen}
            onToggle={(e) => setFretboardOpen(e.currentTarget.open)}
          >
            <summary className="cf-instrument-summary">Fretboard</summary>
            <div className="cf-instrument-body">
              <InstrumentPicker value={tuning} onChange={(t) => setTuningId(t.id)} />
              <Fretboard
                tuning={tuning}
                fromFret={0}
                toFret={12}
                markers={fretMarkers}
                prefer={activePrefer}
                ariaLabel={`${activeRootName} ${scaleView} scale on ${tuning.name}`}
              />
            </div>
          </details>

          <details
            className="se-view cf-instrument-view"
            open={keyboardOpen}
            onToggle={(e) => setKeyboardOpen(e.currentTarget.open)}
          >
            <summary className="cf-instrument-summary">Keyboard</summary>
            <div className="cf-instrument-body">
              <Keyboard
                from={keyboardRoot}
                to={keyboardRoot + 24}
                markers={keyMarkers}
                prefer={activePrefer}
                showLabels="c"
                ariaLabel={`${activeRootName} ${scaleView} scale on the keyboard`}
              />
            </div>
          </details>
        </div>

        <div className="cf-detail-section">
          <span className="tool-control-label">Diatonic triads</span>
          <div className="cf-triads">
            {triads.map((triad) => {
              const name = pcToName(triad.root, flats ? 'flat' : 'sharp') + triad.quality.symbol
              return (
                <div key={triad.degree} className="cf-triad-card">
                  <span className="cf-triad-numeral">{triad.numeral}</span>
                  <span className="cf-triad-name">{name}</span>
                  <button
                    type="button"
                    className="cf-play-button cf-play-button-small"
                    disabled={busy}
                    onClick={() => void playTriad(triad.root, triad.quality.intervals)}
                  >
                    Play
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
