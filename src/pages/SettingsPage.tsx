/**
 * Settings — global, cross-tool preferences in one place:
 *  - Instrument: the default instrument + tuning (reuses `InstrumentPicker`,
 *    which persists through the shared instrument-settings store).
 *  - Display: left-handed fretboard orientation and accidental spelling, both
 *    read directly by the `Fretboard`/`Keyboard` components so every tool
 *    inherits them without page-specific wiring. A live fretboard preview
 *    reflects both choices.
 *  - Audio: master output volume (persisted; the `AudioEngine` seeds from it on
 *    construction) with a test-tone button.
 *
 * The component stays thin: all persistence/normalization lives in
 * `src/lib/globalSettings.ts`, surfaced here through `useGlobalSettings`.
 */

import { useRef } from 'react'
import { Fretboard, type FretboardMarker } from '../components/Fretboard.tsx'
import { InstrumentPicker } from '../components/InstrumentPicker.tsx'
import { useGlobalSettings } from '../hooks/useGlobalSettings.ts'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getAudioEngine } from '../lib/audio/index.ts'
import {
  applySpellingPreference,
  SPELLING_PREFERENCES,
  type SpellingPreference,
} from '../lib/globalSettings.ts'
import { fretMidi } from '../lib/theory/instruments.ts'
import { midiToPc, pcToName, type PitchClass } from '../lib/theory/notes.ts'

const SPELLING_LABELS: Record<SpellingPreference, string> = {
  auto: 'Auto (by key)',
  sharps: 'Sharps ♯',
  flats: 'Flats ♭',
}

/** Fret span used for the display preview. */
const PREVIEW_FROM = 0
const PREVIEW_TO = 5
/** Accidental pitch classes (black keys) — the notes whose spelling changes. */
const ACCIDENTAL_PCS: readonly PitchClass[] = [1, 3, 6, 8, 10]
/** A pleasant A-major triad (A3, C#4, E4) for the master-volume test tone. */
const TEST_TONE_CHORD = [57, 61, 64]

export function SettingsPage() {
  const { settings, update } = useGlobalSettings()
  const { tuning } = useInstrumentSettings()
  const engineRef = useRef(getAudioEngine())

  const volumePercent = Math.round(settings.masterVolume * 100)

  // The preview labels are computed here (explicit marker labels), so the
  // preview reflects the chosen spelling live regardless of the component's own
  // settings snapshot. 'auto' is illustrated with sharps.
  const previewPrefer = applySpellingPreference(settings.spellingPreference, 'sharp')
  const previewMarkers: FretboardMarker[] = []
  for (let s = 0; s < tuning.strings.length; s += 1) {
    for (let fret = PREVIEW_FROM; fret <= PREVIEW_TO; fret += 1) {
      const pc = midiToPc(fretMidi(tuning, s, fret))
      if (ACCIDENTAL_PCS.includes(pc)) {
        previewMarkers.push({ string: s, fret, label: pcToName(pc, previewPrefer) })
      }
    }
  }

  function changeVolume(percent: number): void {
    const volume = Math.min(1, Math.max(0, percent / 100))
    update({ masterVolume: volume })
    engineRef.current.setMasterVolume(volume)
  }

  async function playTestTone(): Promise<void> {
    const engine = engineRef.current
    engine.setMasterVolume(settings.masterVolume)
    await engine.ensureRunning()
    engine.playChord(TEST_TONE_CHORD, 0.9)
  }

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Settings</h1>
        <p className="tool-page-lead">
          Global preferences that apply across every tool: your default instrument and tuning,
          fretboard orientation, how accidentals are spelled, and the master output volume.
        </p>
      </div>

      <div className="tool-controls set-sections">
        <section className="tool-control-group set-section">
          <span className="tool-control-label">Default instrument &amp; tuning</span>
          <InstrumentPicker />
          <p className="set-hint">The starting instrument and tuning for every fretboard tool.</p>
        </section>

        <section className="tool-control-group set-section">
          <span className="tool-control-label">Display</span>

          <label className="set-toggle">
            <input
              type="checkbox"
              checked={settings.leftHanded}
              onChange={(e) => update({ leftHanded: e.target.checked })}
            />
            <span>Left-handed fretboard (nut on the right)</span>
          </label>

          <div className="set-field">
            <span className="set-field-label">Note spelling</span>
            <div className="set-radio-group" role="radiogroup" aria-label="Note spelling">
              {SPELLING_PREFERENCES.map((pref) => (
                <button
                  key={pref}
                  type="button"
                  role="radio"
                  aria-checked={settings.spellingPreference === pref}
                  className={`set-radio${
                    settings.spellingPreference === pref ? ' set-radio-active' : ''
                  }`}
                  onClick={() => update({ spellingPreference: pref })}
                >
                  {SPELLING_LABELS[pref]}
                </button>
              ))}
            </div>
            <p className="set-hint">
              Auto keeps each key’s natural spelling; Sharps or Flats force one everywhere.
            </p>
          </div>

          <Fretboard
            tuning={tuning}
            fromFret={PREVIEW_FROM}
            toFret={PREVIEW_TO}
            markers={previewMarkers}
            leftHanded={settings.leftHanded}
            className="set-preview"
            ariaLabel="Fretboard preview reflecting the current display settings"
          />
        </section>

        <section className="tool-control-group set-section">
          <span className="tool-control-label">Audio</span>
          <div className="set-volume-row">
            <input
              type="range"
              className="set-slider"
              min={0}
              max={100}
              value={volumePercent}
              aria-label="Master volume"
              onChange={(e) => changeVolume(Number(e.target.value))}
            />
            <span className="set-volume-value">{volumePercent}%</span>
          </div>
          <button type="button" className="set-test-tone" onClick={() => void playTestTone()}>
            Play test tone
          </button>
        </section>
      </div>
    </div>
  )
}
