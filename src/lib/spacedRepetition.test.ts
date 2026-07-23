import { describe, expect, it } from 'vitest'
import {
  createSrsStore,
  EASE_MAX,
  EASE_MIN,
  EASE_START,
  emptySrsData,
  FIRST_INTERVAL,
  isDue,
  LAPSE_INTERVAL,
  NEW_WEIGHT,
  normalizeSrsData,
  overdueSteps,
  pickDue,
  qualityFromOutcome,
  reviewItem,
  reviewKey,
  SECOND_INTERVAL,
  srsWeight,
  STEP_MS,
  type SrsData,
  type SrsItem,
} from './spacedRepetition.ts'
import { memoryBackend } from './storage.ts'

const NOW = 1_000_000

/** Build an item with overrides on top of a plausible baseline. */
function item(overrides: Partial<SrsItem> = {}): SrsItem {
  return {
    interval: 1,
    ease: EASE_START,
    due: NOW,
    lapses: 0,
    reps: 1,
    lastSeen: NOW,
    ...overrides,
  }
}

describe('reviewItem — interval growth on success', () => {
  it('grants FIRST_INTERVAL on the first success of a new item', () => {
    const r = reviewItem(undefined, 1, NOW)
    expect(r.reps).toBe(1)
    expect(r.interval).toBe(FIRST_INTERVAL)
    expect(r.due).toBe(NOW + FIRST_INTERVAL * STEP_MS)
    expect(r.lastSeen).toBe(NOW)
    expect(r.lapses).toBe(0)
  })

  it('grants SECOND_INTERVAL on the second consecutive success', () => {
    const first = reviewItem(undefined, 1, NOW)
    const second = reviewItem(first, 1, NOW + STEP_MS)
    expect(second.reps).toBe(2)
    expect(second.interval).toBe(SECOND_INTERVAL)
  })

  it('multiplies interval by ease from the third success onward', () => {
    const first = reviewItem(undefined, 1, NOW)
    const second = reviewItem(first, 1, NOW + STEP_MS)
    const third = reviewItem(second, 1, NOW + 2 * STEP_MS)
    expect(third.reps).toBe(3)
    expect(third.interval).toBe(Math.round(second.interval * third.ease))
    expect(third.interval).toBeGreaterThan(second.interval)
  })
})

describe('reviewItem — lapse on failure', () => {
  it('resets interval/reps, bumps lapses, and is due immediately', () => {
    const grown = reviewItem(reviewItem(undefined, 1, NOW), 1, NOW + STEP_MS)
    const lapsed = reviewItem(grown, 0, NOW + 2 * STEP_MS)
    expect(lapsed.interval).toBe(LAPSE_INTERVAL)
    expect(lapsed.reps).toBe(0)
    expect(lapsed.lapses).toBe(grown.lapses + 1)
    expect(lapsed.due).toBe(NOW + 2 * STEP_MS) // LAPSE_INTERVAL === 0 → due now
    expect(isDue(lapsed, NOW + 2 * STEP_MS)).toBe(true)
  })

  it('lowers ease on failure', () => {
    const r = reviewItem(item({ ease: EASE_START }), 0, NOW)
    expect(r.ease).toBeLessThan(EASE_START)
  })
})

describe('reviewItem — ease clamping', () => {
  it('never exceeds EASE_MAX after many perfect reviews', () => {
    let it0: SrsItem | undefined
    for (let i = 0; i < 12; i++) it0 = reviewItem(it0, 1, NOW + i * STEP_MS)
    expect(it0!.ease).toBeLessThanOrEqual(EASE_MAX)
    expect(it0!.ease).toBe(EASE_MAX)
  })

  it('never drops below EASE_MIN after repeated failures', () => {
    let it0: SrsItem | undefined
    for (let i = 0; i < 8; i++) it0 = reviewItem(it0, 0, NOW + i * STEP_MS)
    expect(it0!.ease).toBeGreaterThanOrEqual(EASE_MIN)
    expect(it0!.ease).toBe(EASE_MIN)
  })

  it('does not mutate its input', () => {
    const before = item()
    const snapshot = { ...before }
    reviewItem(before, 1, NOW + STEP_MS)
    expect(before).toEqual(snapshot)
  })
})

describe('qualityFromOutcome', () => {
  it('scores an incorrect answer as a lapse (0)', () => {
    expect(qualityFromOutcome(false, 500)).toBe(0)
    expect(qualityFromOutcome(false, null)).toBe(0)
  })

  it('scores a correct untimed answer as a comfortable pass', () => {
    expect(qualityFromOutcome(true, null)).toBeCloseTo(0.8)
  })

  it('gives fast correct answers full quality and slow ones the minimum', () => {
    expect(qualityFromOutcome(true, 0)).toBeCloseTo(1)
    expect(qualityFromOutcome(true, 100_000)).toBeCloseTo(0.6)
  })

  it('keeps every correct answer at or above the pass threshold', () => {
    for (const ms of [0, 800, 2000, 4000, 20_000]) {
      expect(qualityFromOutcome(true, ms)).toBeGreaterThanOrEqual(0.6)
    }
  })
})

describe('srsWeight & due helpers', () => {
  it('gives never-seen items the top weight', () => {
    expect(srsWeight(undefined, NOW)).toBe(NEW_WEIGHT)
    expect(overdueSteps(undefined, NOW)).toBe(Infinity)
  })

  it('weights more-overdue items higher than just-due ones', () => {
    const justDue = item({ due: NOW })
    const overdue = item({ due: NOW - 3 * STEP_MS })
    expect(srsWeight(overdue, NOW)).toBeGreaterThan(srsWeight(justDue, NOW))
  })

  it('weights not-yet-due items below just-due ones, down to the floor', () => {
    const soon = item({ due: NOW + 1 * STEP_MS })
    const later = item({ due: NOW + 100 * STEP_MS })
    const justDue = item({ due: NOW })
    expect(srsWeight(soon, NOW)).toBeLessThan(srsWeight(justDue, NOW))
    expect(srsWeight(later, NOW)).toBeLessThanOrEqual(srsWeight(soon, NOW))
    expect(srsWeight(later, NOW)).toBeGreaterThan(0)
  })
})

describe('pickDue', () => {
  const data: SrsData = {
    a: item({ due: NOW - 2 * STEP_MS }),
    b: item({ due: NOW - 1 * STEP_MS }),
    d: item({ due: NOW + 5 * STEP_MS, lastSeen: NOW - 10 * STEP_MS }),
    e: item({ due: NOW + 9 * STEP_MS, lastSeen: NOW - 50 * STEP_MS }),
  }
  // 'c' intentionally absent → new.
  const keys = ['a', 'b', 'c', 'd', 'e']

  it('returns due items overdue-first, then new, then upcoming least-seen-first', () => {
    expect(pickDue(keys, data, NOW, 5)).toEqual(['a', 'b', 'c', 'e', 'd'])
  })

  it('honours k', () => {
    expect(pickDue(keys, data, NOW, 2)).toEqual(['a', 'b'])
    expect(pickDue(keys, data, NOW, 0)).toEqual([])
  })

  it('falls back to new/least-recently-seen when nothing is due', () => {
    const future: SrsData = {
      x: item({ due: NOW + 2 * STEP_MS, lastSeen: NOW - 1 }),
      y: item({ due: NOW + 3 * STEP_MS, lastSeen: NOW - 99 }),
    }
    // 'z' new → comes before the upcoming ones; then least-recently-seen (y).
    expect(pickDue(['x', 'y', 'z'], future, NOW, 3)).toEqual(['z', 'y', 'x'])
  })
})

describe('reviewKey', () => {
  it('folds a review under a key without mutating the map', () => {
    const before = emptySrsData()
    const after = reviewKey(before, '7', 1, NOW)
    expect(before).toEqual({})
    expect(after['7']).toBeDefined()
    expect(after['7']!.interval).toBe(FIRST_INTERVAL)
  })
})

describe('persistence', () => {
  it('round-trips through a memory-backed store', () => {
    const store = createSrsStore('unit-test', memoryBackend())
    const data = reviewKey(reviewKey({}, '0', 1, NOW), '5', 0, NOW)
    store.set(data)
    expect(store.get()).toEqual(data)
  })

  it('defaults to an empty map when nothing is stored', () => {
    const store = createSrsStore('unit-test-empty', memoryBackend())
    expect(store.get()).toEqual({})
  })

  it('normalizeSrsData drops junk and clamps ease', () => {
    const dirty = {
      good: item({ ease: 5 }), // ease above max → clamped
      bad1: null,
      bad2: 42,
      bad3: { interval: 'x' },
    }
    const clean = normalizeSrsData(dirty)
    expect(Object.keys(clean).sort()).toEqual(['bad3', 'good'])
    expect(clean.good!.ease).toBe(EASE_MAX)
    // bad3 survives with defaults filled in (interval coerced to 0).
    expect(clean.bad3!.interval).toBe(0)
    expect(clean.bad3!.ease).toBe(EASE_START)
  })

  it('normalizeSrsData rejects non-objects', () => {
    expect(normalizeSrsData(null)).toEqual({})
    expect(normalizeSrsData('nope')).toEqual({})
  })

  it('migrates an older-version envelope through normalizeSrsData', () => {
    const backend = memoryBackend()
    // Simulate a v0 payload written before the current schema.
    backend.setItem('mt:srs:migrate-test', JSON.stringify({ v: 0, data: { '3': item() } }))
    const store = createSrsStore('migrate-test', backend)
    const got = store.get()
    expect(got['3']).toBeDefined()
    expect(got['3']!.reps).toBe(1)
  })
})
