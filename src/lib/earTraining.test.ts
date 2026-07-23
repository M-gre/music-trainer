import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import type { Rng } from './quiz.ts'
import {
  accumulateStat,
  accuracy,
  ALL_INTERVAL_SEMITONES,
  checkIntervalAnswer,
  createEarTrainingSettingsStore,
  createIntervalStatsStore,
  DEFAULT_EAR_TRAINING_SETTINGS,
  DEFAULT_NOTE_GAP,
  generateIntervalQuestion,
  intervalBySemitones,
  intervalSrsKey,
  MIN_ENABLED,
  normalizeEarTrainingSettings,
  normalizeEnabled,
  normalizeStats,
  pickRoot,
  resolvePlaybackMode,
  ROOT_MAX,
  ROOT_MIN,
  scheduleQuestion,
  toggleInterval,
  type IntervalQuestion,
  type QuestionContext,
} from './earTraining.ts'
import { STEP_MS, type SrsData, type SrsItem } from './spacedRepetition.ts'

/** Deterministic rng cycling through the given values in [0,1). */
function seq(values: number[]): Rng {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

/** A seeded LCG for distribution tests — deterministic but well-spread. */
function lcg(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

/** A reviewed SRS item due at `due` (reviewed once, seen at `due`). */
function srsItem(due: number): SrsItem {
  return { interval: 1, ease: 2.5, due, lapses: 0, reps: 1, lastSeen: due }
}

describe('intervalBySemitones', () => {
  it('maps semitone counts to interval records', () => {
    expect(intervalBySemitones(7).short).toBe('P5')
    expect(intervalBySemitones(0).name).toBe('Unison')
    expect(intervalBySemitones(12).short).toBe('P8')
  })

  it('throws for an unknown interval', () => {
    expect(() => intervalBySemitones(13)).toThrow()
  })
})

describe('pickRoot', () => {
  it('stays within the register bounds', () => {
    const rng = seq([0, 0.25, 0.5, 0.75, 0.999])
    for (let i = 0; i < 5; i += 1) {
      const midi = pickRoot(rng)
      expect(midi).toBeGreaterThanOrEqual(ROOT_MIN)
      expect(midi).toBeLessThanOrEqual(ROOT_MAX)
    }
  })

  it('returns the min at rng=0 and the max at rng→1', () => {
    expect(pickRoot(() => 0)).toBe(ROOT_MIN)
    expect(pickRoot(() => 0.9999)).toBe(ROOT_MAX)
  })

  it('honors custom bounds and clamps a degenerate range', () => {
    expect(pickRoot(() => 0.5, 60, 60)).toBe(60)
    expect(pickRoot(() => 0.5, 60, 50)).toBe(60)
  })
})

describe('resolvePlaybackMode', () => {
  it('passes through a concrete mode', () => {
    expect(resolvePlaybackMode('harmonic', () => 0.5)).toBe('harmonic')
    expect(resolvePlaybackMode('melodic-desc', () => 0.5)).toBe('melodic-desc')
  })

  it('resolves random to one of the three concrete modes', () => {
    expect(resolvePlaybackMode('random', () => 0)).toBe('melodic-asc')
    expect(resolvePlaybackMode('random', () => 0.5)).toBe('melodic-desc')
    expect(resolvePlaybackMode('random', () => 0.999)).toBe('harmonic')
  })
})

describe('generateIntervalQuestion', () => {
  const ctx: QuestionContext = { enabled: [5, 7, 12], playback: 'melodic-asc' }

  it('only produces enabled intervals', () => {
    const rng = seq([0.1, 0.2, 0.4, 0.6, 0.8, 0.95])
    let prev: IntervalQuestion | null = null
    for (let i = 0; i < 30; i += 1) {
      const q = generateIntervalQuestion(ctx, prev, rng)
      expect(ctx.enabled).toContain(q.semitones)
      prev = q
    }
  })

  it('keeps the root inside the register', () => {
    const rng = seq([0.3, 0.7, 0.1, 0.9, 0.5])
    for (let i = 0; i < 20; i += 1) {
      const q = generateIntervalQuestion(ctx, null, rng)
      expect(q.rootMidi).toBeGreaterThanOrEqual(ROOT_MIN)
      expect(q.rootMidi).toBeLessThanOrEqual(ROOT_MAX)
    }
  })

  it('avoids an immediate interval repeat when more than one is enabled', () => {
    const rng = seq([0.05, 0.2, 0.3, 0.6, 0.9, 0.45])
    let prev: IntervalQuestion | null = null
    for (let i = 0; i < 40; i += 1) {
      const q = generateIntervalQuestion(ctx, prev, rng)
      if (prev) expect(q.semitones).not.toBe(prev.semitones)
      prev = q
    }
  })

  it('may repeat when only one interval is enabled', () => {
    const single: QuestionContext = { enabled: [7], playback: 'harmonic' }
    const prev: IntervalQuestion = { rootMidi: 60, semitones: 7, mode: 'harmonic' }
    const q = generateIntervalQuestion(single, prev, () => 0.5)
    expect(q.semitones).toBe(7)
  })

  it('resolves a per-question mode when playback is random', () => {
    const randomCtx: QuestionContext = { enabled: [5, 7], playback: 'random' }
    // rng usage order: interval pick, root pick, mode pick.
    const q = generateIntervalQuestion(randomCtx, null, seq([0, 0.5, 0.999]))
    expect(q.mode).toBe('harmonic')
  })

  it('throws when nothing is enabled', () => {
    expect(() =>
      generateIntervalQuestion({ enabled: [], playback: 'harmonic' }, null, () => 0),
    ).toThrow()
  })
})

describe('intervalSrsKey', () => {
  it('combines the semitone count and the playback mode', () => {
    expect(intervalSrsKey(7, 'melodic-asc')).toBe('7:melodic-asc')
    expect(intervalSrsKey(7, 'melodic-desc')).toBe('7:melodic-desc')
    expect(intervalSrsKey(7, 'harmonic')).toBe('7:harmonic')
  })

  it('separates the same interval by direction/voicing', () => {
    expect(intervalSrsKey(3, 'melodic-asc')).not.toBe(intervalSrsKey(3, 'melodic-desc'))
  })
})

describe('generateIntervalQuestion — SRS-influenced picking', () => {
  const NOW = 1_000_000
  const ctx: QuestionContext = { enabled: [3, 5, 7, 12], playback: 'melodic-asc' }

  /** Count which intervals get picked over `n` draws (no immediate-repeat filter). */
  function counts(srs: SrsData, n: number): Map<number, number> {
    const rng = lcg(98765)
    const out = new Map<number, number>()
    for (let i = 0; i < n; i += 1) {
      const q = generateIntervalQuestion(ctx, null, rng, { srs, now: NOW })
      out.set(q.semitones, (out.get(q.semitones) ?? 0) + 1)
    }
    return out
  }

  it('only produces enabled intervals when picking', () => {
    const rng = lcg(1)
    let prev: IntervalQuestion | null = null
    for (let i = 0; i < 40; i += 1) {
      const q = generateIntervalQuestion(ctx, prev, rng, { srs: {}, now: NOW })
      expect(ctx.enabled).toContain(q.semitones)
      prev = q
    }
  })

  it('avoids an immediate repeat when picking with more than one enabled', () => {
    const rng = lcg(7)
    let prev: IntervalQuestion | null = null
    for (let i = 0; i < 60; i += 1) {
      const q = generateIntervalQuestion(ctx, prev, rng, { srs: {}, now: NOW })
      if (prev) expect(q.semitones).not.toBe(prev.semitones)
      prev = q
    }
  })

  it('favors an overdue interval over one not yet due', () => {
    // Key is per (interval, mode); playback is fixed to melodic-asc here.
    const srs: SrsData = {
      [intervalSrsKey(3, 'melodic-asc')]: srsItem(NOW - 5 * STEP_MS), // very overdue
      [intervalSrsKey(5, 'melodic-asc')]: srsItem(NOW + 100 * STEP_MS), // not due for ages
      [intervalSrsKey(7, 'melodic-asc')]: srsItem(NOW + 100 * STEP_MS),
      [intervalSrsKey(12, 'melodic-asc')]: srsItem(NOW + 100 * STEP_MS),
    }
    const c = counts(srs, 4000)
    expect(c.get(3) ?? 0).toBeGreaterThan((c.get(5) ?? 0) * 3)
  })

  it('favors a never-seen interval over one not yet due', () => {
    const srs: SrsData = {
      // 3, 7, 12 are new (missing); 5 was just reviewed and is far from due.
      [intervalSrsKey(5, 'melodic-asc')]: srsItem(NOW + 100 * STEP_MS),
    }
    const c = counts(srs, 4000)
    const newAvg = [3, 7, 12].reduce((sum, s) => sum + (c.get(s) ?? 0), 0) / 3
    expect(newAvg).toBeGreaterThan((c.get(5) ?? 0) * 2)
  })
})

describe('checkIntervalAnswer', () => {
  const q: IntervalQuestion = { rootMidi: 60, semitones: 7, mode: 'melodic-asc' }
  it('accepts the matching semitone count', () => {
    expect(checkIntervalAnswer(q, 7)).toBe(true)
  })
  it('rejects a different semitone count', () => {
    expect(checkIntervalAnswer(q, 5)).toBe(false)
    expect(checkIntervalAnswer(q, 12)).toBe(false)
  })
})

describe('scheduleQuestion', () => {
  it('ascending: low then high a gap later', () => {
    const q: IntervalQuestion = { rootMidi: 60, semitones: 7, mode: 'melodic-asc' }
    expect(scheduleQuestion(q, 0.5)).toEqual([
      { midi: 60, when: 0 },
      { midi: 67, when: 0.5 },
    ])
  })

  it('descending: high then low a gap later', () => {
    const q: IntervalQuestion = { rootMidi: 60, semitones: 7, mode: 'melodic-desc' }
    expect(scheduleQuestion(q, 0.5)).toEqual([
      { midi: 67, when: 0 },
      { midi: 60, when: 0.5 },
    ])
  })

  it('harmonic: both notes at offset 0', () => {
    const q: IntervalQuestion = { rootMidi: 60, semitones: 12, mode: 'harmonic' }
    expect(scheduleQuestion(q)).toEqual([
      { midi: 60, when: 0 },
      { midi: 72, when: 0 },
    ])
  })

  it('defaults the gap to DEFAULT_NOTE_GAP', () => {
    const q: IntervalQuestion = { rootMidi: 60, semitones: 4, mode: 'melodic-asc' }
    const [, second] = scheduleQuestion(q)
    expect(second?.when).toBe(DEFAULT_NOTE_GAP)
  })

  it('repeats the same pitch for a unison', () => {
    const q: IntervalQuestion = { rootMidi: 55, semitones: 0, mode: 'harmonic' }
    expect(scheduleQuestion(q)).toEqual([
      { midi: 55, when: 0 },
      { midi: 55, when: 0 },
    ])
  })
})

describe('accumulateStat / accuracy', () => {
  it('folds attempts and correct hits without mutating the input', () => {
    const empty = {}
    const a = accumulateStat(empty, 7, true)
    const b = accumulateStat(a, 7, false)
    expect(empty).toEqual({})
    expect(a[7]).toEqual({ attempts: 1, correct: 1 })
    expect(b[7]).toEqual({ attempts: 2, correct: 1 })
  })

  it('tracks intervals independently', () => {
    let s = accumulateStat({}, 5, true)
    s = accumulateStat(s, 12, false)
    expect(s[5]).toEqual({ attempts: 1, correct: 1 })
    expect(s[12]).toEqual({ attempts: 1, correct: 0 })
  })

  it('accuracy is correct/attempts, or null with no attempts', () => {
    expect(accuracy(undefined)).toBeNull()
    expect(accuracy({ attempts: 0, correct: 0 })).toBeNull()
    expect(accuracy({ attempts: 4, correct: 3 })).toBeCloseTo(0.75)
  })
})

describe('normalizeStats', () => {
  it('drops invalid keys, non-objects, and zero-attempt entries', () => {
    expect(
      normalizeStats({
        7: { attempts: 3, correct: 2 },
        13: { attempts: 5, correct: 1 }, // out of range
        foo: { attempts: 2, correct: 1 }, // non-numeric key
        4: { attempts: 0, correct: 0 }, // no attempts
        5: 'nope',
      }),
    ).toEqual({ 7: { attempts: 3, correct: 2 } })
  })

  it('clamps correct to attempts and floors negatives', () => {
    expect(normalizeStats({ 5: { attempts: 2, correct: 9 } })).toEqual({
      5: { attempts: 2, correct: 2 },
    })
    expect(normalizeStats({ 5: { attempts: 3, correct: -1 } })).toEqual({
      5: { attempts: 3, correct: 0 },
    })
  })

  it('returns empty for non-object input', () => {
    expect(normalizeStats(null)).toEqual({})
    expect(normalizeStats('x')).toEqual({})
  })
})

describe('normalizeEnabled', () => {
  it('dedupes, sorts and keeps only 0..12', () => {
    expect(normalizeEnabled([7, 7, 5, 12, 99, -1, 3.5])).toEqual([5, 7, 12])
  })

  it('falls back to defaults below the minimum enabled count', () => {
    expect(normalizeEnabled([7])).toEqual([...DEFAULT_EAR_TRAINING_SETTINGS.enabled])
    expect(normalizeEnabled([])).toEqual([...DEFAULT_EAR_TRAINING_SETTINGS.enabled])
    expect(normalizeEnabled('nope')).toEqual([...DEFAULT_EAR_TRAINING_SETTINGS.enabled])
  })

  it('the default set satisfies the minimum', () => {
    expect(DEFAULT_EAR_TRAINING_SETTINGS.enabled.length).toBeGreaterThanOrEqual(MIN_ENABLED)
  })
})

describe('normalizeEarTrainingSettings', () => {
  it('passes through valid settings', () => {
    const value = { enabled: [3, 4], playback: 'harmonic' as const }
    expect(normalizeEarTrainingSettings(value)).toEqual(value)
  })

  it('repairs bad playback and enabled fields', () => {
    expect(normalizeEarTrainingSettings({ enabled: [7], playback: 'bogus' })).toEqual(
      DEFAULT_EAR_TRAINING_SETTINGS,
    )
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeEarTrainingSettings(null)).toEqual(DEFAULT_EAR_TRAINING_SETTINGS)
  })
})

describe('toggleInterval', () => {
  it('adds and removes intervals, keeping the set sorted', () => {
    expect(toggleInterval([5, 7], 3)).toEqual([3, 5, 7])
    expect(toggleInterval([3, 5, 7], 5)).toEqual([3, 7])
  })

  it('never drops below the minimum enabled count', () => {
    expect(toggleInterval([5, 7], 7)).toEqual([5, 7])
  })

  it('covers the full interval set', () => {
    expect(ALL_INTERVAL_SEMITONES).toHaveLength(13)
  })
})

describe('settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createEarTrainingSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_EAR_TRAINING_SETTINGS)
  })

  it('round-trips settings across instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { enabled: [3, 4, 7], playback: 'random' as const }
    createEarTrainingSettingsStore(backend).set(value)
    expect(createEarTrainingSettingsStore(backend).get()).toEqual(value)
  })
})

describe('interval stats store', () => {
  it('defaults to empty stats', () => {
    const store = createIntervalStatsStore(memoryBackend())
    expect(store.get()).toEqual({})
  })

  it('round-trips accumulated stats', () => {
    const backend = memoryBackend()
    let stats = accumulateStat({}, 7, true)
    stats = accumulateStat(stats, 7, false)
    createIntervalStatsStore(backend).set(stats)
    const loaded = createIntervalStatsStore(backend).get()
    // JSON turns numeric keys into strings; normalizeStats reads them back.
    expect(normalizeStats(loaded)[7]).toEqual({ attempts: 2, correct: 1 })
  })
})
