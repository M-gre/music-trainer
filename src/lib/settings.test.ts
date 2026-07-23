import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import { createInstrumentSettingsStore, DEFAULT_TUNING_ID, resolveTuningId } from './settings.ts'

describe('resolveTuningId', () => {
  it('resolves a valid tuning id', () => {
    expect(resolveTuningId('guitar-6').id).toBe('guitar-6')
  })

  it('falls back to the default tuning for an unknown id', () => {
    expect(resolveTuningId('not-a-real-tuning').id).toBe(DEFAULT_TUNING_ID)
  })

  it('falls back to the default tuning for an empty id', () => {
    expect(resolveTuningId('').id).toBe(DEFAULT_TUNING_ID)
  })

  it('falls back to the default tuning for a stale/deleted custom id', () => {
    // A tool may have persisted a custom id as the global default before the
    // tuning was deleted (or before storage was cleared). The resolver must
    // still return a valid built-in rather than throwing.
    expect(resolveTuningId('custom:since-deleted').id).toBe(DEFAULT_TUNING_ID)
  })
})

describe('instrument settings store', () => {
  it('defaults to bass-4', () => {
    const store = createInstrumentSettingsStore(memoryBackend())
    expect(store.get()).toEqual({ tuningId: DEFAULT_TUNING_ID })
  })

  it('round-trips a chosen tuning id across store instances sharing a backend', () => {
    const backend = memoryBackend()
    createInstrumentSettingsStore(backend).set({ tuningId: 'bass-5' })
    expect(createInstrumentSettingsStore(backend).get()).toEqual({ tuningId: 'bass-5' })
  })

  it('resolves a stale persisted id back to the default tuning', () => {
    const backend = memoryBackend()
    const store = createInstrumentSettingsStore(backend)
    store.set({ tuningId: 'discontinued-tuning' })
    expect(resolveTuningId(store.get().tuningId).id).toBe(DEFAULT_TUNING_ID)
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
    const store = createInstrumentSettingsStore(broken)
    expect(store.get()).toEqual({ tuningId: DEFAULT_TUNING_ID })
  })
})
