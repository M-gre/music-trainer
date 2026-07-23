import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  createScaleExplorerSettingsStore,
  DEFAULT_SCALE_EXPLORER_SETTINGS,
  normalizeScaleExplorerSettings,
} from './scaleExplorerSettings.ts'

describe('normalizeScaleExplorerSettings', () => {
  it('passes through a valid value', () => {
    const value = { rootPc: 7, scaleId: 'dorian', display: 'names', fullRange: true }
    expect(normalizeScaleExplorerSettings(value)).toEqual(value)
  })

  it('wraps an out-of-range root pitch class into 0–11', () => {
    expect(normalizeScaleExplorerSettings({ rootPc: 14 }).rootPc).toBe(2)
    expect(normalizeScaleExplorerSettings({ rootPc: -1 }).rootPc).toBe(11)
  })

  it('rejects an unknown scale id', () => {
    expect(normalizeScaleExplorerSettings({ scaleId: 'bogus' }).scaleId).toBe(
      DEFAULT_SCALE_EXPLORER_SETTINGS.scaleId,
    )
  })

  it('rejects an invalid display mode', () => {
    expect(normalizeScaleExplorerSettings({ display: 'sideways' }).display).toBe(
      DEFAULT_SCALE_EXPLORER_SETTINGS.display,
    )
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeScaleExplorerSettings(null)).toEqual(DEFAULT_SCALE_EXPLORER_SETTINGS)
    expect(normalizeScaleExplorerSettings('nope')).toEqual(DEFAULT_SCALE_EXPLORER_SETTINGS)
  })
})

describe('scale explorer settings store', () => {
  it('round-trips through an injected backend', () => {
    const store = createScaleExplorerSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_SCALE_EXPLORER_SETTINGS)
    store.set({ rootPc: 5, scaleId: 'lydian', display: 'names', fullRange: true })
    expect(store.get()).toEqual({ rootPc: 5, scaleId: 'lydian', display: 'names', fullRange: true })
  })
})
