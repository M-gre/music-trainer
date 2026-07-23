/**
 * `CustomTuningEditor` — the Settings-page section for defining and saving
 * arbitrary tunings alongside the built-ins. Lists existing custom tunings
 * (with edit/delete) and hosts a create/edit form: instrument, string count,
 * and a finger-friendly per-string pitch stepper (octave/semitone up/down with
 * the resulting note name shown).
 *
 * Stays thin: all validation and CRUD live in `src/lib/customTunings.ts` via
 * the `useCustomTunings` hook. Deleting the tuning that is currently the global
 * default resets the default to that instrument's standard tuning (the resolver
 * would fall back safely anyway, but this keeps the picker showing a real,
 * selectable tuning).
 */

import { useState } from 'react'
import { useCustomTunings } from '../hooks/useCustomTunings.ts'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import {
  MAX_STRINGS,
  MIDI_RANGE,
  MIN_STRINGS,
  type CustomTuning,
} from '../lib/customTunings.ts'
import { tuningsFor, type FrettedInstrument, type Tuning } from '../lib/theory/instruments.ts'
import { midiToName, type Midi } from '../lib/theory/notes.ts'

const INSTRUMENTS: { value: FrettedInstrument; label: string }[] = [
  { value: 'bass', label: 'Bass' },
  { value: 'guitar', label: 'Guitar' },
]

/** Standard tuning for an instrument (lowest string count built-in). */
function standardTuning(instrument: FrettedInstrument): Tuning {
  const first = tuningsFor(instrument)[0]
  if (!first) throw new Error(`No built-in tuning for ${instrument}`)
  return first
}

function clampToRange(instrument: FrettedInstrument, midi: Midi): Midi {
  const { min, max } = MIDI_RANGE[instrument]
  return Math.min(max, Math.max(min, midi))
}

interface Draft {
  editingId: string | null
  name: string
  instrument: FrettedInstrument
  strings: Midi[]
}

function newDraft(instrument: FrettedInstrument): Draft {
  return { editingId: null, name: '', instrument, strings: [...standardTuning(instrument).strings] }
}

function draftFrom(t: CustomTuning): Draft {
  return { editingId: t.id, name: t.name, instrument: t.instrument, strings: [...t.strings] }
}

export function CustomTuningEditor() {
  const { tunings, add, update, remove } = useCustomTunings()
  const instruments = useInstrumentSettings()

  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  function openNew() {
    setError(null)
    setDraft(newDraft(instruments.tuning.instrument))
  }

  function openEdit(t: CustomTuning) {
    setError(null)
    setDraft(draftFrom(t))
  }

  function closeForm() {
    setError(null)
    setDraft(null)
  }

  function setInstrument(instrument: FrettedInstrument) {
    // Reseed from that instrument's standard so pitches stay in a sane range.
    setDraft((d) => (d ? { ...d, instrument, strings: [...standardTuning(instrument).strings] } : d))
  }

  function setStringCount(count: number) {
    setDraft((d) => {
      if (!d) return d
      const strings = [...d.strings]
      if (count > strings.length) {
        // Extend by stacking perfect fourths above the top string.
        let top = strings[strings.length - 1] ?? standardTuning(d.instrument).strings[0] ?? 40
        while (strings.length < count) {
          top = clampToRange(d.instrument, top + 5)
          strings.push(top)
        }
      } else {
        strings.length = count
      }
      return { ...d, strings }
    })
  }

  function adjustString(index: number, delta: number) {
    setDraft((d) => {
      if (!d) return d
      const strings = d.strings.map((m, i) =>
        i === index ? clampToRange(d.instrument, m + delta) : m,
      )
      return { ...d, strings }
    })
  }

  function save() {
    if (!draft) return
    const input = { name: draft.name, instrument: draft.instrument, strings: draft.strings }
    const result = draft.editingId
      ? update(draft.editingId, input)
      : add(input)
    if (!result.ok) {
      setError(result.error)
      return
    }
    closeForm()
  }

  function handleDelete(t: CustomTuning) {
    // If this custom tuning is the current global default, reset the default to
    // its instrument's standard so the picker keeps showing a real tuning.
    if (instruments.tuning.id === t.id) {
      instruments.setTuningId(standardTuning(t.instrument).id)
    }
    if (draft?.editingId === t.id) closeForm()
    remove(t.id)
  }

  const stringCountOptions: number[] = []
  for (let n = MIN_STRINGS; n <= MAX_STRINGS; n += 1) stringCountOptions.push(n)

  return (
    <section className="tool-control-group set-section">
      <span className="tool-control-label">Custom tunings</span>
      <p className="set-hint">
        Define your own tunings (name + per-string pitch). They appear in every fretboard tool’s
        tuning menu under “Custom”.
      </p>

      {tunings.length > 0 ? (
        <ul className="ct-list">
          {tunings.map((t) => (
            <li key={t.id} className="ct-item">
              <div className="ct-item-info">
                <span className="ct-item-name">{t.name}</span>
                <span className="ct-item-meta">
                  {t.instrument === 'bass' ? 'Bass' : 'Guitar'} · {t.strings.length} strings ·{' '}
                  {t.strings.map((m) => midiToName(m)).join(' ')}
                </span>
              </div>
              <div className="ct-item-actions">
                <button type="button" className="ct-btn" onClick={() => openEdit(t)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="ct-btn ct-btn-danger"
                  onClick={() => handleDelete(t)}
                  aria-label={`Delete tuning ${t.name}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="set-hint">No custom tunings yet.</p>
      )}

      {draft ? (
        <div className="ct-form">
          <label className="ct-field">
            <span className="ct-field-label">Name</span>
            <input
              type="text"
              className="ct-text"
              value={draft.name}
              maxLength={40}
              placeholder="e.g. Drop A♭"
              onChange={(e) => setDraft((d) => (d ? { ...d, name: e.target.value } : d))}
            />
          </label>

          <div className="ct-field-row">
            <label className="ct-field">
              <span className="ct-field-label">Instrument</span>
              <select
                className="ip-select"
                value={draft.instrument}
                onChange={(e) => setInstrument(e.target.value as FrettedInstrument)}
              >
                {INSTRUMENTS.map((i) => (
                  <option key={i.value} value={i.value}>
                    {i.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="ct-field">
              <span className="ct-field-label">Strings</span>
              <select
                className="ip-select"
                value={draft.strings.length}
                onChange={(e) => setStringCount(Number(e.target.value))}
              >
                {stringCountOptions.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="ct-field">
            <span className="ct-field-label">Pitches (low → high)</span>
            <ol className="ct-strings">
              {draft.strings.map((midi, i) => (
                <li key={i} className="ct-string-row">
                  <span className="ct-string-index">{i + 1}</span>
                  <div className="ct-stepper">
                    <button
                      type="button"
                      className="ct-step"
                      onClick={() => adjustString(i, -12)}
                      aria-label={`String ${i + 1} down an octave`}
                    >
                      −oct
                    </button>
                    <button
                      type="button"
                      className="ct-step"
                      onClick={() => adjustString(i, -1)}
                      aria-label={`String ${i + 1} down a semitone`}
                    >
                      −
                    </button>
                    <span className="ct-note" aria-label={`String ${i + 1} pitch`}>
                      {midiToName(midi)}
                    </span>
                    <button
                      type="button"
                      className="ct-step"
                      onClick={() => adjustString(i, 1)}
                      aria-label={`String ${i + 1} up a semitone`}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="ct-step"
                      onClick={() => adjustString(i, 12)}
                      aria-label={`String ${i + 1} up an octave`}
                    >
                      +oct
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          {error ? (
            <p className="ct-error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="ct-form-actions">
            <button type="button" className="ct-btn ct-btn-primary" onClick={save}>
              {draft.editingId ? 'Save changes' : 'Add tuning'}
            </button>
            <button type="button" className="ct-btn" onClick={closeForm}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ct-btn ct-btn-primary ct-add" onClick={openNew}>
          + New custom tuning
        </button>
      )}
    </section>
  )
}
