import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  applySpellingPreference,
  clampVolume,
  createGlobalSettingsStore,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_MASTER_VOLUME,
  migrateGlobalSettings,
  normalizeGlobalSettings,
  readPersistedMasterVolume,
} from './globalSettings.ts'

describe('clampVolume', () => {
  it('clamps into [0, 1]', () => {
    expect(clampVolume(-0.5)).toBe(0)
    expect(clampVolume(2)).toBe(1)
    expect(clampVolume(0.42)).toBe(0.42)
  })

  it('falls back to the default volume for NaN', () => {
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_MASTER_VOLUME)
  })
})

describe('applySpellingPreference', () => {
  it('passes the context choice through for auto', () => {
    expect(applySpellingPreference('auto', 'flat')).toBe('flat')
    expect(applySpellingPreference('auto', 'sharp')).toBe('sharp')
  })

  it('forces the chosen accidental for sharps/flats', () => {
    expect(applySpellingPreference('sharps', 'flat')).toBe('sharp')
    expect(applySpellingPreference('flats', 'sharp')).toBe('flat')
  })
})

describe('normalizeGlobalSettings', () => {
  it('returns the defaults for non-object input', () => {
    expect(normalizeGlobalSettings(null)).toEqual(DEFAULT_GLOBAL_SETTINGS)
    expect(normalizeGlobalSettings('nope')).toEqual(DEFAULT_GLOBAL_SETTINGS)
  })

  it('fills missing fields from the defaults', () => {
    expect(normalizeGlobalSettings({ leftHanded: true })).toEqual({
      ...DEFAULT_GLOBAL_SETTINGS,
      leftHanded: true,
    })
  })

  it('rejects an invalid spelling preference', () => {
    expect(normalizeGlobalSettings({ spellingPreference: 'bogus' }).spellingPreference).toBe(
      DEFAULT_GLOBAL_SETTINGS.spellingPreference,
    )
  })

  it('clamps an out-of-range volume', () => {
    expect(normalizeGlobalSettings({ masterVolume: 5 }).masterVolume).toBe(1)
  })

  it('keeps valid fields verbatim', () => {
    const settings = { leftHanded: true, spellingPreference: 'flats', masterVolume: 0.3 }
    expect(normalizeGlobalSettings(settings)).toEqual(settings)
  })
})

describe('global settings store', () => {
  it('defaults to the shared defaults', () => {
    const store = createGlobalSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_GLOBAL_SETTINGS)
  })

  it('round-trips across store instances sharing a backend', () => {
    const backend = memoryBackend()
    createGlobalSettingsStore(backend).set({
      leftHanded: true,
      spellingPreference: 'sharps',
      masterVolume: 0.5,
    })
    expect(createGlobalSettingsStore(backend).get()).toEqual({
      leftHanded: true,
      spellingPreference: 'sharps',
      masterVolume: 0.5,
    })
  })

  it('migrates older-version data through normalization', () => {
    const backend = memoryBackend()
    // Simulate a hypothetical v0 envelope missing later fields.
    backend.setItem('mt:settings:global', JSON.stringify({ v: 0, data: { leftHanded: true } }))
    const store = createGlobalSettingsStore(backend)
    expect(store.get()).toEqual({ ...DEFAULT_GLOBAL_SETTINGS, leftHanded: true })
  })

  it('never throws when the backend fails', () => {
    const broken = {
      getItem: () => {
        throw new Error('nope')
      },
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {
        throw new Error('nope')
      },
    }
    const store = createGlobalSettingsStore(broken)
    expect(store.get()).toEqual(DEFAULT_GLOBAL_SETTINGS)
  })
})

describe('migrateGlobalSettings', () => {
  it('normalizes arbitrary old data', () => {
    expect(migrateGlobalSettings({ masterVolume: -3 })).toEqual({
      ...DEFAULT_GLOBAL_SETTINGS,
      masterVolume: 0,
    })
  })
})

describe('readPersistedMasterVolume', () => {
  it('returns a volume in range from the app store', () => {
    const volume = readPersistedMasterVolume()
    expect(volume).toBeGreaterThanOrEqual(0)
    expect(volume).toBeLessThanOrEqual(1)
  })
})
