import { describe, expect, it } from 'vitest'
import {
  ACCURACY_ALPHA,
  createNoteStatsStore,
  emptyNoteStats,
  noteWeight,
  normalizeNoteStats,
  pickWeighted,
  pickWeightedByPc,
  recordFindAllRound,
  recordOutcome,
  UNSEEN_WEIGHT,
  type NoteStat,
  type NoteStatsData,
} from './noteStats.ts'
import { memoryBackend } from './storage.ts'
import type { PitchClass } from './theory/notes.ts'
import type { Rng as RngType } from './quiz.ts'

/** Deterministic rng cycling through the given values in [0, 1). */
function seq(...values: number[]): RngType {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

/** A seeded LCG for distribution tests — deterministic but well-spread. */
function lcg(seed: number): RngType {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const NOW = 1_000_000

function stat(overrides: Partial<NoteStat>): NoteStat {
  return { attempts: 1, correct: 1, accuracy: 1, responseMs: 500, lastSeen: NOW, ...overrides }
}

describe('recordOutcome', () => {
  it('seeds accuracy from the first sample and increments counts', () => {
    const d1 = recordOutcome(emptyNoteStats(), 5, true, 800, NOW)
    expect(d1[5]).toEqual({
      attempts: 1,
      correct: 1,
      accuracy: 1,
      responseMs: 800,
      lastSeen: NOW,
    })
    const d2 = recordOutcome(d1, 5, false, 1200, NOW + 10)
    expect(d2[5]?.attempts).toBe(2)
    expect(d2[5]?.correct).toBe(1)
    expect(d2[5]?.lastSeen).toBe(NOW + 10)
  })

  it('applies exponential weighting so recent answers dominate', () => {
    // Two correct then one wrong: accuracy is pulled down by exactly ALPHA.
    let d = emptyNoteStats()
    d = recordOutcome(d, 0, true, null, NOW)
    d = recordOutcome(d, 0, true, null, NOW)
    expect(d[0]?.accuracy).toBe(1)
    d = recordOutcome(d, 0, false, null, NOW)
    expect(d[0]?.accuracy).toBeCloseTo(1 * (1 - ACCURACY_ALPHA), 10)
  })

  it('weights response time only when timing is present', () => {
    let d = recordOutcome(emptyNoteStats(), 0, true, 1000, NOW)
    // A find-all style untimed outcome must not disturb the response average.
    d = recordOutcome(d, 0, true, null, NOW)
    expect(d[0]?.responseMs).toBe(1000)
    d = recordOutcome(d, 0, true, 2000, NOW)
    expect(d[0]?.responseMs).toBeCloseTo(0.3 * 2000 + 0.7 * 1000, 10)
  })

  it('is immutable — the input map is not mutated', () => {
    const before = emptyNoteStats()
    const after = recordOutcome(before, 3, true, null, NOW)
    expect(before[3]).toBeUndefined()
    expect(after[3]).toBeDefined()
  })

  it('wraps pitch classes with mod12', () => {
    const d = recordOutcome(emptyNoteStats(), 14 as PitchClass, true, null, NOW)
    expect(d[2]).toBeDefined()
    expect(d[14]).toBeUndefined()
  })
})

describe('recordFindAllRound', () => {
  it('counts each found note once and each mistake as incorrect on the prompt', () => {
    const d = recordFindAllRound(emptyNoteStats(), [7, 7, 7], 7, 2, NOW)
    // Found once (correct) + two mistakes (incorrect) = 3 attempts, 1 correct.
    expect(d[7]?.attempts).toBe(3)
    expect(d[7]?.correct).toBe(1)
    expect(d[7]?.lastSeen).toBe(NOW)
  })

  it('records a clean round as a single correct attempt', () => {
    const d = recordFindAllRound(emptyNoteStats(), [4, 4], 4, 0, NOW)
    expect(d[4]?.attempts).toBe(1)
    expect(d[4]?.correct).toBe(1)
    expect(d[4]?.accuracy).toBe(1)
  })

  it('credits distinct found notes separately', () => {
    const d = recordFindAllRound(emptyNoteStats(), [1, 2, 2], 1, 0, NOW)
    expect(d[1]?.attempts).toBe(1)
    expect(d[2]?.attempts).toBe(1)
  })
})

describe('normalizeNoteStats', () => {
  it('returns empty for non-objects', () => {
    expect(normalizeNoteStats(null)).toEqual({})
    expect(normalizeNoteStats('nope')).toEqual({})
    expect(normalizeNoteStats(42)).toEqual({})
  })

  it('drops out-of-range keys and malformed entries', () => {
    const raw = {
      '0': { attempts: 3, correct: 2, accuracy: 0.6, responseMs: 900, lastSeen: NOW },
      '12': { attempts: 1, correct: 1, accuracy: 1, responseMs: 1, lastSeen: 1 },
      x: { attempts: 1 },
      '5': 'garbage',
    }
    const out = normalizeNoteStats(raw)
    expect(Object.keys(out)).toEqual(['0'])
    expect(out[0]).toEqual({ attempts: 3, correct: 2, accuracy: 0.6, responseMs: 900, lastSeen: NOW })
  })

  it('coerces invalid numeric fields to safe defaults', () => {
    const out = normalizeNoteStats({ '3': { attempts: -1, correct: 99, accuracy: 5, responseMs: -2, lastSeen: 'x' } })
    expect(out[3]).toEqual({ attempts: 0, correct: 0, accuracy: null, responseMs: null, lastSeen: null })
  })
})

describe('noteWeight', () => {
  it('gives unseen notes the top weight', () => {
    expect(noteWeight(undefined, NOW)).toBe(UNSEEN_WEIGHT)
    expect(noteWeight(stat({ attempts: 0, accuracy: null }), NOW)).toBe(UNSEEN_WEIGHT)
  })

  it('is lowest for a perfectly-known, freshly-seen note', () => {
    const strong = noteWeight(stat({ accuracy: 1, responseMs: 0, lastSeen: NOW }), NOW)
    const weak = noteWeight(stat({ accuracy: 0.2, responseMs: 0, lastSeen: NOW }), NOW)
    expect(weak).toBeGreaterThan(strong)
  })

  it('rises with slow responses and with staleness', () => {
    const base = stat({ accuracy: 1, responseMs: 0, lastSeen: NOW })
    const slow = stat({ accuracy: 1, responseMs: 4000, lastSeen: NOW })
    const stale = stat({ accuracy: 1, responseMs: 0, lastSeen: NOW - 60_000 })
    expect(noteWeight(slow, NOW)).toBeGreaterThan(noteWeight(base, NOW))
    expect(noteWeight(stale, NOW)).toBeGreaterThan(noteWeight(base, NOW))
  })

  it('keeps every seen weight below the unseen weight', () => {
    const worst = noteWeight(stat({ accuracy: 0, responseMs: 999_999, lastSeen: 0 }), NOW)
    expect(worst).toBeLessThan(UNSEEN_WEIGHT)
  })
})

describe('pickWeighted', () => {
  it('selects the bucket the random threshold lands in', () => {
    const items = ['a', 'b', 'c']
    const weights: Record<string, number> = { a: 1, b: 1, c: 2 }
    // total = 4. rng 0.0 -> a; 0.3 -> b (0.3*4=1.2, past a); 0.9 -> c.
    expect(pickWeighted(items, (i) => weights[i]!, seq(0))).toBe('a')
    expect(pickWeighted(items, (i) => weights[i]!, seq(0.3))).toBe('b')
    expect(pickWeighted(items, (i) => weights[i]!, seq(0.9))).toBe('c')
  })

  it('falls back to a uniform draw when all weights are zero', () => {
    const items = ['a', 'b', 'c']
    expect(pickWeighted(items, () => 0, seq(0.5))).toBe('b')
  })

  it('throws on an empty list', () => {
    expect(() => pickWeighted([], () => 1, seq(0))).toThrow()
  })
})

describe('pickWeightedByPc', () => {
  const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as PitchClass[]
  const pcOf = (n: PitchClass): PitchClass => n

  function distribution(stats: NoteStatsData, rng: RngType, draws: number): Map<PitchClass, number> {
    const counts = new Map<PitchClass, number>()
    for (let i = 0; i < draws; i++) {
      const pc = pickWeightedByPc(items, pcOf, stats, rng, NOW)
      counts.set(pc, (counts.get(pc) ?? 0) + 1)
    }
    return counts
  }

  it('is biased toward the weak note but still hits others (not deterministic)', () => {
    // pc 0 is weak (low accuracy); the rest are strong and fresh.
    let stats: NoteStatsData = {}
    for (const pc of items) {
      stats = { ...stats, [pc]: stat({ accuracy: pc === 0 ? 0.1 : 1, responseMs: 0, lastSeen: NOW }) }
    }
    const counts = distribution(stats, lcg(1), 3000)
    const weak = counts.get(0) ?? 0
    const others = [...counts.entries()].filter(([pc]) => pc !== 0)
    // The weak note dominates...
    for (const [, c] of others) expect(weak).toBeGreaterThan(c)
    // ...but the picker is not deterministic: other notes still appear.
    expect(others.length).toBeGreaterThan(3)
    expect(weak).toBeLessThan(3000)
  })

  it('prioritizes unseen notes over seen ones', () => {
    // pcs 0..3 unseen; 4..11 seen and strong.
    let stats: NoteStatsData = {}
    for (const pc of items) {
      if (pc >= 4) stats = { ...stats, [pc]: stat({ accuracy: 1, responseMs: 0, lastSeen: NOW }) }
    }
    const counts = distribution(stats, lcg(7), 4000)
    const unseenTotal = [0, 1, 2, 3].reduce((sum, pc) => sum + (counts.get(pc as PitchClass) ?? 0), 0)
    const seenTotal = 4000 - unseenTotal
    expect(unseenTotal).toBeGreaterThan(seenTotal)
    // Each individual unseen note beats each individual seen note.
    const minUnseen = Math.min(...[0, 1, 2, 3].map((pc) => counts.get(pc as PitchClass) ?? 0))
    const maxSeen = Math.max(...[4, 5, 6, 7, 8, 9, 10, 11].map((pc) => counts.get(pc as PitchClass) ?? 0))
    expect(minUnseen).toBeGreaterThan(maxSeen)
  })

  it('is roughly uniform when every note is equal', () => {
    let stats: NoteStatsData = {}
    for (const pc of items) {
      stats = { ...stats, [pc]: stat({ accuracy: 1, responseMs: 0, lastSeen: NOW }) }
    }
    const draws = 12000
    const counts = distribution(stats, lcg(99), draws)
    const expected = draws / items.length
    for (const pc of items) {
      const c = counts.get(pc) ?? 0
      // Within ~35% of the uniform expectation.
      expect(c).toBeGreaterThan(expected * 0.65)
      expect(c).toBeLessThan(expected * 1.35)
    }
  })

  it('all-unseen also draws uniform-ish', () => {
    const counts = distribution({}, lcg(3), 12000)
    const expected = 12000 / items.length
    for (const pc of items) {
      const c = counts.get(pc) ?? 0
      expect(c).toBeGreaterThan(expected * 0.65)
      expect(c).toBeLessThan(expected * 1.35)
    }
  })

  it('throws on an empty list', () => {
    expect(() => pickWeightedByPc([], pcOf, {}, seq(0), NOW)).toThrow()
  })
})

describe('createNoteStatsStore', () => {
  it('namespaces under mt:stats: and round-trips data', () => {
    const backend = memoryBackend()
    const store = createNoteStatsStore('fretboard-trainer', backend)
    expect(store.get()).toEqual({})
    const updated = store.update((d) => recordOutcome(d, 9, true, 700, NOW))
    expect(updated[9]?.attempts).toBe(1)
    // Re-read through a fresh store instance on the same backend.
    expect(createNoteStatsStore('fretboard-trainer', backend).get()[9]?.attempts).toBe(1)
    expect(backend.getItem('mt:stats:fretboard-trainer')).not.toBeNull()
  })

  it('discards corrupt same-version data via normalization on migrate', () => {
    const backend = memoryBackend()
    // Old-version blob with junk entries is migrated (normalized).
    backend.setItem(
      'mt:stats:keyboard-trainer',
      JSON.stringify({ v: 0, data: { '0': { attempts: 2, correct: 1, accuracy: 0.5, responseMs: 1, lastSeen: 1 }, bad: 1 } }),
    )
    const out = createNoteStatsStore('keyboard-trainer', backend).get()
    expect(out[0]?.attempts).toBe(2)
    expect(Object.keys(out)).toEqual(['0'])
  })
})
