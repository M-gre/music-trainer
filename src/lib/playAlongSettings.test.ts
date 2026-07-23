import { describe, expect, it } from 'vitest'
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
    }
    createPlayAlongSettingsStore(backend).set(value)
    expect(createPlayAlongSettingsStore(backend).get()).toEqual(value)
  })

  it('normalizes corrupt persisted data back to defaults on read', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings:play-along', 'not json')
    expect(normalizePlayAlongSettings(createPlayAlongSettingsStore(backend).get())).toEqual(
      DEFAULT_PLAY_ALONG_SETTINGS,
    )
  })
})
