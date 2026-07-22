import { describe, expect, it } from 'vitest'
import { memoryBackend, Store, type StorageBackend } from './storage.ts'

interface Settings {
  tuningId: string
  volume: number
}

const options = {
  key: 'settings',
  version: 1,
  defaultValue: { tuningId: 'bass-4', volume: 0.8 } satisfies Settings,
}

describe('Store', () => {
  it('returns the default when nothing is stored', () => {
    const store = new Store<Settings>(options, memoryBackend())
    expect(store.get()).toEqual(options.defaultValue)
  })

  it('round-trips values under the mt: prefix', () => {
    const backend = memoryBackend()
    const store = new Store<Settings>(options, backend)
    store.set({ tuningId: 'guitar-6', volume: 0.5 })
    expect(store.get()).toEqual({ tuningId: 'guitar-6', volume: 0.5 })
    expect(backend.getItem('mt:settings')).toContain('guitar-6')
    expect(backend.getItem('settings')).toBeNull()
  })

  it('returns the default on corrupted JSON', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings', '{not json')
    const store = new Store<Settings>(options, backend)
    expect(store.get()).toEqual(options.defaultValue)
  })

  it('returns the default on a non-envelope value', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings', JSON.stringify({ tuningId: 'x' }))
    const store = new Store<Settings>(options, backend)
    expect(store.get()).toEqual(options.defaultValue)
  })

  it('discards data from a newer or unknown version', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings', JSON.stringify({ v: 99, data: { tuningId: 'future' } }))
    const store = new Store<Settings>(options, backend)
    expect(store.get()).toEqual(options.defaultValue)
  })

  it('migrates old-version data when a migration is provided', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings', JSON.stringify({ v: 1, data: { tuningId: 'bass-5', volume: 1 } }))
    const store = new Store<Settings & { leftHanded: boolean }>(
      {
        key: 'settings',
        version: 2,
        defaultValue: { tuningId: 'bass-4', volume: 0.8, leftHanded: false },
        migrate: (old) => ({ ...(old as Settings), leftHanded: false }),
      },
      backend,
    )
    expect(store.get()).toEqual({ tuningId: 'bass-5', volume: 1, leftHanded: false })
    // Migration is persisted back.
    expect(JSON.parse(backend.getItem('mt:settings')!)).toEqual({
      v: 2,
      data: { tuningId: 'bass-5', volume: 1, leftHanded: false },
    })
  })

  it('falls back to the default when migration throws', () => {
    const backend = memoryBackend()
    backend.setItem('mt:settings', JSON.stringify({ v: 0, data: 'garbage' }))
    const store = new Store<Settings>(
      {
        ...options,
        migrate: () => {
          throw new Error('cannot migrate')
        },
      },
      backend,
    )
    expect(store.get()).toEqual(options.defaultValue)
  })

  it('update() applies a function to the current value', () => {
    const store = new Store<Settings>(options, memoryBackend())
    const result = store.update((s) => ({ ...s, volume: 0.3 }))
    expect(result.volume).toBe(0.3)
    expect(store.get().volume).toBe(0.3)
  })

  it('clear() removes the value', () => {
    const store = new Store<Settings>(options, memoryBackend())
    store.set({ tuningId: 'guitar-7', volume: 1 })
    store.clear()
    expect(store.get()).toEqual(options.defaultValue)
  })

  it('never throws when the backend fails', () => {
    const broken: StorageBackend = {
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
    const store = new Store<Settings>(options, broken)
    expect(store.get()).toEqual(options.defaultValue)
    expect(() => store.set(options.defaultValue)).not.toThrow()
    expect(() => store.clear()).not.toThrow()
  })
})
