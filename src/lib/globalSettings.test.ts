import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  applySpellingPreference,
  clampVolume,
  createGlobalSettingsStore,
  DEFAULT_GLOBAL_SETTINGS,
  DEFAULT_MASTER_VOLUME,
  DEFAULT_VOICE_PREFERENCES,
  migrateGlobalSettings,
  normalizeGlobalSettings,
  normalizeVoicePreferences,
  readPersistedMasterVolume,
  readPersistedVoicePreferences,
} from './globalSettings.ts'
import { isVoiceName } from './audio/voices.ts'

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
    const settings = {
      leftHanded: true,
      spellingPreference: 'flats',
      masterVolume: 0.3,
      voices: { fretted: 'classic', keyboard: 'pluck' },
    }
    expect(normalizeGlobalSettings(settings)).toEqual(settings)
  })

  it('fills default voices when missing and rejects invalid voice names', () => {
    expect(normalizeGlobalSettings({}).voices).toEqual(DEFAULT_VOICE_PREFERENCES)
    expect(normalizeGlobalSettings({ voices: { fretted: 'bogus', keyboard: 'piano' } }).voices).toEqual(
      { fretted: DEFAULT_VOICE_PREFERENCES.fretted, keyboard: 'piano' },
    )
  })
})

describe('normalizeVoicePreferences', () => {
  it('defaults per field and accepts valid voices', () => {
    expect(normalizeVoicePreferences(null)).toEqual(DEFAULT_VOICE_PREFERENCES)
    expect(normalizeVoicePreferences({ fretted: 'piano' })).toEqual({
      ...DEFAULT_VOICE_PREFERENCES,
      fretted: 'piano',
    })
    expect(normalizeVoicePreferences({ fretted: 3, keyboard: 'classic' })).toEqual({
      fretted: DEFAULT_VOICE_PREFERENCES.fretted,
      keyboard: 'classic',
    })
  })

  it('defaults are valid voice names', () => {
    expect(isVoiceName(DEFAULT_VOICE_PREFERENCES.fretted)).toBe(true)
    expect(isVoiceName(DEFAULT_VOICE_PREFERENCES.keyboard)).toBe(true)
  })
})

describe('global settings store', () => {
  it('defaults to the shared defaults', () => {
    const store = createGlobalSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_GLOBAL_SETTINGS)
  })

  it('round-trips across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = {
      leftHanded: true,
      spellingPreference: 'sharps' as const,
      masterVolume: 0.5,
      voices: { fretted: 'piano' as const, keyboard: 'classic' as const },
    }
    createGlobalSettingsStore(backend).set(value)
    expect(createGlobalSettingsStore(backend).get()).toEqual(value)
  })

  it('migrates older v1 data (no voices) by filling default voices', () => {
    const backend = memoryBackend()
    // A v1 envelope predates the `voices` field.
    backend.setItem(
      'mt:settings:global',
      JSON.stringify({ v: 1, data: { leftHanded: true, spellingPreference: 'flats', masterVolume: 0.4 } }),
    )
    const store = createGlobalSettingsStore(backend)
    expect(store.get()).toEqual({
      leftHanded: true,
      spellingPreference: 'flats',
      masterVolume: 0.4,
      voices: DEFAULT_VOICE_PREFERENCES,
    })
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

describe('readPersistedVoicePreferences', () => {
  it('returns valid voice names from the app store', () => {
    const prefs = readPersistedVoicePreferences()
    expect(isVoiceName(prefs.fretted)).toBe(true)
    expect(isVoiceName(prefs.keyboard)).toBe(true)
  })
})
