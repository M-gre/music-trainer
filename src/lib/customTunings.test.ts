import { describe, expect, it } from 'vitest'
import {
  addCustomTuning,
  createCustomTuningsStore,
  customTuningsFor,
  CUSTOM_TUNING_PREFIX,
  isCustomTuningId,
  makeCustomTuningId,
  MAX_NAME_LENGTH,
  MAX_STRINGS,
  MIDI_RANGE,
  MIN_STRINGS,
  normalizeCustomTunings,
  removeCustomTuning,
  resolveTuning,
  toTuning,
  updateCustomTuning,
  validateCustomTuning,
  type CustomTuning,
  type CustomTuningInput,
} from './customTunings.ts'
import { memoryBackend } from './storage.ts'
import { getTuning } from './theory/instruments.ts'
import { nameToMidi } from './theory/notes.ts'

const bassInput = (over: Partial<CustomTuningInput> = {}): CustomTuningInput => ({
  name: 'My Bass',
  instrument: 'bass',
  strings: ['E1', 'A1', 'D2', 'G2'].map(nameToMidi),
  ...over,
})

describe('isCustomTuningId', () => {
  it('detects the custom prefix', () => {
    expect(isCustomTuningId('custom:my-bass')).toBe(true)
    expect(isCustomTuningId('bass-4')).toBe(false)
  })
})

describe('toTuning', () => {
  it('converts a custom tuning to the Tuning shape and copies the strings', () => {
    const ct: CustomTuning = { id: 'custom:x', name: 'X', instrument: 'guitar', strings: [40, 45] }
    const t = toTuning(ct)
    expect(t).toEqual({ id: 'custom:x', name: 'X', instrument: 'guitar', strings: [40, 45] })
    expect(t.strings).not.toBe(ct.strings)
  })
})

describe('validateCustomTuning', () => {
  it('accepts a valid tuning and trims the name', () => {
    const r = validateCustomTuning(bassInput({ name: '  Nice  ' }), [])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.name).toBe('Nice')
  })

  it('rejects an empty name', () => {
    expect(validateCustomTuning(bassInput({ name: '   ' }), []).ok).toBe(false)
  })

  it('rejects an over-long name', () => {
    expect(validateCustomTuning(bassInput({ name: 'x'.repeat(MAX_NAME_LENGTH + 1) }), []).ok).toBe(
      false,
    )
  })

  it('rejects a bad instrument', () => {
    const bad = { name: 'X', instrument: 'piano', strings: [40, 45] } as unknown as CustomTuningInput
    expect(validateCustomTuning(bad, []).ok).toBe(false)
  })

  it('enforces the string-count bounds', () => {
    expect(validateCustomTuning(bassInput({ strings: [40] }), []).ok).toBe(false)
    expect(
      validateCustomTuning(bassInput({ strings: new Array(MAX_STRINGS + 1).fill(40) }), []).ok,
    ).toBe(false)
    expect(validateCustomTuning(bassInput({ strings: new Array(MIN_STRINGS).fill(40) }), []).ok).toBe(
      true,
    )
  })

  it('rejects pitches outside the instrument range', () => {
    const tooLow = MIDI_RANGE.bass.min - 1
    const tooHigh = MIDI_RANGE.bass.max + 1
    expect(validateCustomTuning(bassInput({ strings: [tooLow, 40] }), []).ok).toBe(false)
    expect(validateCustomTuning(bassInput({ strings: [40, tooHigh] }), []).ok).toBe(false)
  })

  it('rejects non-integer pitches', () => {
    expect(validateCustomTuning(bassInput({ strings: [40.5, 45] }), []).ok).toBe(false)
  })

  it('uses instrument-specific ranges (a high guitar pitch invalid for bass)', () => {
    const highGuitar = MIDI_RANGE.guitar.max
    expect(validateCustomTuning(bassInput({ strings: [40, highGuitar] }), []).ok).toBe(false)
    expect(
      validateCustomTuning({ name: 'G', instrument: 'guitar', strings: [40, highGuitar] }, []).ok,
    ).toBe(true)
  })

  it('rejects a duplicate name for the same instrument (case-insensitive)', () => {
    const existing: CustomTuning[] = [
      { id: 'custom:a', name: 'Fanned', instrument: 'bass', strings: [40, 45] },
    ]
    expect(validateCustomTuning(bassInput({ name: 'fanned' }), existing).ok).toBe(false)
  })

  it('allows the same name on a different instrument', () => {
    const existing: CustomTuning[] = [
      { id: 'custom:a', name: 'Twin', instrument: 'bass', strings: [40, 45] },
    ]
    expect(
      validateCustomTuning({ name: 'Twin', instrument: 'guitar', strings: [40, 45] }, existing).ok,
    ).toBe(true)
  })

  it('allows re-saving a tuning under its own name (editingId excluded)', () => {
    const existing: CustomTuning[] = [
      { id: 'custom:a', name: 'Mine', instrument: 'bass', strings: [40, 45] },
    ]
    expect(validateCustomTuning(bassInput({ name: 'Mine' }), existing, 'custom:a').ok).toBe(true)
  })
})

describe('makeCustomTuningId', () => {
  it('slugifies the name with the custom prefix', () => {
    expect(makeCustomTuningId('Drop A♭!', [])).toBe(`${CUSTOM_TUNING_PREFIX}drop-a`)
  })

  it('falls back to a default slug when the name has no usable chars', () => {
    expect(makeCustomTuningId('♭♭♭', [])).toBe(`${CUSTOM_TUNING_PREFIX}tuning`)
  })

  it('disambiguates against taken ids', () => {
    const taken = [`${CUSTOM_TUNING_PREFIX}foo`, `${CUSTOM_TUNING_PREFIX}foo-2`]
    expect(makeCustomTuningId('Foo', taken)).toBe(`${CUSTOM_TUNING_PREFIX}foo-3`)
  })
})

describe('addCustomTuning', () => {
  it('adds a validated tuning without mutating the input list', () => {
    const list: CustomTuning[] = []
    const r = addCustomTuning(list, bassInput())
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.list).toHaveLength(1)
      expect(r.value.tuning.id.startsWith(CUSTOM_TUNING_PREFIX)).toBe(true)
      expect(r.value.tuning.name).toBe('My Bass')
    }
    expect(list).toHaveLength(0)
  })

  it('rejects an invalid tuning', () => {
    expect(addCustomTuning([], bassInput({ name: '' })).ok).toBe(false)
  })

  it('gives added tunings distinct ids even with the same name base', () => {
    const first = addCustomTuning([], bassInput({ name: 'Twin', instrument: 'bass' }))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    // Same slug base but different instrument, so the name check passes.
    const second = addCustomTuning(first.value.list, {
      name: 'Twin',
      instrument: 'guitar',
      strings: [40, 45],
    })
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.value.tuning.id).not.toBe(first.value.tuning.id)
    }
  })
})

describe('updateCustomTuning', () => {
  it('updates in place keeping the id', () => {
    const seed = addCustomTuning([], bassInput())
    if (!seed.ok) throw new Error('seed failed')
    const id = seed.value.tuning.id
    const r = updateCustomTuning(seed.value.list, id, bassInput({ name: 'Renamed' }))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.tuning.id).toBe(id)
      expect(r.value.tuning.name).toBe('Renamed')
      expect(r.value.list).toHaveLength(1)
    }
  })

  it('rejects an unknown id', () => {
    expect(updateCustomTuning([], 'custom:nope', bassInput()).ok).toBe(false)
  })

  it('rejects an update that collides with another name', () => {
    let list: CustomTuning[] = []
    const a = addCustomTuning(list, bassInput({ name: 'Alpha' }))
    if (!a.ok) throw new Error('a')
    list = a.value.list
    const b = addCustomTuning(list, bassInput({ name: 'Beta' }))
    if (!b.ok) throw new Error('b')
    list = b.value.list
    expect(updateCustomTuning(list, b.value.tuning.id, bassInput({ name: 'Alpha' })).ok).toBe(false)
  })
})

describe('removeCustomTuning', () => {
  it('removes by id without mutating', () => {
    const seed = addCustomTuning([], bassInput())
    if (!seed.ok) throw new Error('seed')
    const next = removeCustomTuning(seed.value.list, seed.value.tuning.id)
    expect(next).toHaveLength(0)
    expect(seed.value.list).toHaveLength(1)
  })
})

describe('resolveTuning', () => {
  const custom: CustomTuning = {
    id: 'custom:my-bass',
    name: 'My Bass',
    instrument: 'bass',
    strings: [40, 45],
  }

  it('resolves a built-in id', () => {
    expect(resolveTuning('guitar-6', []).id).toBe('guitar-6')
  })

  it('resolves a custom id to the converted tuning', () => {
    const t = resolveTuning('custom:my-bass', [custom])
    expect(t.name).toBe('My Bass')
    expect(t.strings).toEqual([40, 45])
  })

  it('falls back for an unknown built-in-shaped id', () => {
    expect(resolveTuning('not-real', []).id).toBe('bass-4')
  })

  it('falls back for a stale/deleted custom id', () => {
    expect(resolveTuning('custom:deleted', [custom]).id).toBe('bass-4')
  })

  it('honors a custom fallback id', () => {
    expect(resolveTuning('custom:deleted', [], 'guitar-6').id).toBe('guitar-6')
  })
})

describe('customTuningsFor', () => {
  it('filters by instrument and sorts by string count then name', () => {
    const list: CustomTuning[] = [
      { id: 'custom:g', name: 'G thing', instrument: 'guitar', strings: [40, 45] },
      { id: 'custom:b2', name: 'Zed', instrument: 'bass', strings: [40, 45, 50] },
      { id: 'custom:b1', name: 'Able', instrument: 'bass', strings: [40, 45] },
    ]
    const bass = customTuningsFor(list, 'bass')
    expect(bass.map((t) => t.id)).toEqual(['custom:b1', 'custom:b2'])
  })
})

describe('normalizeCustomTunings', () => {
  it('returns [] for non-arrays', () => {
    expect(normalizeCustomTunings(null)).toEqual([])
    expect(normalizeCustomTunings({})).toEqual([])
  })

  it('drops malformed and out-of-range entries but keeps valid ones', () => {
    const raw = [
      { id: 'custom:ok', name: 'Ok', instrument: 'bass', strings: [40, 45] },
      { id: 'no-prefix', name: 'Bad id', instrument: 'bass', strings: [40, 45] },
      { id: 'custom:bad', name: 'Bad range', instrument: 'bass', strings: [40, 999] },
      { id: 'custom:bad2', name: 'Bad strings', instrument: 'bass', strings: 'nope' },
      { id: 'custom:bad3', name: 42, instrument: 'bass', strings: [40, 45] },
      'garbage',
    ]
    const out = normalizeCustomTunings(raw)
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('custom:ok')
  })

  it('drops duplicate-named entries for the same instrument', () => {
    const raw = [
      { id: 'custom:a', name: 'Dup', instrument: 'bass', strings: [40, 45] },
      { id: 'custom:b', name: 'dup', instrument: 'bass', strings: [40, 45] },
    ]
    expect(normalizeCustomTunings(raw)).toHaveLength(1)
  })
})

describe('custom tunings store', () => {
  it('defaults to an empty list', () => {
    const store = createCustomTuningsStore(memoryBackend())
    expect(store.get()).toEqual([])
  })

  it('round-trips a saved list across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const seed = addCustomTuning([], bassInput())
    if (!seed.ok) throw new Error('seed')
    createCustomTuningsStore(backend).set(seed.value.list)
    const reread = createCustomTuningsStore(backend).get()
    expect(reread).toHaveLength(1)
    expect(reread[0]!.name).toBe('My Bass')
  })

  it('is consistent with the built-in fallback tuning id used by resolveTuning', () => {
    // Guards against the default fallback id drifting from a real built-in.
    expect(() => getTuning('bass-4')).not.toThrow()
  })
})
