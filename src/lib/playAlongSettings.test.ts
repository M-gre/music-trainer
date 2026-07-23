import { describe, expect, it } from 'vitest'
import { DEFAULT_ACCOMPANIMENT_SETTINGS } from './accompaniment.ts'
import { getGroove, GROOVES } from './audio/index.ts'
import { memoryBackend } from './storage.ts'
import {
  clampPlayAlongTempo,
  createPlayAlongSettingsStore,
  DEFAULT_PLAY_ALONG_SETTINGS,
  DEFAULT_PLAY_ALONG_TEMPO,
  grooveVoices,
  MAX_PLAY_ALONG_TEMPO,
  MIN_PLAY_ALONG_TEMPO,
  normalizePlayAlongSettings,
  type PlayAlongSettings,
} from './playAlongSettings.ts'

describe('clampPlayAlongTempo', () => {
  it('clamps below and above the range', () => {
    expect(clampPlayAlongTempo(1)).toBe(MIN_PLAY_ALONG_TEMPO)
    expect(clampPlayAlongTempo(9999)).toBe(MAX_PLAY_ALONG_TEMPO)
  })

  it('rounds fractional tempos', () => {
    expect(clampPlayAlongTempo(119.4)).toBe(119)
    expect(clampPlayAlongTempo(119.6)).toBe(120)
  })

  it('falls back to the default for NaN', () => {
    expect(clampPlayAlongTempo(Number.NaN)).toBe(DEFAULT_PLAY_ALONG_TEMPO)
  })
})

describe('grooveVoices', () => {
  it('returns only the voices a groove uses, in DRUM_VOICES order', () => {
    expect(grooveVoices(getGroove('rock-8ths'))).toEqual(['kick', 'snare', 'hat-closed'])
  })

  it('lists a ride when the groove uses one, still in canonical order', () => {
    // Swing declares its tracks as ride, hat-closed, kick, snare — but the
    // helper must return them in DRUM_VOICES order.
    expect(grooveVoices(getGroove('swing'))).toEqual(['kick', 'snare', 'hat-closed', 'ride'])
  })

  it('omits voices with no lane (blues shuffle has no hats)', () => {
    expect(grooveVoices(getGroove('blues-12-8'))).toEqual(['kick', 'snare', 'ride'])
  })

  it('every shipped groove exposes at least one voice', () => {
    for (const groove of GROOVES) expect(grooveVoices(groove).length).toBeGreaterThan(0)
  })
})

describe('normalizePlayAlongSettings', () => {
  it('passes through a valid value', () => {
    const value: PlayAlongSettings = {
      grooveId: 'funk',
      bpm: 96,
      countIn: false,
      masterVolume: 0.5,
      mutedVoices: ['snare'],
      accompaniment: {
        enabled: true,
        rootPc: 5,
        progressionId: 'ii-V-I',
        customDegrees: '1-4-5',
        barsPerChord: 2,
        style: 'stabs',
      },
      showChordTones: false,
    }
    expect(normalizePlayAlongSettings(value)).toEqual(value)
  })

  it('clamps tempo/volume and rejects an unknown groove id', () => {
    expect(
      normalizePlayAlongSettings({
        grooveId: 'nope',
        bpm: 500,
        masterVolume: 4,
      }),
    ).toEqual({
      grooveId: DEFAULT_PLAY_ALONG_SETTINGS.grooveId,
      bpm: MAX_PLAY_ALONG_TEMPO,
      countIn: DEFAULT_PLAY_ALONG_SETTINGS.countIn,
      masterVolume: 1,
      mutedVoices: [],
      accompaniment: DEFAULT_ACCOMPANIMENT_SETTINGS,
      showChordTones: DEFAULT_PLAY_ALONG_SETTINGS.showChordTones,
    })
  })

  it('validates, dedupes and re-orders muted voices', () => {
    const result = normalizePlayAlongSettings({
      mutedVoices: ['ride', 'kick', 'bogus', 'kick', 42],
    })
    expect(result.mutedVoices).toEqual(['kick', 'ride'])
  })

  it('keeps a muted voice that the groove does not use (not filtered to groove)', () => {
    const result = normalizePlayAlongSettings({ grooveId: 'rock-8ths', mutedVoices: ['ride'] })
    expect(result.mutedVoices).toEqual(['ride'])
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizePlayAlongSettings(null)).toEqual(DEFAULT_PLAY_ALONG_SETTINGS)
    expect(normalizePlayAlongSettings('nope')).toEqual(DEFAULT_PLAY_ALONG_SETTINGS)
  })
})

describe('play-along settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createPlayAlongSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_PLAY_ALONG_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const value: PlayAlongSettings = {
      grooveId: 'bossa',
      bpm: 88,
      countIn: false,
      masterVolume: 0.65,
      mutedVoices: ['kick', 'hat-closed'],
      accompaniment: DEFAULT_ACCOMPANIMENT_SETTINGS,
      showChordTones: false,
    }
    createPlayAlongSettingsStore(backend).set(value)
    expect(createPlayAlongSettingsStore(backend).get()).toEqual(value)
  })

  it('migrates v1 data (no accompaniment) by filling in the defaults', () => {
    const backend = memoryBackend()
    // A v1 envelope predates the accompaniment block entirely.
    backend.setItem(
      'mt:settings:play-along',
      JSON.stringify({
        v: 1,
        data: {
          grooveId: 'funk',
          bpm: 132,
          countIn: false,
          masterVolume: 0.4,
          mutedVoices: ['snare'],
        },
      }),
    )
    const migrated = createPlayAlongSettingsStore(backend).get()
    expect(migrated).toEqual({
      grooveId: 'funk',
      bpm: 132,
      countIn: false,
      masterVolume: 0.4,
      mutedVoices: ['snare'],
      accompaniment: DEFAULT_ACCOMPANIMENT_SETTINGS,
      showChordTones: DEFAULT_PLAY_ALONG_SETTINGS.showChordTones,
    })
    // The upgrade is persisted at the new version so it only runs once.
    const raw = backend.getItem('mt:settings:play-along')
    expect(raw && JSON.parse(raw).v).toBe(3)
  })

  it('migrates v2 data (no showChordTones) by filling in the default', () => {
    const backend = memoryBackend()
    // A v2 envelope has the accompaniment block but predates the chord-tones toggle.
    backend.setItem(
      'mt:settings:play-along',
      JSON.stringify({
        v: 2,
        data: {
          grooveId: 'bossa',
          bpm: 108,
          countIn: true,
          masterVolume: 0.7,
          mutedVoices: ['ride'],
          accompaniment: {
            enabled: true,
            rootPc: 2,
            progressionId: 'I-V-vi-IV',
            customDegrees: '1-5-6-4',
            barsPerChord: 1,
            style: 'pad',
          },
        },
      }),
    )
    const migrated = createPlayAlongSettingsStore(backend).get()
    // Existing prefs survive; the new toggle takes its default.
    expect(migrated.grooveId).toBe('bossa')
    expect(migrated.accompaniment.rootPc).toBe(2)
    expect(migrated.showChordTones).toBe(DEFAULT_PLAY_ALONG_SETTINGS.showChordTones)
    // The upgrade is persisted at the new version so it only runs once.
    const raw = backend.getItem('mt:settings:play-along')
    expect(raw && JSON.parse(raw).v).toBe(3)
  })

  it('normalizes corrupt persisted data back to defaults on read', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings:play-along', 'not json')
    expect(normalizePlayAlongSettings(createPlayAlongSettingsStore(backend).get())).toEqual(
      DEFAULT_PLAY_ALONG_SETTINGS,
    )
  })
})
