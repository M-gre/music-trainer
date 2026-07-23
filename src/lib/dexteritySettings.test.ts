import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  clampBpm,
  clampFret,
  createDexteritySettingsStore,
  DEFAULT_DEXTERITY_SETTINGS,
  MAX_BPM,
  MAX_FRET,
  migrateDexteritySettings,
  MIN_BPM,
  normalizeDexteritySettings,
  type DexteritySettings,
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
      direction: 'reverse',
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

  it('accepts every valid direction and rejects unknown ones', () => {
    expect(normalizeDexteritySettings({ direction: 'forward' }).direction).toBe('forward')
    expect(normalizeDexteritySettings({ direction: 'reverse' }).direction).toBe('reverse')
    expect(normalizeDexteritySettings({ direction: 'forward-reverse' }).direction).toBe('forward-reverse')
    expect(normalizeDexteritySettings({ direction: 'sideways' }).direction).toBe(
      DEFAULT_DEXTERITY_SETTINGS.direction,
    )
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeDexteritySettings(null)).toEqual(DEFAULT_DEXTERITY_SETTINGS)
    expect(normalizeDexteritySettings('nope')).toEqual(DEFAULT_DEXTERITY_SETTINGS)
  })
})

describe('migrateDexteritySettings', () => {
  it('fills in direction with the default for v1 data that lacks it', () => {
    const v1Data = {
      patternId: 'chromatic-4nps',
      position: 7,
      bpm: 100,
      notesPerBeat: 2,
      autoAdvance: true,
      advanceMin: 3,
      advanceMax: 9,
    }
    expect(migrateDexteritySettings(v1Data)).toEqual({ ...v1Data, direction: DEFAULT_DEXTERITY_SETTINGS.direction })
  })

  it('a v1-tagged envelope in the store is transparently upgraded to v2', () => {
    const backend = memoryBackend()
    const v1Data = { ...DEFAULT_DEXTERITY_SETTINGS, bpm: 140 } as Partial<DexteritySettings>
    delete v1Data.direction
    backend.setItem('mt:settings:dexterity', JSON.stringify({ v: 1, data: v1Data }))

    const store = createDexteritySettingsStore(backend)
    const loaded = store.get()
    expect(loaded.direction).toBe(DEFAULT_DEXTERITY_SETTINGS.direction)
    expect(loaded.bpm).toBe(140)

    // The migration also persists the upgraded shape.
    const rawAfter = JSON.parse(backend.getItem('mt:settings:dexterity')!) as { v: number }
    expect(rawAfter.v).toBe(2)
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
