import { afterEach, describe, expect, it, vi } from 'vitest'
import { fretMidi, getTuning } from './theory/instruments.ts'
import {
  ALL_PERMUTATION_PATTERNS,
  allFingerPermutations,
  dailyPermutationOrders,
  dailyPermutationSet,
  DAILY_SET_SIZE,
  dateKey,
  getPermutationPattern,
  isPermutationId,
  parsePermutationId,
  permutationId,
  permutationName,
  permutationPattern,
} from './permutations.ts'
import { expandPattern } from './exercises.ts'

const bass4 = getTuning('bass-4')

describe('allFingerPermutations', () => {
  it('produces all 24 unique orderings of [1, 2, 3, 4]', () => {
    const all = allFingerPermutations()
    expect(all).toHaveLength(24)
    const asStrings = all.map((o) => o.join(''))
    expect(new Set(asStrings).size).toBe(24)
    for (const order of all) {
      expect([...order].sort()).toEqual([1, 2, 3, 4])
    }
  })

  it('is stable: repeated calls return identical orderings in identical order', () => {
    expect(allFingerPermutations()).toEqual(allFingerPermutations())
  })

  it('starts with the identity ordering and ends with its reverse (lexicographic construction)', () => {
    const all = allFingerPermutations()
    expect(all[0]).toEqual([1, 2, 3, 4])
    expect(all[23]).toEqual([4, 3, 2, 1])
  })
})

describe('permutationId / permutationName', () => {
  it('builds a stable id and human-readable name', () => {
    expect(permutationId([1, 3, 2, 4])).toBe('perm-1324')
    expect(permutationName([1, 3, 2, 4])).toBe('Permutation 1-3-2-4')
  })
})

describe('permutationPattern', () => {
  it('builds an ExercisePattern with the expected id/name and spider-walk motif', () => {
    const pattern = permutationPattern([1, 3, 2, 4])
    expect(pattern.id).toBe('perm-1324')
    expect(pattern.name).toBe('Permutation 1-3-2-4')
    expect(pattern.category).toBe('spider')
    expect(pattern.traversal).toBe('ascending-descending')
    expect(pattern.motif).toEqual([
      { fret: 0, finger: 1 },
      { fret: 2, finger: 3 },
      { fret: 1, finger: 2 },
      { fret: 3, finger: 4 },
    ])
  })

  it('expands into the expected fret/finger sequence for 4-2-3-1 on bass-4', () => {
    const pattern = permutationPattern([4, 2, 3, 1])
    const steps = expandPattern(pattern, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
    ])
  })

  it('expands into the expected fret/finger sequence for 3-1-4-2 on bass-4', () => {
    const pattern = permutationPattern([3, 1, 4, 2])
    const steps = expandPattern(pattern, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
    ])
  })
})

describe('ALL_PERMUTATION_PATTERNS', () => {
  it('has exactly 24 patterns, each with a unique id matching its permutation', () => {
    expect(ALL_PERMUTATION_PATTERNS).toHaveLength(24)
    const ids = ALL_PERMUTATION_PATTERNS.map((p) => p.id)
    expect(new Set(ids).size).toBe(24)
    expect(ids.every((id) => isPermutationId(id))).toBe(true)
  })
})

describe('parsePermutationId / isPermutationId / getPermutationPattern', () => {
  it('round-trips a valid permutation id', () => {
    expect(parsePermutationId('perm-1324')).toEqual([1, 3, 2, 4])
    expect(isPermutationId('perm-1324')).toBe(true)
    expect(getPermutationPattern('perm-1324')).toEqual(permutationPattern([1, 3, 2, 4]))
  })

  it('rejects malformed or non-permutation ids', () => {
    for (const bad of ['perm-1123', 'perm-123', 'perm-12345', 'spider-1234-updown', 'perm-abcd', '']) {
      expect(parsePermutationId(bad)).toBeUndefined()
      expect(isPermutationId(bad)).toBe(false)
      expect(getPermutationPattern(bad)).toBeUndefined()
    }
  })
})

describe('dateKey', () => {
  it('formats a Date as YYYY-MM-DD using local calendar fields', () => {
    expect(dateKey(new Date(2026, 6, 23))).toBe('2026-07-23') // month is 0-based
    expect(dateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })
})

describe('dailyPermutationOrders / dailyPermutationSet', () => {
  it('is deterministic: the same date always gives the same set', () => {
    const a = dailyPermutationOrders('2026-07-23')
    const b = dailyPermutationOrders('2026-07-23')
    expect(a).toEqual(b)
    expect(a).toHaveLength(DAILY_SET_SIZE)

    const setA = dailyPermutationSet('2026-07-23')
    const setB = dailyPermutationSet('2026-07-23')
    expect(setA.map((p) => p.id)).toEqual(setB.map((p) => p.id))
  })

  it('gives different sets for different dates (in general)', () => {
    const day1 = dailyPermutationOrders('2026-07-23')
    const day2 = dailyPermutationOrders('2026-07-24')
    expect(day1).not.toEqual(day2)
  })

  it('every daily set contains genuine, unique permutations', () => {
    for (const dateStr of ['2026-07-23', '2026-07-24', '2026-12-31', '2000-01-01']) {
      const orders = dailyPermutationOrders(dateStr)
      const ids = orders.map((o) => o.join(''))
      expect(new Set(ids).size).toBe(orders.length)
      for (const order of orders) {
        expect([...order].sort()).toEqual([1, 2, 3, 4])
      }
    }
  })

  it('covers all 24 permutations exactly once over a 6-day cycle (aligned to a cycle boundary)', () => {
    // cycleLength for the default count (4) is ceil(24/4) = 6, and cycles are
    // anchored at multiples of 6 days since the epoch, so pick an
    // epoch-aligned date (1970-01-01, day 0) as the start of a cycle.
    const start = new Date(Date.UTC(1970, 0, 1))
    const seen: string[] = []
    for (let i = 0; i < 6; i += 1) {
      const d = new Date(start)
      d.setUTCDate(start.getUTCDate() + i)
      const dateStr = d.toISOString().slice(0, 10)
      const orders = dailyPermutationOrders(dateStr)
      seen.push(...orders.map((o) => o.join('')))
    }
    expect(seen).toHaveLength(24)
    expect(new Set(seen).size).toBe(24)
    const allIds = allFingerPermutations().map((o) => o.join(''))
    expect(new Set(seen)).toEqual(new Set(allIds))
  })

  it('reshuffles between cycles (the set for day 0 of one cycle need not match day 0 of the next)', () => {
    // Cross a cycle boundary far enough that a coincidental match is not a
    // concern for this smoke check; we only assert *some* cycle differs.
    const cycleStarts = [0, 6, 12, 18, 24, 30].map((offset) => {
      const d = new Date(Date.UTC(1970, 0, 1 + offset))
      return d.toISOString().slice(0, 10)
    })
    const firstSets = cycleStarts.map((d) => dailyPermutationOrders(d).map((o) => o.join('')).join(','))
    expect(new Set(firstSets).size).toBeGreaterThan(1)
  })
})

describe('no Math.random in the permutation lib', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('never calls Math.random, even indirectly, across every entry point', () => {
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random must not be called by the permutation lib')
    })

    expect(() => allFingerPermutations()).not.toThrow()
    expect(() => permutationPattern([1, 3, 2, 4])).not.toThrow()
    for (const dateStr of ['2026-07-23', '2026-07-24', '1970-01-01', '2000-02-29']) {
      expect(() => dailyPermutationOrders(dateStr)).not.toThrow()
      expect(() => dailyPermutationSet(dateStr, 6)).not.toThrow()
    }
  })
})
