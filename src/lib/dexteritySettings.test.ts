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
      mode: 'arpeggio',
      patternId: 'chromatic-4nps',
      scaleRootPc: 3,
      scaleId: 'dorian',
      sequenceId: 'groups-of-4',
      arpRootPc: 5,
      arpQualityId: 'min7',
      arpInversion: 'first',
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

  it('rejects an unknown scale id, sequence id, and mode', () => {
    expect(normalizeDexteritySettings({ scaleId: 'bogus' }).scaleId).toBe(
      DEFAULT_DEXTERITY_SETTINGS.scaleId,
    )
    expect(normalizeDexteritySettings({ sequenceId: 'bogus' }).sequenceId).toBe(
      DEFAULT_DEXTERITY_SETTINGS.sequenceId,
    )
    expect(normalizeDexteritySettings({ mode: 'bogus' }).mode).toBe(DEFAULT_DEXTERITY_SETTINGS.mode)
  })

  it('accepts the arpeggio mode', () => {
    expect(normalizeDexteritySettings({ mode: 'arpeggio' }).mode).toBe('arpeggio')
  })

  it('rejects an unknown arpeggio quality and inversion, wraps the arp root', () => {
    expect(normalizeDexteritySettings({ arpQualityId: 'sus4' }).arpQualityId).toBe(
      DEFAULT_DEXTERITY_SETTINGS.arpQualityId,
    )
    expect(normalizeDexteritySettings({ arpQualityId: 'dim7' }).arpQualityId).toBe('dim7')
    expect(normalizeDexteritySettings({ arpInversion: 'fourth' }).arpInversion).toBe(
      DEFAULT_DEXTERITY_SETTINGS.arpInversion,
    )
    expect(normalizeDexteritySettings({ arpInversion: 'second' }).arpInversion).toBe('second')
    expect(normalizeDexteritySettings({ arpRootPc: 15 }).arpRootPc).toBe(3)
  })

  it('wraps the scale root pitch class into 0–11', () => {
    expect(normalizeDexteritySettings({ scaleRootPc: 14 }).scaleRootPc).toBe(2)
    expect(normalizeDexteritySettings({ scaleRootPc: -1 }).scaleRootPc).toBe(11)
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
    expect(migrateDexteritySettings(v1Data)).toEqual({
      ...v1Data,
      direction: DEFAULT_DEXTERITY_SETTINGS.direction,
      mode: DEFAULT_DEXTERITY_SETTINGS.mode,
      scaleRootPc: DEFAULT_DEXTERITY_SETTINGS.scaleRootPc,
      scaleId: DEFAULT_DEXTERITY_SETTINGS.scaleId,
      sequenceId: DEFAULT_DEXTERITY_SETTINGS.sequenceId,
      arpRootPc: DEFAULT_DEXTERITY_SETTINGS.arpRootPc,
      arpQualityId: DEFAULT_DEXTERITY_SETTINGS.arpQualityId,
      arpInversion: DEFAULT_DEXTERITY_SETTINGS.arpInversion,
    })
  })

  it('fills in the scale-sequence fields with defaults for v2 data that lacks them', () => {
    const v2Data = {
      patternId: 'chromatic-4nps',
      position: 7,
      bpm: 100,
      notesPerBeat: 2,
      autoAdvance: true,
      advanceMin: 3,
      advanceMax: 9,
      direction: 'reverse',
    }
    expect(migrateDexteritySettings(v2Data)).toEqual({
      ...v2Data,
      mode: DEFAULT_DEXTERITY_SETTINGS.mode,
      scaleRootPc: DEFAULT_DEXTERITY_SETTINGS.scaleRootPc,
      scaleId: DEFAULT_DEXTERITY_SETTINGS.scaleId,
      sequenceId: DEFAULT_DEXTERITY_SETTINGS.sequenceId,
      arpRootPc: DEFAULT_DEXTERITY_SETTINGS.arpRootPc,
      arpQualityId: DEFAULT_DEXTERITY_SETTINGS.arpQualityId,
      arpInversion: DEFAULT_DEXTERITY_SETTINGS.arpInversion,
    })
  })

  it('fills in the arpeggio fields with defaults for v3 data that lacks them', () => {
    const v3Data = {
      mode: 'scale',
      patternId: 'chromatic-4nps',
      scaleRootPc: 3,
      scaleId: 'dorian',
      sequenceId: 'groups-of-4',
      position: 7,
      bpm: 100,
      notesPerBeat: 2,
      autoAdvance: true,
      advanceMin: 3,
      advanceMax: 9,
      direction: 'reverse',
    }
    expect(migrateDexteritySettings(v3Data)).toEqual({
      ...v3Data,
      arpRootPc: DEFAULT_DEXTERITY_SETTINGS.arpRootPc,
      arpQualityId: DEFAULT_DEXTERITY_SETTINGS.arpQualityId,
      arpInversion: DEFAULT_DEXTERITY_SETTINGS.arpInversion,
    })
  })

  it('a v3-tagged envelope in the store is transparently upgraded to v4', () => {
    const backend = memoryBackend()
    const v3Data = { ...DEFAULT_DEXTERITY_SETTINGS, bpm: 140 } as Partial<DexteritySettings>
    delete v3Data.arpRootPc
    delete v3Data.arpQualityId
    delete v3Data.arpInversion
    backend.setItem('mt:settings:dexterity', JSON.stringify({ v: 3, data: v3Data }))

    const store = createDexteritySettingsStore(backend)
    const loaded = store.get()
    expect(loaded.arpRootPc).toBe(DEFAULT_DEXTERITY_SETTINGS.arpRootPc)
    expect(loaded.arpQualityId).toBe(DEFAULT_DEXTERITY_SETTINGS.arpQualityId)
    expect(loaded.arpInversion).toBe(DEFAULT_DEXTERITY_SETTINGS.arpInversion)
    expect(loaded.bpm).toBe(140)

    // The migration also persists the upgraded shape.
    const rawAfter = JSON.parse(backend.getItem('mt:settings:dexterity')!) as { v: number }
    expect(rawAfter.v).toBe(4)
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
