import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import type { Rng } from './quiz.ts'
import { getScale } from './theory/scales.ts'
import {
  accumulateStat,
  accuracy,
  ALL_SCALE_IDS,
  checkScaleAnswer,
  createScaleSettingsStore,
  createScaleStatsStore,
  DEFAULT_SCALE_STEP_SECONDS,
  DEFAULT_SCALE_TRAINING_SETTINGS,
  generateScaleQuestion,
  MIN_ENABLED,
  normalizeEnabledScales,
  normalizeScaleStats,
  normalizeScaleTrainingSettings,
  pickScaleRoot,
  questionScaleMidis,
  questionScaleSteps,
  ROOT_MAX,
  ROOT_MIN,
  scaleLabel,
  scaleShort,
  scaleSrsKey,
  SCALE_PRESETS,
  sortScaleIds,
  toggleScale,
  type ScaleQuestion,
  type ScaleQuestionContext,
} from './scaleRecognitionTraining.ts'
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

describe('scaleLabel / scaleShort', () => {
  it('label is the full scale name', () => {
    expect(scaleLabel(getScale('major'))).toBe('Major (Ionian)')
    expect(scaleLabel(getScale('harmonic-minor'))).toBe('Harmonic Minor')
  })

  it('short tag is a compact abbreviation', () => {
    expect(scaleShort(getScale('major'))).toBe('Major')
    expect(scaleShort(getScale('mixolydian'))).toBe('Mixo.')
    expect(scaleShort(getScale('blues'))).toBe('Blues')
  })
})

describe('ALL_SCALE_IDS', () => {
  it('excludes the chromatic scale', () => {
    expect(ALL_SCALE_IDS).not.toContain('chromatic')
  })

  it('covers all twelve remaining scales', () => {
    expect(ALL_SCALE_IDS).toHaveLength(12)
  })
})

describe('sortScaleIds', () => {
  it('sorts ids into canonical SCALES display order regardless of input order', () => {
    expect(sortScaleIds(['minor', 'major', 'dorian'])).toEqual(['major', 'dorian', 'minor'])
  })
})

describe('SCALE_PRESETS', () => {
  it('has four presets: major-minor, modes, pentatonic-blues, all', () => {
    expect(SCALE_PRESETS.map((p) => p.id)).toEqual([
      'major-minor',
      'modes',
      'pentatonic-blues',
      'all',
    ])
  })

  it('major-minor preset is the default set and has exactly 2 scales', () => {
    const preset = SCALE_PRESETS.find((p) => p.id === 'major-minor')!
    expect(preset.scaleIds).toEqual(['major', 'minor'])
    expect(preset.scaleIds).toEqual(DEFAULT_SCALE_TRAINING_SETTINGS.enabled)
  })

  it('modes preset has exactly the 7 modes of the major scale', () => {
    const preset = SCALE_PRESETS.find((p) => p.id === 'modes')!
    expect(preset.scaleIds).toEqual([
      'major',
      'dorian',
      'phrygian',
      'lydian',
      'mixolydian',
      'minor',
      'locrian',
    ])
  })

  it('pentatonic-blues preset has exactly 3 scales', () => {
    const preset = SCALE_PRESETS.find((p) => p.id === 'pentatonic-blues')!
    expect(preset.scaleIds).toEqual(['major-pentatonic', 'minor-pentatonic', 'blues'])
  })

  it('all preset covers every selectable scale', () => {
    const preset = SCALE_PRESETS.find((p) => p.id === 'all')!
    expect(preset.scaleIds).toEqual([...ALL_SCALE_IDS])
    expect(preset.scaleIds.length).toBeGreaterThan(9)
  })

  it('the default set satisfies the minimum', () => {
    expect(DEFAULT_SCALE_TRAINING_SETTINGS.enabled.length).toBeGreaterThanOrEqual(MIN_ENABLED)
  })
})

describe('pickScaleRoot', () => {
  it('stays within ROOT_MIN..ROOT_MAX by default', () => {
    const rng = seq([0, 0.25, 0.5, 0.75, 0.999])
    for (let i = 0; i < 5; i += 1) {
      const root = pickScaleRoot(rng)
      expect(root).toBeGreaterThanOrEqual(ROOT_MIN)
      expect(root).toBeLessThanOrEqual(ROOT_MAX)
    }
  })

  it('returns min at rng=0 and max at rng->1', () => {
    expect(pickScaleRoot(() => 0)).toBe(ROOT_MIN)
    expect(pickScaleRoot(() => 0.9999)).toBe(ROOT_MAX)
  })

  it('clamps a degenerate range to min', () => {
    expect(pickScaleRoot(() => 0.5, 60, 60)).toBe(60)
    expect(pickScaleRoot(() => 0.5, 60, 50)).toBe(60)
  })
})

describe('generateScaleQuestion', () => {
  const ctx: ScaleQuestionContext = { enabled: ['major', 'minor', 'dorian'] }

  it('only produces enabled scales', () => {
    const rng = seq([0.1, 0.2, 0.4, 0.6, 0.8, 0.95])
    let prev: ScaleQuestion | null = null
    for (let i = 0; i < 30; i += 1) {
      const q = generateScaleQuestion(ctx, prev, rng)
      expect(ctx.enabled).toContain(q.scaleId)
      prev = q
    }
  })

  it('keeps the root within the default register', () => {
    const rng = seq([0.3, 0.7, 0.1, 0.9, 0.5])
    for (let i = 0; i < 20; i += 1) {
      const q = generateScaleQuestion(ctx, null, rng)
      expect(q.rootMidi).toBeGreaterThanOrEqual(ROOT_MIN)
      expect(q.rootMidi).toBeLessThanOrEqual(ROOT_MAX)
    }
  })

  it('avoids an immediate scale repeat when more than one is enabled', () => {
    const rng = seq([0.05, 0.2, 0.3, 0.6, 0.9, 0.45])
    let prev: ScaleQuestion | null = null
    for (let i = 0; i < 40; i += 1) {
      const q = generateScaleQuestion(ctx, prev, rng)
      if (prev) expect(q.scaleId).not.toBe(prev.scaleId)
      prev = q
    }
  })

  it('may repeat when only one scale is enabled', () => {
    const single: ScaleQuestionContext = { enabled: ['blues'] }
    const prev: ScaleQuestion = { rootMidi: 50, scaleId: 'blues' }
    const q = generateScaleQuestion(single, prev, () => 0.5)
    expect(q.scaleId).toBe('blues')
  })

  it('respects a custom root register', () => {
    const q = generateScaleQuestion({ enabled: ['major'], rootMin: 40, rootMax: 41 }, null, () => 0.9)
    expect(q.rootMidi).toBeGreaterThanOrEqual(40)
    expect(q.rootMidi).toBeLessThanOrEqual(41)
  })

  it('throws when nothing is enabled', () => {
    expect(() => generateScaleQuestion({ enabled: [] }, null, () => 0)).toThrow()
  })
})

describe('scaleSrsKey', () => {
  it('is the scale id (root never part of the schedule)', () => {
    expect(scaleSrsKey('dorian')).toBe('dorian')
    expect(scaleSrsKey('blues')).toBe('blues')
  })
})

describe('generateScaleQuestion — SRS-influenced picking', () => {
  const NOW = 1_000_000
  const ctx: ScaleQuestionContext = { enabled: ['major', 'minor', 'dorian', 'blues'] }

  function counts(srs: SrsData, n: number): Map<string, number> {
    const rng = lcg(13579)
    const out = new Map<string, number>()
    for (let i = 0; i < n; i += 1) {
      const q = generateScaleQuestion(ctx, null, rng, { srs, now: NOW })
      out.set(q.scaleId, (out.get(q.scaleId) ?? 0) + 1)
    }
    return out
  }

  it('only produces enabled scales when picking', () => {
    const rng = lcg(5)
    let prev: ScaleQuestion | null = null
    for (let i = 0; i < 40; i += 1) {
      const q = generateScaleQuestion(ctx, prev, rng, { srs: {}, now: NOW })
      expect(ctx.enabled).toContain(q.scaleId)
      prev = q
    }
  })

  it('avoids an immediate repeat when picking with more than one enabled', () => {
    const rng = lcg(17)
    let prev: ScaleQuestion | null = null
    for (let i = 0; i < 60; i += 1) {
      const q = generateScaleQuestion(ctx, prev, rng, { srs: {}, now: NOW })
      if (prev) expect(q.scaleId).not.toBe(prev.scaleId)
      prev = q
    }
  })

  it('favors an overdue scale over one not yet due', () => {
    const srs: SrsData = {
      blues: srsItem(NOW - 5 * STEP_MS), // very overdue
      major: srsItem(NOW + 100 * STEP_MS),
      minor: srsItem(NOW + 100 * STEP_MS),
      dorian: srsItem(NOW + 100 * STEP_MS),
    }
    const c = counts(srs, 4000)
    expect(c.get('blues') ?? 0).toBeGreaterThan((c.get('major') ?? 0) * 3)
  })

  it('favors never-seen scales over one not yet due', () => {
    const srs: SrsData = { major: srsItem(NOW + 100 * STEP_MS) }
    const c = counts(srs, 4000)
    const newAvg = ['minor', 'dorian', 'blues'].reduce((sum, id) => sum + (c.get(id) ?? 0), 0) / 3
    expect(newAvg).toBeGreaterThan((c.get('major') ?? 0) * 2)
  })
})

describe('checkScaleAnswer', () => {
  const q: ScaleQuestion = { rootMidi: 48, scaleId: 'dorian' }
  it('accepts the matching scale id', () => {
    expect(checkScaleAnswer(q, 'dorian')).toBe(true)
  })
  it('rejects a different scale id', () => {
    expect(checkScaleAnswer(q, 'phrygian')).toBe(false)
  })
})

describe('questionScaleMidis', () => {
  it('builds the ascending scale from the root through the octave above', () => {
    const q: ScaleQuestion = { rootMidi: 48, scaleId: 'major' }
    // C major from C3: C D E F G A B C.
    expect(questionScaleMidis(q)).toEqual([48, 50, 52, 53, 55, 57, 59, 60])
  })

  it('transposes by the question root', () => {
    const q: ScaleQuestion = { rootMidi: 50, scaleId: 'minor-pentatonic' }
    // D minor pentatonic from D3 (50): D F G A C D.
    expect(questionScaleMidis(q)).toEqual([50, 53, 55, 57, 60, 62])
  })
})

describe('questionScaleSteps', () => {
  it('sequences the scale ascending by default, spaced by stepSeconds', () => {
    const q: ScaleQuestion = { rootMidi: 48, scaleId: 'major-pentatonic' }
    const steps = questionScaleSteps(q, 0.25, 0)
    expect(steps).toEqual([
      { midi: 48, when: 0 },
      { midi: 50, when: 0.25 },
      { midi: 52, when: 0.5 },
      { midi: 55, when: 0.75 },
      { midi: 57, when: 1 },
      { midi: 60, when: 1.25 },
    ])
  })

  it('reverses the sequence for the replay-descending option', () => {
    const q: ScaleQuestion = { rootMidi: 48, scaleId: 'major-pentatonic' }
    const steps = questionScaleSteps(q, 0.25, 0, true)
    expect(steps.map((s) => s.midi)).toEqual([60, 57, 55, 52, 50, 48])
    expect(steps.map((s) => s.when)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25])
  })

  it('offsets every step by startTime', () => {
    const q: ScaleQuestion = { rootMidi: 60, scaleId: 'minor' }
    const steps = questionScaleSteps(q, 0.2, 1)
    expect(steps[0]).toEqual({ midi: 60, when: 1 })
    expect(steps[1]).toEqual({ midi: 62, when: 1.2 })
  })

  it('defaults to DEFAULT_SCALE_STEP_SECONDS spacing', () => {
    const q: ScaleQuestion = { rootMidi: 48, scaleId: 'major' }
    const steps = questionScaleSteps(q)
    expect(steps[1]!.when).toBeCloseTo(DEFAULT_SCALE_STEP_SECONDS)
  })
})

describe('accumulateStat / accuracy', () => {
  it('folds attempts and correct hits without mutating the input', () => {
    const empty = {}
    const a = accumulateStat(empty, 'major', true)
    const b = accumulateStat(a, 'major', false)
    expect(empty).toEqual({})
    expect(a['major']).toEqual({ attempts: 1, correct: 1 })
    expect(b['major']).toEqual({ attempts: 2, correct: 1 })
  })

  it('tracks scales independently', () => {
    let s = accumulateStat({}, 'major', true)
    s = accumulateStat(s, 'blues', false)
    expect(s['major']).toEqual({ attempts: 1, correct: 1 })
    expect(s['blues']).toEqual({ attempts: 1, correct: 0 })
  })

  it('accuracy is correct/attempts, or null with no attempts', () => {
    expect(accuracy(undefined)).toBeNull()
    expect(accuracy({ attempts: 0, correct: 0 })).toBeNull()
    expect(accuracy({ attempts: 4, correct: 3 })).toBeCloseTo(0.75)
  })
})

describe('normalizeScaleStats', () => {
  it('drops unknown ids, non-objects, and zero-attempt entries', () => {
    expect(
      normalizeScaleStats({
        major: { attempts: 3, correct: 2 },
        bogus: { attempts: 5, correct: 1 }, // unknown id
        minor: { attempts: 0, correct: 0 }, // no attempts
        dorian: 'nope',
        chromatic: { attempts: 2, correct: 1 }, // excluded scale
      }),
    ).toEqual({ major: { attempts: 3, correct: 2 } })
  })

  it('clamps correct to attempts and floors negatives', () => {
    expect(normalizeScaleStats({ major: { attempts: 2, correct: 9 } })).toEqual({
      major: { attempts: 2, correct: 2 },
    })
    expect(normalizeScaleStats({ major: { attempts: 3, correct: -1 } })).toEqual({
      major: { attempts: 3, correct: 0 },
    })
  })

  it('returns empty for non-object input', () => {
    expect(normalizeScaleStats(null)).toEqual({})
    expect(normalizeScaleStats('x')).toEqual({})
  })
})

describe('normalizeEnabledScales', () => {
  it('dedupes, sorts canonically and drops unknown/excluded ids', () => {
    expect(normalizeEnabledScales(['minor', 'minor', 'major', 'bogus', 'dorian', 'chromatic'])).toEqual(
      ['major', 'dorian', 'minor'],
    )
  })

  it('falls back to defaults below the minimum enabled count', () => {
    expect(normalizeEnabledScales(['major'])).toEqual([...DEFAULT_SCALE_TRAINING_SETTINGS.enabled])
    expect(normalizeEnabledScales([])).toEqual([...DEFAULT_SCALE_TRAINING_SETTINGS.enabled])
    expect(normalizeEnabledScales('nope')).toEqual([...DEFAULT_SCALE_TRAINING_SETTINGS.enabled])
  })
})

describe('normalizeScaleTrainingSettings', () => {
  it('passes through valid settings, canonically ordered', () => {
    expect(normalizeScaleTrainingSettings({ enabled: ['major', 'minor', 'dorian'] })).toEqual({
      enabled: ['major', 'dorian', 'minor'],
    })
  })

  it('repairs a missing/invalid enabled field', () => {
    expect(normalizeScaleTrainingSettings({ enabled: ['major'] })).toEqual(
      DEFAULT_SCALE_TRAINING_SETTINGS,
    )
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeScaleTrainingSettings(null)).toEqual(DEFAULT_SCALE_TRAINING_SETTINGS)
  })
})

describe('toggleScale', () => {
  it('adds and removes scales, keeping the set canonically ordered', () => {
    expect(toggleScale(['major', 'minor'], 'dorian')).toEqual(['major', 'dorian', 'minor'])
    expect(toggleScale(['major', 'dorian', 'minor'], 'dorian')).toEqual(['major', 'minor'])
  })

  it('never drops below the minimum enabled count', () => {
    expect(toggleScale(['major', 'minor'], 'minor')).toEqual(['major', 'minor'])
  })

  it('covers every selectable scale (12 total, chromatic excluded)', () => {
    expect(ALL_SCALE_IDS).toHaveLength(12)
  })
})

describe('settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createScaleSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_SCALE_TRAINING_SETTINGS)
  })

  it('round-trips settings across instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { enabled: ['major', 'minor', 'dorian'] }
    createScaleSettingsStore(backend).set(value)
    expect(createScaleSettingsStore(backend).get()).toEqual(value)
  })
})

describe('scale stats store', () => {
  it('defaults to empty stats', () => {
    const store = createScaleStatsStore(memoryBackend())
    expect(store.get()).toEqual({})
  })

  it('round-trips accumulated stats', () => {
    const backend = memoryBackend()
    let stats = accumulateStat({}, 'blues', true)
    stats = accumulateStat(stats, 'blues', false)
    createScaleStatsStore(backend).set(stats)
    const loaded = createScaleStatsStore(backend).get()
    expect(normalizeScaleStats(loaded)['blues']).toEqual({ attempts: 2, correct: 1 })
  })
})
