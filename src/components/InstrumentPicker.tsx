/**
 * `InstrumentPicker` — a compact instrument -> string count -> tuning
 * control bar, meant to be dropped into any fretboard tool.
 *
 * By default it reads and writes the global default instrument via
 * `useInstrumentSettings`, so a new tool needs zero wiring to get a
 * consistent, persisted instrument choice. Pass `value`/`onChange` to run it
 * as a controlled component instead (e.g. a tool that needs its own,
 * independent instrument selection).
 */

import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { getTuning, tuningsFor, type FrettedInstrument, type Tuning } from '../lib/theory/instruments.ts'

export interface InstrumentPickerProps {
  /** Selected tuning. Defaults to the global instrument settings hook. */
  value?: Tuning
  /** Called with the new tuning on any change. Defaults to persisting via the global settings hook. */
  onChange?: (tuning: Tuning) => void
  /** Extra class on the root element. */
  className?: string
}

const INSTRUMENTS: { value: FrettedInstrument; label: string }[] = [
  { value: 'bass', label: 'Bass' },
  { value: 'guitar', label: 'Guitar' },
]

export function InstrumentPicker({ value, onChange, className }: InstrumentPickerProps) {
  const settings = useInstrumentSettings()
  const tuning = value ?? settings.tuning
  const setTuning = onChange ?? ((t: Tuning) => settings.setTuningId(t.id))

  const instrumentTunings = tuningsFor(tuning.instrument)
  const stringCounts = Array.from(new Set(instrumentTunings.map((t) => t.strings.length)))
  const matchingTunings = instrumentTunings.filter((t) => t.strings.length === tuning.strings.length)

  function handleInstrumentChange(instrument: FrettedInstrument) {
    const first = tuningsFor(instrument)[0]
    if (first) setTuning(first)
  }

  function handleStringCountChange(count: number) {
    const first = tuningsFor(tuning.instrument).find((t) => t.strings.length === count)
    if (first) setTuning(first)
  }

  function handleTuningChange(tuningId: string) {
    setTuning(getTuning(tuningId))
  }

  return (
    <div className={`ip-picker${className ? ` ${className}` : ''}`}>
      <label className="ip-field">
        <span className="ip-label">Instrument</span>
        <select
          className="ip-select"
          value={tuning.instrument}
          onChange={(e) => handleInstrumentChange(e.target.value as FrettedInstrument)}
        >
          {INSTRUMENTS.map((i) => (
            <option key={i.value} value={i.value}>
              {i.label}
            </option>
          ))}
        </select>
      </label>

      <label className="ip-field">
        <span className="ip-label">Strings</span>
        <select
          className="ip-select"
          value={tuning.strings.length}
          onChange={(e) => handleStringCountChange(Number(e.target.value))}
        >
          {stringCounts.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </label>

      <label className="ip-field">
        <span className="ip-label">Tuning</span>
        <select className="ip-select" value={tuning.id} onChange={(e) => handleTuningChange(e.target.value)}>
          {matchingTunings.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
