/**
 * `InstrumentPicker` — a compact instrument -> string count -> tuning
 * control bar, meant to be dropped into any fretboard tool.
 *
 * By default it reads and writes the global default instrument via
 * `useInstrumentSettings`, so a new tool needs zero wiring to get a
 * consistent, persisted instrument choice. Pass `value`/`onChange` to run it
 * as a controlled component instead (e.g. a tool that needs its own,
 * independent instrument selection).
 *
 * User-defined custom tunings (`useCustomTunings`) appear in the tuning
 * dropdown under a "Custom" group for their instrument and string count, and
 * selecting one works exactly like a built-in — every consumer receives a
 * resolved `Tuning` object.
 */

import { useCustomTunings } from '../hooks/useCustomTunings.ts'
import { useInstrumentSettings } from '../hooks/useInstrumentSettings.ts'
import { customTuningsFor, resolveTuning, toTuning } from '../lib/customTunings.ts'
import { tuningsFor, type FrettedInstrument, type Tuning } from '../lib/theory/instruments.ts'

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
  const { tunings: customs } = useCustomTunings()
  const tuning = value ?? settings.tuning
  const setTuning = onChange ?? ((t: Tuning) => settings.setTuningId(t.id))

  const builtInTunings = tuningsFor(tuning.instrument)
  const instrumentCustoms = customTuningsFor(customs, tuning.instrument)

  // String counts offered by either the built-ins or the user's customs.
  const stringCounts = Array.from(
    new Set([
      ...builtInTunings.map((t) => t.strings.length),
      ...instrumentCustoms.map((t) => t.strings.length),
    ]),
  ).sort((a, b) => a - b)

  const matchingBuiltIns = builtInTunings.filter((t) => t.strings.length === tuning.strings.length)
  const matchingCustoms = instrumentCustoms.filter(
    (t) => t.strings.length === tuning.strings.length,
  )

  function firstTuningForCount(instrument: FrettedInstrument, count: number): Tuning | undefined {
    const builtIn = tuningsFor(instrument).find((t) => t.strings.length === count)
    if (builtIn) return builtIn
    const custom = customTuningsFor(customs, instrument).find((t) => t.strings.length === count)
    return custom ? toTuning(custom) : undefined
  }

  function handleInstrumentChange(instrument: FrettedInstrument) {
    const builtIn = tuningsFor(instrument)[0]
    if (builtIn) {
      setTuning(builtIn)
      return
    }
    const custom = customTuningsFor(customs, instrument)[0]
    if (custom) setTuning(toTuning(custom))
  }

  function handleStringCountChange(count: number) {
    const first = firstTuningForCount(tuning.instrument, count)
    if (first) setTuning(first)
  }

  function handleTuningChange(tuningId: string) {
    setTuning(resolveTuning(tuningId, customs))
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
          {matchingCustoms.length > 0 ? (
            <>
              <optgroup label="Built-in">
                {matchingBuiltIns.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Custom">
                {matchingCustoms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            </>
          ) : (
            matchingBuiltIns.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))
          )}
        </select>
      </label>
    </div>
  )
}
