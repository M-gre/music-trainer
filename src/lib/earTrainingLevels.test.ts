import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  createEarTrainingLevelsProgressStore,
  EAR_TRAINING_LEVELS,
  emptyLevelProgress,
  isLevelUnlocked,
  levelProgressSummary,
  MASTERY_THRESHOLD,
  meetsMasteryBar,
  normalizeLevelProgressMap,
  recommendedLevelId,
  recordAnswer,
  recordLevelAnswer,
  RING_CAPACITY,
  type EarTrainingLevel,
  type LevelProgressMap,
} from './earTrainingLevels.ts'

describe('EAR_TRAINING_LEVELS', () => {
  it('has a non-empty ordered curriculum with unique, stable ids', () => {
    expect(EAR_TRAINING_LEVELS.length).toBeGreaterThanOrEqual(8)
    const ids = EAR_TRAINING_LEVELS.map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const level of EAR_TRAINING_LEVELS) {
      expect(level.title.length).toBeGreaterThan(0)
      expect(level.description.length).toBeGreaterThan(0)
    }
  })

  it('ends with a melodic-echo level and starts with a small interval set', () => {
    const first = EAR_TRAINING_LEVELS[0]!
    const last = EAR_TRAINING_LEVELS[EAR_TRAINING_LEVELS.length - 1]!
    expect(first.task.kind).toBe('interval')
    expect(last.task.kind).toBe('melodic-echo')
  })

  it('every enabled interval/chord-quality/scale set has at least 2 entries', () => {
    for (const level of EAR_TRAINING_LEVELS) {
      if (level.task.kind === 'interval' || level.task.kind === 'scale') {
        expect(level.task.enabled.length).toBeGreaterThanOrEqual(2)
      }
      if (level.task.kind === 'chord-quality') {
        expect(level.task.enabled.length).toBeGreaterThanOrEqual(2)
      }
    }
  })
})

describe('meetsMasteryBar', () => {
  it('is false below the ring capacity regardless of accuracy', () => {
    const recent = Array.from({ length: RING_CAPACITY - 1 }, () => true)
    expect(meetsMasteryBar(recent)).toBe(false)
  })

  it('is true at exactly the threshold (18/20 = 90%)', () => {
    const recent = [...Array.from({ length: 18 }, () => true), false, false]
    expect(recent.length).toBe(RING_CAPACITY)
    expect(meetsMasteryBar(recent)).toBe(true)
  })

  it('is false just below the threshold (17/20 = 85%)', () => {
    const recent = [...Array.from({ length: 17 }, () => true), false, false, false]
    expect(recent.length).toBe(RING_CAPACITY)
    expect(meetsMasteryBar(recent)).toBe(false)
  })

  it('is true for a perfect run', () => {
    const recent = Array.from({ length: RING_CAPACITY }, () => true)
    expect(meetsMasteryBar(recent)).toBe(true)
  })

  it('threshold constant is 0.9', () => {
    expect(MASTERY_THRESHOLD).toBe(0.9)
  })
})

describe('recordAnswer', () => {
  it('appends to the ring buffer without mutating the input', () => {
    const p0 = emptyLevelProgress()
    const p1 = recordAnswer(p0, true)
    expect(p0.recent).toEqual([])
    expect(p1.recent).toEqual([true])
    expect(p1.mastered).toBe(false)
  })

  it('trims the ring buffer to RING_CAPACITY, dropping the oldest first', () => {
    let progress = emptyLevelProgress()
    // Fill with a recognizable ramp: answer i is correct iff i is even.
    for (let i = 0; i < RING_CAPACITY + 5; i += 1) {
      progress = recordAnswer(progress, i % 2 === 0)
    }
    expect(progress.recent.length).toBe(RING_CAPACITY)
    // The buffer should now hold answers 5..24 (0-indexed), i.e. it dropped
    // the first 5 pushed values.
    const expected = Array.from({ length: RING_CAPACITY }, (_, i) => (i + 5) % 2 === 0)
    expect(progress.recent).toEqual(expected)
  })

  it('becomes mastered once the window crosses the threshold', () => {
    let progress = emptyLevelProgress()
    for (let i = 0; i < 18; i += 1) progress = recordAnswer(progress, true)
    expect(progress.mastered).toBe(false) // only 18 answers so far, no full window
    progress = recordAnswer(progress, true) // 19
    expect(progress.mastered).toBe(false)
    progress = recordAnswer(progress, true) // 20/20 = 100%
    expect(progress.mastered).toBe(true)
  })

  it('mastery is sticky: a bad run afterwards does not un-master', () => {
    let progress = emptyLevelProgress()
    for (let i = 0; i < RING_CAPACITY; i += 1) progress = recordAnswer(progress, true)
    expect(progress.mastered).toBe(true)
    for (let i = 0; i < 10; i += 1) progress = recordAnswer(progress, false)
    expect(progress.mastered).toBe(true)
    // The recent window itself does reflect the slump even though mastered stays true.
    expect(progress.recent.filter(Boolean).length).toBeLessThan(RING_CAPACITY)
  })
})

describe('recordLevelAnswer', () => {
  it('creates a fresh entry for a level with no prior progress', () => {
    const map = recordLevelAnswer({}, 'intervals-perfect', true)
    expect(map['intervals-perfect']?.recent).toEqual([true])
  })

  it('does not mutate the input map or touch other levels', () => {
    const map0: LevelProgressMap = { 'triads-basic': { recent: [true], mastered: false } }
    const map1 = recordLevelAnswer(map0, 'intervals-perfect', false)
    expect(map0['intervals-perfect']).toBeUndefined()
    expect(map1['triads-basic']).toEqual(map0['triads-basic'])
    expect(map1['intervals-perfect']?.recent).toEqual([false])
  })
})

// A tiny synthetic curriculum makes the unlock-ordering tests independent of
// the real curriculum's length.
const LEVELS: EarTrainingLevel[] = [
  { id: 'a', title: 'A', description: '', task: { kind: 'interval', enabled: [5, 7], playback: 'melodic-asc' } },
  { id: 'b', title: 'B', description: '', task: { kind: 'interval', enabled: [3, 4], playback: 'melodic-asc' } },
  { id: 'c', title: 'C', description: '', task: { kind: 'interval', enabled: [1, 2], playback: 'melodic-asc' } },
]

function masteredProgress(): LevelProgressMap {
  return {
    a: { recent: Array.from({ length: RING_CAPACITY }, () => true), mastered: true },
  }
}

describe('isLevelUnlocked', () => {
  it('always unlocks the first level, even with no progress at all', () => {
    expect(isLevelUnlocked(LEVELS, {}, 'a')).toBe(true)
  })

  it('locks later levels until every prior level is mastered', () => {
    expect(isLevelUnlocked(LEVELS, {}, 'b')).toBe(false)
    expect(isLevelUnlocked(LEVELS, {}, 'c')).toBe(false)
    expect(isLevelUnlocked(LEVELS, masteredProgress(), 'b')).toBe(true)
    expect(isLevelUnlocked(LEVELS, masteredProgress(), 'c')).toBe(false)
  })

  it('unlocks level c only once both a and b are mastered', () => {
    const progress: LevelProgressMap = {
      a: { recent: [], mastered: true },
      b: { recent: [], mastered: true },
    }
    expect(isLevelUnlocked(LEVELS, progress, 'c')).toBe(true)
  })

  it('treats an unknown id as locked', () => {
    expect(isLevelUnlocked(LEVELS, masteredProgress(), 'nonexistent')).toBe(false)
  })
})

describe('recommendedLevelId', () => {
  it('recommends the first level when nothing is mastered', () => {
    expect(recommendedLevelId(LEVELS, {})).toBe('a')
  })

  it('recommends the next unlocked, unmastered level', () => {
    expect(recommendedLevelId(LEVELS, masteredProgress())).toBe('b')
  })

  it('falls back to the last level once everything is mastered', () => {
    const progress: LevelProgressMap = {
      a: { recent: [], mastered: true },
      b: { recent: [], mastered: true },
      c: { recent: [], mastered: true },
    }
    expect(recommendedLevelId(LEVELS, progress)).toBe('c')
  })

  it('returns null for an empty level list', () => {
    expect(recommendedLevelId([], {})).toBeNull()
  })
})

describe('levelProgressSummary', () => {
  it('reports "No attempts yet" with no progress', () => {
    const summary = levelProgressSummary(undefined)
    expect(summary).toEqual({ attempts: 0, correct: 0, accuracy: null, mastered: false, label: 'No attempts yet' })
  })

  it('formats a partial-progress label', () => {
    const summary = levelProgressSummary({ recent: [true, true, false], mastered: false })
    expect(summary.attempts).toBe(3)
    expect(summary.correct).toBe(2)
    expect(summary.accuracy).toBeCloseTo(2 / 3)
    expect(summary.label).toBe('2/3 recent, 67%')
  })

  it('reports "Mastered" once the mastered flag is set, regardless of the recent window', () => {
    const summary = levelProgressSummary({ recent: [false, false], mastered: true })
    expect(summary.mastered).toBe(true)
    expect(summary.label).toBe('Mastered')
  })
})

describe('normalizeLevelProgressMap', () => {
  it('returns {} for non-object input', () => {
    expect(normalizeLevelProgressMap(null)).toEqual({})
    expect(normalizeLevelProgressMap(undefined)).toEqual({})
    expect(normalizeLevelProgressMap('nonsense')).toEqual({})
  })

  it('drops unknown level ids and malformed entries', () => {
    const result = normalizeLevelProgressMap(
      {
        a: { recent: [true, false], mastered: false },
        unknown: { recent: [true], mastered: true },
        b: 'not an object',
      },
      LEVELS,
    )
    expect(result).toEqual({ a: { recent: [true, false], mastered: false } })
  })

  it('filters non-boolean entries out of recent and caps it at RING_CAPACITY', () => {
    const recent = [...Array.from({ length: RING_CAPACITY + 3 }, () => true), 'x', 1, null]
    const result = normalizeLevelProgressMap({ a: { recent, mastered: false } }, LEVELS)
    expect(result.a?.recent.length).toBe(RING_CAPACITY)
    expect(result.a?.recent.every((v) => v === true)).toBe(true)
  })

  it('derives mastered from the recent window when the stored flag is missing/invalid', () => {
    const fullTrue = Array.from({ length: RING_CAPACITY }, () => true)
    const result = normalizeLevelProgressMap({ a: { recent: fullTrue } }, LEVELS)
    expect(result.a?.mastered).toBe(true)
  })
})

describe('createEarTrainingLevelsProgressStore (migration/default)', () => {
  it('defaults to an empty progress map when nothing is stored', () => {
    const store = createEarTrainingLevelsProgressStore(memoryBackend())
    expect(store.get()).toEqual({})
  })

  it('round-trips a progress map through get/set', () => {
    const backend = memoryBackend()
    const store = createEarTrainingLevelsProgressStore(backend)
    const map = recordLevelAnswer({}, 'intervals-perfect', true)
    store.set(map)
    expect(store.get()).toEqual(map)
  })

  it('falls back to the default value for data stored under a newer/incompatible version', () => {
    const backend = memoryBackend()
    // Simulate a future-versioned envelope this build doesn't know how to read.
    backend.setItem('mt:progress:ear-training:levels', JSON.stringify({ v: 999, data: { bogus: true } }))
    const store = createEarTrainingLevelsProgressStore(backend)
    expect(store.get()).toEqual({})
  })

  it('is isolated per backend instance (no cross-test leakage via the shared app-wide store)', () => {
    const store1 = createEarTrainingLevelsProgressStore(memoryBackend())
    const store2 = createEarTrainingLevelsProgressStore(memoryBackend())
    store1.set(recordLevelAnswer({}, 'a', true))
    expect(store2.get()).toEqual({})
  })
})
