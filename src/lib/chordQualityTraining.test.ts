import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import type { Rng } from './quiz.ts'
import { getChordQuality } from './theory/chords.ts'
import {
  accumulateStat,
  accuracy,
  ALL_QUALITY_IDS,
  checkChordQualityAnswer,
  chordQualitySrsKey,
  CHORD_QUALITY_PRESETS,
  createChordQualitySettingsStore,
  createChordQualityStatsStore,
  DEFAULT_CHORD_QUALITY_SETTINGS,
  generateChordQualityQuestion,
  inversionLabel,
  MIN_ENABLED,
  normalizeChordQualityStats,
  normalizeChordQualityTrainingSettings,
  normalizeEnabledQualities,
  pickChordRoot,
  pickInversion,
  qualityLabel,
  qualityShort,
  questionArpeggioSteps,
  questionVoicingMidis,
  sortQualityIds,
  toggleQuality,
  type ChordQualityContext,
  type ChordQualityQuestion,
} from './chordQualityTraining.ts'
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

describe('qualityLabel / qualityShort', () => {
  it('includes the symbol in parentheses when present', () => {
    expect(qualityLabel(getChordQuality('min7'))).toBe('Minor 7th (m7)')
    expect(qualityLabel(getChordQuality('dim'))).toBe('Diminished (dim)')
  })

  it('omits the parenthetical for major (no symbol)', () => {
    expect(qualityLabel(getChordQuality('maj'))).toBe('Major')
  })

  it('short tag falls back to "maj" for the symbol-less major quality', () => {
    expect(qualityShort(getChordQuality('maj'))).toBe('maj')
    expect(qualityShort(getChordQuality('min7'))).toBe('m7')
    expect(qualityShort(getChordQuality('dom7'))).toBe('7')
  })
})

describe('sortQualityIds', () => {
  it('sorts ids into canonical CHORD_QUALITIES order regardless of input order', () => {
    expect(sortQualityIds(['dim', 'maj', 'aug', 'min'])).toEqual(['maj', 'min', 'dim', 'aug'])
  })
})

describe('CHORD_QUALITY_PRESETS', () => {
  it('has three presets: triads, triads+sevenths, all', () => {
    expect(CHORD_QUALITY_PRESETS.map((p) => p.id)).toEqual(['triads', 'triads-sevenths', 'all'])
  })

  it('triads preset is the default set and has exactly 4 qualities', () => {
    const triads = CHORD_QUALITY_PRESETS.find((p) => p.id === 'triads')!
    expect(triads.qualityIds).toEqual(['maj', 'min', 'dim', 'aug'])
    expect(triads.qualityIds).toEqual(DEFAULT_CHORD_QUALITY_SETTINGS.enabled)
  })

  it('triads+sevenths adds exactly the five seventh qualities', () => {
    const preset = CHORD_QUALITY_PRESETS.find((p) => p.id === 'triads-sevenths')!
    expect(preset.qualityIds).toEqual(['maj', 'min', 'dim', 'aug', 'maj7', 'min7', 'dom7', 'min7b5', 'dim7'])
  })

  it('all preset covers every selectable quality', () => {
    const preset = CHORD_QUALITY_PRESETS.find((p) => p.id === 'all')!
    expect(preset.qualityIds).toEqual([...ALL_QUALITY_IDS])
    expect(preset.qualityIds.length).toBeGreaterThan(9)
  })

  it('the default set satisfies the minimum', () => {
    expect(DEFAULT_CHORD_QUALITY_SETTINGS.enabled.length).toBeGreaterThanOrEqual(MIN_ENABLED)
  })
})

describe('pickChordRoot', () => {
  it('stays within 0..11', () => {
    const rng = seq([0, 0.25, 0.5, 0.75, 0.999])
    for (let i = 0; i < 5; i += 1) {
      const pc = pickChordRoot(rng)
      expect(pc).toBeGreaterThanOrEqual(0)
      expect(pc).toBeLessThanOrEqual(11)
    }
  })

  it('returns 0 at rng=0 and 11 at rng→1', () => {
    expect(pickChordRoot(() => 0)).toBe(0)
    expect(pickChordRoot(() => 0.9999)).toBe(11)
  })
})

describe('pickInversion', () => {
  it('always returns 0 when count <= 1', () => {
    expect(pickInversion(() => 0.9, 1)).toBe(0)
    expect(pickInversion(() => 0.9, 0)).toBe(0)
  })

  it('stays within [0, count)', () => {
    const rng = seq([0, 0.3, 0.6, 0.9, 0.999])
    for (let i = 0; i < 5; i += 1) {
      const inv = pickInversion(rng, 4)
      expect(inv).toBeGreaterThanOrEqual(0)
      expect(inv).toBeLessThan(4)
    }
  })

  it('returns 0 at rng=0 and count-1 at rng→1', () => {
    expect(pickInversion(() => 0, 3)).toBe(0)
    expect(pickInversion(() => 0.9999, 3)).toBe(2)
  })
})

describe('generateChordQualityQuestion', () => {
  const ctx: ChordQualityContext = { enabled: ['maj', 'min', 'dim'], inversions: false }

  it('only produces enabled qualities', () => {
    const rng = seq([0.1, 0.2, 0.4, 0.6, 0.8, 0.95])
    let prev: ChordQualityQuestion | null = null
    for (let i = 0; i < 30; i += 1) {
      const q = generateChordQualityQuestion(ctx, prev, rng)
      expect(ctx.enabled).toContain(q.qualityId)
      prev = q
    }
  })

  it('keeps the root within 0..11', () => {
    const rng = seq([0.3, 0.7, 0.1, 0.9, 0.5])
    for (let i = 0; i < 20; i += 1) {
      const q = generateChordQualityQuestion(ctx, null, rng)
      expect(q.root).toBeGreaterThanOrEqual(0)
      expect(q.root).toBeLessThanOrEqual(11)
    }
  })

  it('avoids an immediate quality repeat when more than one is enabled', () => {
    const rng = seq([0.05, 0.2, 0.3, 0.6, 0.9, 0.45])
    let prev: ChordQualityQuestion | null = null
    for (let i = 0; i < 40; i += 1) {
      const q = generateChordQualityQuestion(ctx, prev, rng)
      if (prev) expect(q.qualityId).not.toBe(prev.qualityId)
      prev = q
    }
  })

  it('may repeat when only one quality is enabled', () => {
    const single: ChordQualityContext = { enabled: ['maj7'], inversions: false }
    const prev: ChordQualityQuestion = { root: 0, qualityId: 'maj7', inversion: 0 }
    const q = generateChordQualityQuestion(single, prev, () => 0.5)
    expect(q.qualityId).toBe('maj7')
  })

  it('stays at root position (inversion 0) when the inversions setting is off', () => {
    const rng = seq([0.1, 0.9, 0.5, 0.2, 0.8])
    for (let i = 0; i < 20; i += 1) {
      const q = generateChordQualityQuestion(ctx, null, rng)
      expect(q.inversion).toBe(0)
    }
  })

  it('produces varied inversions across a seventh quality when the setting is on', () => {
    const inversionsCtx: ChordQualityContext = { enabled: ['maj7'], inversions: true }
    // rng usage order per call: quality pick, root pick, inversion pick.
    const invs = [0, 0.3, 0.6, 0.9].map(
      (v) => generateChordQualityQuestion(inversionsCtx, null, seq([0, 0, v])).inversion,
    )
    for (const inv of invs) {
      expect(inv).toBeGreaterThanOrEqual(0)
      expect(inv).toBeLessThan(4) // maj7 has 4 chord tones -> 4 inversions
    }
    expect(new Set(invs).size).toBeGreaterThan(1)
  })

  it('throws when nothing is enabled', () => {
    expect(() =>
      generateChordQualityQuestion({ enabled: [], inversions: false }, null, () => 0),
    ).toThrow()
  })
})

describe('chordQualitySrsKey', () => {
  it('is the quality id (inversion never part of the schedule)', () => {
    expect(chordQualitySrsKey('min7')).toBe('min7')
    expect(chordQualitySrsKey('dim')).toBe('dim')
  })
})

describe('generateChordQualityQuestion — SRS-influenced picking', () => {
  const NOW = 1_000_000
  const ctx: ChordQualityContext = { enabled: ['maj', 'min', 'dim', 'aug'], inversions: false }

  function counts(srs: SrsData, n: number): Map<string, number> {
    const rng = lcg(24680)
    const out = new Map<string, number>()
    for (let i = 0; i < n; i += 1) {
      const q = generateChordQualityQuestion(ctx, null, rng, { srs, now: NOW })
      out.set(q.qualityId, (out.get(q.qualityId) ?? 0) + 1)
    }
    return out
  }

  it('only produces enabled qualities when picking', () => {
    const rng = lcg(3)
    let prev: ChordQualityQuestion | null = null
    for (let i = 0; i < 40; i += 1) {
      const q = generateChordQualityQuestion(ctx, prev, rng, { srs: {}, now: NOW })
      expect(ctx.enabled).toContain(q.qualityId)
      prev = q
    }
  })

  it('avoids an immediate repeat when picking with more than one enabled', () => {
    const rng = lcg(11)
    let prev: ChordQualityQuestion | null = null
    for (let i = 0; i < 60; i += 1) {
      const q = generateChordQualityQuestion(ctx, prev, rng, { srs: {}, now: NOW })
      if (prev) expect(q.qualityId).not.toBe(prev.qualityId)
      prev = q
    }
  })

  it('favors an overdue quality over one not yet due', () => {
    const srs: SrsData = {
      dim: srsItem(NOW - 5 * STEP_MS), // very overdue
      maj: srsItem(NOW + 100 * STEP_MS),
      min: srsItem(NOW + 100 * STEP_MS),
      aug: srsItem(NOW + 100 * STEP_MS),
    }
    const c = counts(srs, 4000)
    expect(c.get('dim') ?? 0).toBeGreaterThan((c.get('maj') ?? 0) * 3)
  })

  it('favors never-seen qualities over one not yet due', () => {
    const srs: SrsData = { maj: srsItem(NOW + 100 * STEP_MS) }
    const c = counts(srs, 4000)
    const newAvg = ['min', 'dim', 'aug'].reduce((sum, id) => sum + (c.get(id) ?? 0), 0) / 3
    expect(newAvg).toBeGreaterThan((c.get('maj') ?? 0) * 2)
  })
})

describe('checkChordQualityAnswer', () => {
  const q: ChordQualityQuestion = { root: 0, qualityId: 'min7', inversion: 0 }
  it('accepts the matching quality id', () => {
    expect(checkChordQualityAnswer(q, 'min7')).toBe(true)
  })
  it('rejects a different quality id', () => {
    expect(checkChordQualityAnswer(q, 'maj7')).toBe(false)
  })
})

describe('questionVoicingMidis', () => {
  it('root position matches chordExplorer voicing anchored at middle C', () => {
    const q: ChordQualityQuestion = { root: 0, qualityId: 'maj', inversion: 0 }
    // C major triad, root position, anchored at C4 (60): C4 E4 G4.
    expect(questionVoicingMidis(q)).toEqual([60, 64, 67])
  })

  it('inversion moves the bottom tones up an octave', () => {
    const q: ChordQualityQuestion = { root: 0, qualityId: 'maj', inversion: 1 }
    // 1st inversion: root moves up an octave -> E4 G4 C5.
    expect(questionVoicingMidis(q)).toEqual([64, 67, 72])
  })

  it('transposes by the question root pitch class', () => {
    const q: ChordQualityQuestion = { root: 4, qualityId: 'maj', inversion: 0 }
    // E major triad root position: E4 G#4 B4.
    expect(questionVoicingMidis(q)).toEqual([64, 68, 71])
  })
})

describe('questionArpeggioSteps', () => {
  it('sequences the voicing ascending then descending (dropping the repeated top note)', () => {
    const q: ChordQualityQuestion = { root: 0, qualityId: 'maj', inversion: 0 }
    const steps = questionArpeggioSteps(q, 0.25, 0, true)
    expect(steps).toEqual([
      { midi: 60, when: 0 },
      { midi: 64, when: 0.25 },
      { midi: 67, when: 0.5 },
      { midi: 64, when: 0.75 },
      { midi: 60, when: 1 },
    ])
  })

  it('omits the descent when descend is false', () => {
    const q: ChordQualityQuestion = { root: 0, qualityId: 'maj', inversion: 0 }
    const steps = questionArpeggioSteps(q, 0.25, 0, false)
    expect(steps).toEqual([
      { midi: 60, when: 0 },
      { midi: 64, when: 0.25 },
      { midi: 67, when: 0.5 },
    ])
  })
})

describe('inversionLabel', () => {
  it('labels the first four inversions by name', () => {
    expect(inversionLabel(0)).toBe('Root position')
    expect(inversionLabel(1)).toBe('1st inversion')
    expect(inversionLabel(2)).toBe('2nd inversion')
    expect(inversionLabel(3)).toBe('3rd inversion')
  })

  it('falls back to an nth-inversion label beyond that', () => {
    expect(inversionLabel(4)).toBe('4th inversion')
  })
})

describe('accumulateStat / accuracy', () => {
  it('folds attempts and correct hits without mutating the input', () => {
    const empty = {}
    const a = accumulateStat(empty, 'min7', true)
    const b = accumulateStat(a, 'min7', false)
    expect(empty).toEqual({})
    expect(a['min7']).toEqual({ attempts: 1, correct: 1 })
    expect(b['min7']).toEqual({ attempts: 2, correct: 1 })
  })

  it('tracks qualities independently', () => {
    let s = accumulateStat({}, 'maj', true)
    s = accumulateStat(s, 'dim7', false)
    expect(s['maj']).toEqual({ attempts: 1, correct: 1 })
    expect(s['dim7']).toEqual({ attempts: 1, correct: 0 })
  })

  it('accuracy is correct/attempts, or null with no attempts', () => {
    expect(accuracy(undefined)).toBeNull()
    expect(accuracy({ attempts: 0, correct: 0 })).toBeNull()
    expect(accuracy({ attempts: 4, correct: 3 })).toBeCloseTo(0.75)
  })
})

describe('normalizeChordQualityStats', () => {
  it('drops unknown ids, non-objects, and zero-attempt entries', () => {
    expect(
      normalizeChordQualityStats({
        maj: { attempts: 3, correct: 2 },
        bogus: { attempts: 5, correct: 1 }, // unknown id
        dim: { attempts: 0, correct: 0 }, // no attempts
        min: 'nope',
      }),
    ).toEqual({ maj: { attempts: 3, correct: 2 } })
  })

  it('clamps correct to attempts and floors negatives', () => {
    expect(normalizeChordQualityStats({ maj: { attempts: 2, correct: 9 } })).toEqual({
      maj: { attempts: 2, correct: 2 },
    })
    expect(normalizeChordQualityStats({ maj: { attempts: 3, correct: -1 } })).toEqual({
      maj: { attempts: 3, correct: 0 },
    })
  })

  it('returns empty for non-object input', () => {
    expect(normalizeChordQualityStats(null)).toEqual({})
    expect(normalizeChordQualityStats('x')).toEqual({})
  })
})

describe('normalizeEnabledQualities', () => {
  it('dedupes, sorts canonically and drops unknown ids', () => {
    expect(normalizeEnabledQualities(['dim', 'dim', 'maj', 'bogus', 'aug'])).toEqual([
      'maj',
      'dim',
      'aug',
    ])
  })

  it('falls back to defaults below the minimum enabled count', () => {
    expect(normalizeEnabledQualities(['maj'])).toEqual([...DEFAULT_CHORD_QUALITY_SETTINGS.enabled])
    expect(normalizeEnabledQualities([])).toEqual([...DEFAULT_CHORD_QUALITY_SETTINGS.enabled])
    expect(normalizeEnabledQualities('nope')).toEqual([...DEFAULT_CHORD_QUALITY_SETTINGS.enabled])
  })
})

describe('normalizeChordQualityTrainingSettings', () => {
  it('passes through valid settings', () => {
    const value = { enabled: ['maj', 'min'], inversions: true }
    expect(normalizeChordQualityTrainingSettings(value)).toEqual(value)
  })

  it('repairs bad inversions and enabled fields', () => {
    expect(normalizeChordQualityTrainingSettings({ enabled: ['maj'], inversions: 'bogus' })).toEqual(
      DEFAULT_CHORD_QUALITY_SETTINGS,
    )
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeChordQualityTrainingSettings(null)).toEqual(DEFAULT_CHORD_QUALITY_SETTINGS)
  })
})

describe('toggleQuality', () => {
  it('adds and removes qualities, keeping the set canonically ordered', () => {
    expect(toggleQuality(['maj', 'min'], 'dim')).toEqual(['maj', 'min', 'dim'])
    expect(toggleQuality(['maj', 'min', 'dim'], 'min')).toEqual(['maj', 'dim'])
  })

  it('never drops below the minimum enabled count', () => {
    expect(toggleQuality(['maj', 'min'], 'min')).toEqual(['maj', 'min'])
  })

  it('covers every selectable quality (14 total qualities in theory/chords.ts)', () => {
    expect(ALL_QUALITY_IDS).toHaveLength(14)
  })
})

describe('settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createChordQualitySettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_CHORD_QUALITY_SETTINGS)
  })

  it('round-trips settings across instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { enabled: ['maj', 'min', 'maj7'], inversions: true }
    createChordQualitySettingsStore(backend).set(value)
    expect(createChordQualitySettingsStore(backend).get()).toEqual(value)
  })
})

describe('chord quality stats store', () => {
  it('defaults to empty stats', () => {
    const store = createChordQualityStatsStore(memoryBackend())
    expect(store.get()).toEqual({})
  })

  it('round-trips accumulated stats', () => {
    const backend = memoryBackend()
    let stats = accumulateStat({}, 'min7', true)
    stats = accumulateStat(stats, 'min7', false)
    createChordQualityStatsStore(backend).set(stats)
    const loaded = createChordQualityStatsStore(backend).get()
    expect(normalizeChordQualityStats(loaded)['min7']).toEqual({ attempts: 2, correct: 1 })
  })
})
