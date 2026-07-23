import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  clampCircleIndex,
  createCircleOfFifthsSettingsStore,
  DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS,
  normalizeCircleOfFifthsSettings,
} from './circleOfFifthsSettings.ts'

describe('clampCircleIndex', () => {
  it('clamps below and above the valid range', () => {
    expect(clampCircleIndex(-3)).toBe(0)
    expect(clampCircleIndex(30)).toBe(11)
  })

  it('rounds fractional indices', () => {
    expect(clampCircleIndex(4.6)).toBe(5)
  })

  it('falls back to the default for NaN', () => {
    expect(clampCircleIndex(Number.NaN)).toBe(DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS.selectedIndex)
  })
})

describe('normalizeCircleOfFifthsSettings', () => {
  it('passes through a valid value', () => {
    expect(normalizeCircleOfFifthsSettings({ selectedIndex: 7 })).toEqual({ selectedIndex: 7 })
  })

  it('clamps an out-of-range index', () => {
    expect(normalizeCircleOfFifthsSettings({ selectedIndex: 99 })).toEqual({ selectedIndex: 11 })
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeCircleOfFifthsSettings(null)).toEqual(DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS)
    expect(normalizeCircleOfFifthsSettings('nope')).toEqual(DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS)
  })
})

describe('circle of fifths settings store', () => {
  it('defaults to C (index 0)', () => {
    const store = createCircleOfFifthsSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_CIRCLE_OF_FIFTHS_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { selectedIndex: 9 }
    createCircleOfFifthsSettingsStore(backend).set(value)
    expect(createCircleOfFifthsSettingsStore(backend).get()).toEqual(value)
  })
})
