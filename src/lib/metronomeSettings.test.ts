import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  clampTempo,
  createMetronomeSettingsStore,
  DEFAULT_METRONOME_SETTINGS,
  MAX_TEMPO,
  MIN_TEMPO,
  normalizeMetronomeSettings,
} from './metronomeSettings.ts'

describe('clampTempo', () => {
  it('clamps below and above the range', () => {
    expect(clampTempo(1)).toBe(MIN_TEMPO)
    expect(clampTempo(9999)).toBe(MAX_TEMPO)
  })

  it('rounds fractional tempos', () => {
    expect(clampTempo(120.6)).toBe(121)
  })

  it('falls back to the default for NaN', () => {
    expect(clampTempo(Number.NaN)).toBe(DEFAULT_METRONOME_SETTINGS.bpm)
  })
})

describe('normalizeMetronomeSettings', () => {
  it('passes through a valid value', () => {
    const value = { bpm: 100, beatsPerBar: 3, subdivisionsPerBeat: 2 }
    expect(normalizeMetronomeSettings(value)).toEqual(value)
  })

  it('clamps the tempo and rejects unsupported meter/subdivision options', () => {
    expect(normalizeMetronomeSettings({ bpm: 500, beatsPerBar: 9, subdivisionsPerBeat: 5 })).toEqual({
      bpm: MAX_TEMPO,
      beatsPerBar: DEFAULT_METRONOME_SETTINGS.beatsPerBar,
      subdivisionsPerBeat: DEFAULT_METRONOME_SETTINGS.subdivisionsPerBeat,
    })
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeMetronomeSettings(null)).toEqual(DEFAULT_METRONOME_SETTINGS)
    expect(normalizeMetronomeSettings('nope')).toEqual(DEFAULT_METRONOME_SETTINGS)
  })
})

describe('metronome settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createMetronomeSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_METRONOME_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { bpm: 90, beatsPerBar: 6, subdivisionsPerBeat: 3 }
    createMetronomeSettingsStore(backend).set(value)
    expect(createMetronomeSettingsStore(backend).get()).toEqual(value)
  })
})
