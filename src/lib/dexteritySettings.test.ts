import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  clampBpm,
  clampFret,
  createDexteritySettingsStore,
  DEFAULT_DEXTERITY_SETTINGS,
  MAX_BPM,
  MAX_FRET,
  MIN_BPM,
  normalizeDexteritySettings,
} from './dexteritySettings.ts'

describe('clampBpm', () => {
  it('clamps into range and rounds', () => {
    expect(clampBpm(10)).toBe(MIN_BPM)
    expect(clampBpm(9999)).toBe(MAX_BPM)
    expect(clampBpm(80.6)).toBe(81)
  })
  it('falls back for NaN', () => {
    expect(clampBpm(Number.NaN)).toBe(DEFAULT_DEXTERITY_SETTINGS.bpm)
  })
})

describe('clampFret', () => {
  it('clamps into the fret range', () => {
    expect(clampFret(-4)).toBe(0)
    expect(clampFret(99)).toBe(MAX_FRET)
  })
})

describe('normalizeDexteritySettings', () => {
  it('passes through a valid value', () => {
    const value = {
      patternId: 'chromatic-4nps',
      position: 7,
      bpm: 100,
      notesPerBeat: 2,
      autoAdvance: true,
      advanceMin: 3,
      advanceMax: 9,
    }
    expect(normalizeDexteritySettings(value)).toEqual(value)
  })

  it('rejects an unknown pattern id', () => {
    expect(normalizeDexteritySettings({ patternId: 'bogus' }).patternId).toBe(
      DEFAULT_DEXTERITY_SETTINGS.patternId,
    )
  })

  it('rejects an unsupported notes-per-beat value', () => {
    expect(normalizeDexteritySettings({ notesPerBeat: 5 }).notesPerBeat).toBe(
      DEFAULT_DEXTERITY_SETTINGS.notesPerBeat,
    )
  })

  it('orders the auto-advance span so min <= max', () => {
    const s = normalizeDexteritySettings({ advanceMin: 12, advanceMax: 3 })
    expect(s.advanceMin).toBe(3)
    expect(s.advanceMax).toBe(12)
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeDexteritySettings(null)).toEqual(DEFAULT_DEXTERITY_SETTINGS)
    expect(normalizeDexteritySettings('nope')).toEqual(DEFAULT_DEXTERITY_SETTINGS)
  })
})

describe('dexterity settings store', () => {
  it('round-trips through an injected backend', () => {
    const store = createDexteritySettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_DEXTERITY_SETTINGS)
    const next = { ...DEFAULT_DEXTERITY_SETTINGS, bpm: 120, position: 3, autoAdvance: true }
    store.set(next)
    expect(store.get()).toEqual(next)
  })
})
