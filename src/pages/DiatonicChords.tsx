/**
 * Diatonic Chords — pick a key (root + scale) and see all seven chords that
 * live in it: roman numerals, chord symbols, and spelled chord tones. Tap a
 * card to hear it and select it; the selected chord's tones show on a small
 * Fretboard (frets 0–12, global tuning) and Keyboard. A "Play progression"
 * row quick-plays a few common progressions (I–IV–V–I, I–V–vi–IV, ii–V–I) in
 * the selected key.
 *
 * All chord math (roman numerals, key-spelled symbols/tones, voicing
 * selection, progression scheduling) lives in `src/lib/diatonicChords.ts`,
 * fully unit-tested; fretboard/keyboard markers and the concrete keyboard
 * voicing reuse `src/lib/chordExplorer.ts`, matching the Chord Explorer tool.
 * This component stays thin: React state, persistence, and the click-time
 * audio (`ensureRunning` only ever runs inside click handlers, matching the
 * Metronome/Circle of Fifths/Chord Explorer pattern).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Fretboard } from '../components/Fretboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { Keyboard } from '../components/Keyboard.tsx'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import { buildChordFretboardMarkers, buildChordKeyboardMarkers } from '../lib/chordExplorer.ts'
import {
  buildDiatonicChordCards,
  cardVoicing,
  COMMON_PROGRESSIONS,
  DIATONIC_SCALE_OPTIONS,
  diatonicChordsSettingsStore,
  keyPrefersFlats,
  normalizeDiatonicChordsSettings,
  scheduleProgression,
  type DiatonicChordsSettings,
  type DiatonicScaleId,
} from '../lib/diatonicChords.ts'
import { pcToName, type PitchClass } from '../lib/theory/notes.ts'

const ROOTS: PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

const CHORD_DURATION = 1.3

export function DiatonicChords() {
  const { tuning, setTuningId } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())

  const [settings, setSettings] = useState<DiatonicChordsSettings>(() =>
    normalizeDiatonicChordsSettings(diatonicChordsSettingsStore.get()),
  )
  const [selectedDegree, setSelectedDegree] = useState(1)
  const [busy, setBusy] = useState(false)

  // Bass-primary key/theory tool (chord tones shown on the fretboard for bass
  // lines): chord + progression playback uses the fretted (pluck) voice.
  // Asserted on mount since the engine's voice context is app-global.
  useEffect(() => {
    engineRef.current.setVoiceContext('fretted')
  }, [])

  const { rootPc, scaleId } = settings

  const updateSettings = useCallback((next: DiatonicChordsSettings) => {
    const normalized = normalizeDiatonicChordsSettings(next)
    setSettings(normalized)
    diatonicChordsSettingsStore.set(normalized)
  }, [])

  const selectRoot = useCallback(
    (pc: PitchClass) => updateSettings({ ...settings, rootPc: pc }),
    [settings, updateSettings],
  )

  const selectScale = useCallback(
    (id: DiatonicScaleId) => updateSettings({ ...settings, scaleId: id }),
    [settings, updateSettings],
  )

  const prefer = keyPrefersFlats(rootPc, scaleId) ? 'flat' : 'sharp'
  const cards = useMemo(() => buildDiatonicChordCards(rootPc, scaleId), [rootPc, scaleId])
  const selected = cards[selectedDegree - 1] ?? cards[0]!

  const fretMarkers = useMemo(
    () => buildChordFretboardMarkers(tuning, selected.root, selected.quality, 0, 12, 'note', prefer),
    [tuning, selected, prefer],
  )

  const keyboardMarkers = useMemo(
    () => buildChordKeyboardMarkers(selected.root, selected.quality, 0, 'note', prefer),
    [selected, prefer],
  )

  const selectedVoicing = useMemo(() => cardVoicing(selected), [selected])
  // Keyboard range: snug around the selected voicing (padded a few
  // semitones), spanning roughly 1-2 octaves like Chord Explorer.
  const keyboardFrom = Math.min(...selectedVoicing) - 3
  const keyboardTo = Math.max(...selectedVoicing) + 3

  const playCard = useCallback(
    async (degree: number) => {
      const card = cards[degree - 1]
      if (!card) return
      setSelectedDegree(degree)
      const engine = engineRef.current
      await engine.ensureRunning()
      setBusy(true)
      engine.playChord(cardVoicing(card), CHORD_DURATION, { when: engine.currentTime })
      window.setTimeout(() => setBusy(false), CHORD_DURATION * 1000)
    },
    [cards],
  )

  const playProgression = useCallback(
    async (degrees: number[]) => {
      const engine = engineRef.current
      await engine.ensureRunning()
      setBusy(true)
      const steps = scheduleProgression(cards, degrees, { startTime: engine.currentTime })
      for (const step of steps) {
        // Slight gap before the next chord so consecutive chords don't blur together.
        engine.playChord(step.midis, step.duration * 0.92, { when: step.when })
      }
      const last = steps[steps.length - 1]
      const totalMs = last ? (last.when - engine.currentTime + last.duration) * 1000 : 0
      window.setTimeout(() => setBusy(false), totalMs)
    },
    [cards],
  )

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Diatonic Chords</h1>
        <p className="tool-page-lead">
          Every chord that lives in a key, with roman numerals. Pick a root and a scale, tap a chord
          to hear it, and quick-play common progressions in that key.
        </p>
      </div>

      <div className="tool-controls">
        <div className="tool-control-group">
          <span className="tool-control-label">Root</span>
          <div className="mn-segmented" role="group" aria-label="Root note">
            {ROOTS.map((pc) => (
              <button
                key={pc}
                type="button"
                className={`mn-segment${rootPc === pc ? ' mn-segment-active' : ''}`}
                aria-pressed={rootPc === pc}
                onClick={() => selectRoot(pc)}
              >
                {pcToName(pc, prefer)}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-control-group">
          <span className="tool-control-label">Scale</span>
          <div className="mn-segmented" role="group" aria-label="Scale">
            {DIATONIC_SCALE_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`mn-segment${scaleId === opt.id ? ' mn-segment-active' : ''}`}
                aria-pressed={scaleId === opt.id}
                onClick={() => selectScale(opt.id)}
              >
                {opt.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <InstrumentPicker value={tuning} onChange={(t) => setTuningId(t.id)} />

      <section className="dc-section">
        <span className="tool-control-label">Diatonic chords</span>
        <div className="dc-grid" role="list" aria-label="Diatonic chords of the selected key">
          {cards.map((card) => (
            <button
              key={card.degree}
              type="button"
              role="listitem"
              className={`dc-card${selectedDegree === card.degree ? ' dc-card-selected' : ''}`}
              aria-pressed={selectedDegree === card.degree}
              disabled={busy}
              onClick={() => void playCard(card.degree)}
            >
              <span className="dc-card-numeral">{card.numeral}</span>
              <span className="dc-card-symbol">{card.symbol}</span>
              <span className="dc-card-tones">{card.toneNames.join(' – ')}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="dc-section">
        <div className="dc-section-row">
          <span className="tool-control-label">Play progression</span>
        </div>
        <div className="dc-progressions">
          {COMMON_PROGRESSIONS.map((progression) => (
            <button
              key={progression.id}
              type="button"
              className="dc-progression-button"
              disabled={busy}
              onClick={() => void playProgression(progression.degrees)}
            >
              {progression.label}
            </button>
          ))}
        </div>
      </section>

      <section className="ce-view">
        <h3 className="ce-view-title">
          Fretboard — {selected.symbol} tones, frets 0–12
        </h3>
        <Fretboard
          tuning={tuning}
          fromFret={0}
          toFret={12}
          markers={fretMarkers}
          prefer={prefer}
          ariaLabel={`${tuning.name} fretboard with ${selected.symbol} chord tones highlighted`}
        />
      </section>

      <section className="ce-view">
        <h3 className="ce-view-title">Keyboard — {selected.symbol} ({selected.numeral})</h3>
        <Keyboard
          from={keyboardFrom}
          to={keyboardTo}
          markers={keyboardMarkers}
          showLabels="c"
          prefer={prefer}
          ariaLabel={`Keyboard showing the ${selected.symbol} chord`}
        />
      </section>
    </div>
  )
}
