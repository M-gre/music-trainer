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

/** The v6 piano fields, all at their defaults — spread into pre-v6 expectations. */
const pianoDefaults = {
  pianoMode: DEFAULT_DEXTERITY_SETTINGS.pianoMode,
  pianoKind: DEFAULT_DEXTERITY_SETTINGS.pianoKind,
  pianoRootPc: DEFAULT_DEXTERITY_SETTINGS.pianoRootPc,
  pianoOctave: DEFAULT_DEXTERITY_SETTINGS.pianoOctave,
  pianoQuality: DEFAULT_DEXTERITY_SETTINGS.pianoQuality,
  pianoPatternId: DEFAULT_DEXTERITY_SETTINGS.pianoPatternId,
  pianoHand: DEFAULT_DEXTERITY_SETTINGS.pianoHand,
  pianoOctaves: DEFAULT_DEXTERITY_SETTINGS.pianoOctaves,
}

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
      rhythmId: 'gallop',
      accentEveryN: 3,
      autoAdvance: true,
      advanceMin: 3,
      advanceMax: 9,
      direction: 'reverse',
      pianoMode: true,
      pianoKind: 'scale',
      pianoRootPc: 6,
      pianoOctave: 3,
      pianoQuality: 'minor',
      pianoPatternId: 'broken-thirds',
      pianoHand: 'left',
      pianoOctaves: 2,
    }
    expect(normalizeDexteritySettings(value)).toEqual(value)
  })

  it('fills piano fields with defaults and validates/wraps them', () => {
    // v5 (no piano fields) → all piano defaults.
    const filled = normalizeDexteritySettings({ mode: 'pattern' })
    expect(filled.pianoMode).toBe(false)
    expect(filled.pianoKind).toBe(DEFAULT_DEXTERITY_SETTINGS.pianoKind)
    expect(filled.pianoHand).toBe('right')
    // Bad values fall back; a root pc wraps into 0–11; octave clamps.
    expect(normalizeDexteritySettings({ pianoKind: 'bogus' }).pianoKind).toBe(DEFAULT_DEXTERITY_SETTINGS.pianoKind)
    expect(normalizeDexteritySettings({ pianoQuality: 'diminished' }).pianoQuality).toBe('major')
    expect(normalizeDexteritySettings({ pianoPatternId: 'nope' }).pianoPatternId).toBe(
      DEFAULT_DEXTERITY_SETTINGS.pianoPatternId,
    )
    expect(normalizeDexteritySettings({ pianoHand: 'middle' }).pianoHand).toBe('right')
    expect(normalizeDexteritySettings({ pianoOctaves: 3 }).pianoOctaves).toBe(1)
    expect(normalizeDexteritySettings({ pianoRootPc: 14 }).pianoRootPc).toBe(2)
    expect(normalizeDexteritySettings({ pianoOctave: 99 }).pianoOctave).toBe(6)
    // Valid values pass through.
    expect(normalizeDexteritySettings({ pianoMode: true, pianoKind: 'scale', pianoHand: 'left' })).toMatchObject({
      pianoMode: true,
      pianoKind: 'scale',
      pianoHand: 'left',
    })
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

  it('rejects an unknown rhythm and accent value', () => {
    expect(normalizeDexteritySettings({ rhythmId: 'bogus' }).rhythmId).toBe(
      DEFAULT_DEXTERITY_SETTINGS.rhythmId,
    )
    expect(normalizeDexteritySettings({ rhythmId: 'triplets' }).rhythmId).toBe('triplets')
    expect(normalizeDexteritySettings({ accentEveryN: 5 }).accentEveryN).toBe(
      DEFAULT_DEXTERITY_SETTINGS.accentEveryN,
    )
    expect(normalizeDexteritySettings({ accentEveryN: 3 }).accentEveryN).toBe(3)
  })

  it('derives the rhythm from a legacy notes-per-beat when no rhythm is set', () => {
    expect(normalizeDexteritySettings({ notesPerBeat: 3 }).rhythmId).toBe('triplets')
    expect(normalizeDexteritySettings({ notesPerBeat: 4 }).rhythmId).toBe('sixteenths')
    // An explicit rhythm wins over the legacy field.
    expect(normalizeDexteritySettings({ notesPerBeat: 3, rhythmId: 'gallop' }).rhythmId).toBe('gallop')
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
  // Fields older versions all shared once normalized (position/bpm coerced,
  // legacy notesPerBeat:2 -> 'eighths', accent layer off).
  const commonV5Fields = {
    patternId: 'chromatic-4nps',
    position: 7,
    bpm: 100,
    rhythmId: 'eighths',
    accentEveryN: 0,
    autoAdvance: true,
    advanceMin: 3,
    advanceMax: 9,
  }

  it('fills in direction + rhythm defaults for v1 data that lacks them', () => {
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
      ...commonV5Fields,
      ...pianoDefaults,
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
      ...commonV5Fields,
      ...pianoDefaults,
      direction: 'reverse',
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
      ...commonV5Fields,
      ...pianoDefaults,
      mode: 'scale',
      scaleRootPc: 3,
      scaleId: 'dorian',
      sequenceId: 'groups-of-4',
      direction: 'reverse',
      arpRootPc: DEFAULT_DEXTERITY_SETTINGS.arpRootPc,
      arpQualityId: DEFAULT_DEXTERITY_SETTINGS.arpQualityId,
      arpInversion: DEFAULT_DEXTERITY_SETTINGS.arpInversion,
    })
  })

  it('fills in the rhythm fields for v4 data, deriving the rhythm from notesPerBeat', () => {
    const v4Data = {
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
      notesPerBeat: 3,
      autoAdvance: true,
      advanceMin: 3,
      advanceMax: 9,
      direction: 'reverse',
    }
    const migrated = migrateDexteritySettings(v4Data)
    expect(migrated.rhythmId).toBe('triplets')
    expect(migrated.accentEveryN).toBe(0)
    expect('notesPerBeat' in migrated).toBe(false)
  })

  it('a v4-tagged envelope in the store is transparently upgraded to v6', () => {
    const backend = memoryBackend()
    const v4Data = { ...DEFAULT_DEXTERITY_SETTINGS, bpm: 140, notesPerBeat: 4 } as Partial<DexteritySettings> & {
      notesPerBeat?: number
    }
    delete v4Data.rhythmId
    delete v4Data.accentEveryN
    backend.setItem('mt:settings:dexterity', JSON.stringify({ v: 4, data: v4Data }))

    const store = createDexteritySettingsStore(backend)
    const loaded = store.get()
    expect(loaded.rhythmId).toBe('sixteenths')
    expect(loaded.accentEveryN).toBe(0)
    expect(loaded.bpm).toBe(140)

    // The migration also persists the upgraded shape.
    const rawAfter = JSON.parse(backend.getItem('mt:settings:dexterity')!) as { v: number }
    expect(rawAfter.v).toBe(6)
  })

  it('a v5-tagged envelope (no piano fields) upgrades to v6 with piano defaults', () => {
    const backend = memoryBackend()
    const v5Data = { ...DEFAULT_DEXTERITY_SETTINGS, bpm: 120 } as Partial<DexteritySettings>
    delete v5Data.pianoMode
    delete v5Data.pianoKind
    delete v5Data.pianoHand
    backend.setItem('mt:settings:dexterity', JSON.stringify({ v: 5, data: v5Data }))

    const store = createDexteritySettingsStore(backend)
    const loaded = store.get()
    expect(loaded.pianoMode).toBe(false)
    expect(loaded.pianoKind).toBe(DEFAULT_DEXTERITY_SETTINGS.pianoKind)
    expect(loaded.pianoHand).toBe('right')
    expect(loaded.bpm).toBe(120)

    const rawAfter = JSON.parse(backend.getItem('mt:settings:dexterity')!) as { v: number }
    expect(rawAfter.v).toBe(6)
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
