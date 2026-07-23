import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  clampTempo,
  createMetronomeSettingsStore,
  DEFAULT_METRONOME_SETTINGS,
  defaultAccents,
  MAX_TEMPO,
  migrateMetronomeSettings,
  MIN_TEMPO,
  normalizeMetronomeSettings,
  resizeAccents,
  type MetronomeSettings,
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

describe('defaultAccents', () => {
  it('puts a strong downbeat first and mid everywhere else', () => {
    expect(defaultAccents(4)).toEqual(['high', 'mid', 'mid', 'mid'])
    expect(defaultAccents(2)).toEqual(['high', 'mid'])
  })

  it('always produces at least one beat', () => {
    expect(defaultAccents(0)).toEqual(['high'])
  })
})

describe('resizeAccents', () => {
  it('preserves existing beats when growing and fills new ones with mid', () => {
    expect(resizeAccents(['high', 'low'], 4)).toEqual(['high', 'low', 'mid', 'mid'])
  })

  it('drops trailing beats when shrinking', () => {
    expect(resizeAccents(['high', 'low', 'off', 'mid'], 2)).toEqual(['high', 'low'])
  })

  it('is a no-op when the length already matches', () => {
    expect(resizeAccents(['high', 'off', 'mid'], 3)).toEqual(['high', 'off', 'mid'])
  })

  it('replaces invalid entries with the default beat accent', () => {
    expect(resizeAccents(['high', 'bogus', 7], 3)).toEqual(['high', 'mid', 'mid'])
  })

  it('falls back to a fresh default pattern for non-array input', () => {
    expect(resizeAccents(undefined, 3)).toEqual(defaultAccents(3))
  })
})

describe('normalizeMetronomeSettings', () => {
  it('passes through a valid value', () => {
    const value = {
      bpm: 100,
      beatsPerBar: 3,
      subdivisionsPerBeat: 2,
      soundId: 'blip' as const,
      accents: ['high', 'mid', 'low'] as const,
    }
    expect(normalizeMetronomeSettings(value)).toEqual(value)
  })

  it('clamps tempo and rejects unsupported meter/subdivision/sound options', () => {
    expect(
      normalizeMetronomeSettings({
        bpm: 500,
        beatsPerBar: 9,
        subdivisionsPerBeat: 5,
        soundId: 'trumpet',
      }),
    ).toEqual({
      bpm: MAX_TEMPO,
      beatsPerBar: DEFAULT_METRONOME_SETTINGS.beatsPerBar,
      subdivisionsPerBeat: DEFAULT_METRONOME_SETTINGS.subdivisionsPerBeat,
      soundId: DEFAULT_METRONOME_SETTINGS.soundId,
      accents: defaultAccents(DEFAULT_METRONOME_SETTINGS.beatsPerBar),
    })
  })

  it('resizes the accent array to match the resolved beatsPerBar', () => {
    const result = normalizeMetronomeSettings({
      beatsPerBar: 5,
      accents: ['off', 'high'],
    })
    expect(result.beatsPerBar).toBe(5)
    expect(result.accents).toEqual(['off', 'high', 'mid', 'mid', 'mid'])
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeMetronomeSettings(null)).toEqual(DEFAULT_METRONOME_SETTINGS)
    expect(normalizeMetronomeSettings('nope')).toEqual(DEFAULT_METRONOME_SETTINGS)
  })
})

describe('migrateMetronomeSettings (v1 -> v2)', () => {
  it('adds the default sound and an accent pattern sized to the stored meter', () => {
    // A v1 value had only bpm / beatsPerBar / subdivisionsPerBeat.
    const v1 = { bpm: 90, beatsPerBar: 3, subdivisionsPerBeat: 2 }
    expect(migrateMetronomeSettings(v1)).toEqual({
      bpm: 90,
      beatsPerBar: 3,
      subdivisionsPerBeat: 2,
      soundId: DEFAULT_METRONOME_SETTINGS.soundId,
      accents: ['high', 'mid', 'mid'],
    })
  })
})

describe('metronome settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createMetronomeSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_METRONOME_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const value: MetronomeSettings = {
      bpm: 90,
      beatsPerBar: 6,
      subdivisionsPerBeat: 3,
      soundId: 'tick',
      accents: ['high', 'off', 'mid', 'low', 'mid', 'high'],
    }
    createMetronomeSettingsStore(backend).set(value)
    expect(createMetronomeSettingsStore(backend).get()).toEqual(value)
  })

  it('migrates a persisted v1 envelope to v2 on read', () => {
    const backend = memoryBackend()
    // Simulate data written by the old v1 store.
    backend.setItem(
      'mt:settings:metronome',
      JSON.stringify({ v: 1, data: { bpm: 100, beatsPerBar: 4, subdivisionsPerBeat: 1 } }),
    )
    const migrated = createMetronomeSettingsStore(backend).get()
    expect(migrated).toEqual({
      bpm: 100,
      beatsPerBar: 4,
      subdivisionsPerBeat: 1,
      soundId: DEFAULT_METRONOME_SETTINGS.soundId,
      accents: ['high', 'mid', 'mid', 'mid'],
    })
    // And the migrated value is re-persisted at v2.
    const raw = backend.getItem('mt:settings:metronome')!
    expect(JSON.parse(raw).v).toBe(2)
  })
})
