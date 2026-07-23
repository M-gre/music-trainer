import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import { getRhythm } from './rhythmVariations.ts'
import { getTuning } from './theory/instruments.ts'
import { DEFAULT_DEXTERITY_SETTINGS } from './dexteritySettings.ts'
import { permutationId } from './permutations.ts'
import {
  createRoutinesStore,
  DEFAULT_ROUTINES_STATE,
  DEFAULT_STEP_DURATION,
  type DrillConfig,
  drillConfigFromSettings,
  drillConfigLabel,
  estimateRoutineSeconds,
  estimateStepSeconds,
  expandDrillConfig,
  isLastStep,
  isResolvableDrillConfig,
  loopBeats,
  loopSeconds,
  MAX_STEP_LOOPS,
  MAX_STEP_MINUTES,
  moveStep,
  nextStep,
  normalizeDrillConfig,
  normalizeRoutine,
  normalizeRoutinesState,
  normalizeStepDuration,
  removeStep,
  type Routine,
  type RoutineStep,
  stepIsComplete,
} from './warmupRoutines.ts'

const bass = getTuning('bass-4')

/** A base drill config (spider walk) for building test steps. */
const spiderConfig: DrillConfig = drillConfigFromSettings(DEFAULT_DEXTERITY_SETTINGS)

function step(config: Partial<DrillConfig>, duration: RoutineStep['duration']): RoutineStep {
  return { config: { ...spiderConfig, ...config }, duration }
}

describe('drillConfigFromSettings', () => {
  it('projects the drill-defining subset and drops the auto-advance span', () => {
    const config = drillConfigFromSettings({
      ...DEFAULT_DEXTERITY_SETTINGS,
      bpm: 111,
      autoAdvance: true,
      advanceMin: 2,
      advanceMax: 9,
    })
    expect(config.bpm).toBe(111)
    expect('autoAdvance' in config).toBe(false)
    expect('advanceMin' in config).toBe(false)
  })
})

describe('isResolvableDrillConfig', () => {
  it('accepts a built-in pattern id and a permutation id', () => {
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'pattern', patternId: 'string-crossing-12' })).toBe(true)
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'pattern', patternId: permutationId([2, 4, 1, 3]) })).toBe(
      true,
    )
  })

  it('rejects a pattern config referencing an unknown pattern id', () => {
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'pattern', patternId: 'removed-pattern' })).toBe(false)
  })

  it('validates scale + sequence ids for a scale config', () => {
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'scale', scaleId: 'dorian', sequenceId: 'groups-of-3' })).toBe(
      true,
    )
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'scale', scaleId: 'bogus', sequenceId: 'groups-of-3' })).toBe(
      false,
    )
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'scale', scaleId: 'dorian', sequenceId: 'bogus' })).toBe(
      false,
    )
  })

  it('validates the quality id for an arpeggio config', () => {
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'arpeggio', arpQualityId: 'min7' })).toBe(true)
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'arpeggio', arpQualityId: 'sus4' })).toBe(false)
  })

  it('rejects non-objects and unknown modes', () => {
    expect(isResolvableDrillConfig(null)).toBe(false)
    expect(isResolvableDrillConfig({ ...spiderConfig, mode: 'bogus' })).toBe(false)
  })
})

describe('normalizeDrillConfig', () => {
  it('normalizes numeric fields of a resolvable config', () => {
    const config = normalizeDrillConfig({ ...spiderConfig, mode: 'pattern', position: 999, bpm: 5 })
    expect(config).not.toBeNull()
    expect(config!.position).toBeLessThanOrEqual(22)
    expect(config!.bpm).toBe(30)
  })

  it('returns null for a config referencing a removed drill', () => {
    expect(normalizeDrillConfig({ ...spiderConfig, mode: 'pattern', patternId: 'removed' })).toBeNull()
  })
})

describe('drillConfigLabel', () => {
  it('labels each mode', () => {
    expect(drillConfigLabel({ ...spiderConfig, mode: 'pattern', patternId: 'string-crossing-12' })).toContain(
      'String Crossing',
    )
    expect(drillConfigLabel({ ...spiderConfig, mode: 'scale', scaleRootPc: 0, scaleId: 'major', sequenceId: 'diatonic-3rds' })).toContain(
      'C Major',
    )
    expect(drillConfigLabel({ ...spiderConfig, mode: 'arpeggio', arpRootPc: 2, arpQualityId: 'min7' })).toBe(
      'Dm7 arpeggio',
    )
  })
})

describe('expandDrillConfig', () => {
  it('expands a spider walk into concrete steps for a tuning', () => {
    const steps = expandDrillConfig({ ...spiderConfig, mode: 'pattern', patternId: permutationId([1, 2, 3, 4]) }, bass)
    expect(steps.length).toBeGreaterThan(0)
    steps.forEach((s) => {
      expect(s.string).toBeGreaterThanOrEqual(0)
      expect(s.string).toBeLessThan(bass.strings.length)
    })
  })

  it('applies the direction transform', () => {
    const fwd = expandDrillConfig({ ...spiderConfig, direction: 'forward' }, bass)
    const rev = expandDrillConfig({ ...spiderConfig, direction: 'reverse' }, bass)
    expect(rev.map((s) => s.midi)).toEqual([...fwd.map((s) => s.midi)].reverse())
  })
})

describe('normalizeStepDuration', () => {
  it('clamps minutes and loops into range', () => {
    expect(normalizeStepDuration({ kind: 'minutes', minutes: 999 })).toEqual({ kind: 'minutes', minutes: MAX_STEP_MINUTES })
    expect(normalizeStepDuration({ kind: 'loops', loops: 999 })).toEqual({ kind: 'loops', loops: MAX_STEP_LOOPS })
    expect(normalizeStepDuration({ kind: 'loops', loops: 0 })).toEqual({ kind: 'loops', loops: 1 })
  })

  it('defaults for garbage', () => {
    expect(normalizeStepDuration(null)).toEqual(DEFAULT_STEP_DURATION)
    expect(normalizeStepDuration({ kind: 'weeks' })).toEqual(DEFAULT_STEP_DURATION)
  })
})

describe('time estimate', () => {
  it('loopBeats rounds up to whole rhythm cycles', () => {
    // straight quarters: 1 note per cycle -> loopBeats === stepCount
    expect(loopBeats(6, getRhythm('straight-quarters'))).toBe(6)
    // sixteenths: 4 notes per cycle -> ceil(6/4) = 2 beats
    expect(loopBeats(6, getRhythm('sixteenths'))).toBe(2)
    // eighths: 2 per cycle -> ceil(5/2) = 3 beats
    expect(loopBeats(5, getRhythm('eighths'))).toBe(3)
    expect(loopBeats(0, getRhythm('eighths'))).toBe(0)
  })

  it('loopSeconds is loopBeats * 60 / bpm', () => {
    // 8 quarter notes at 120 bpm = 8 beats * 0.5s = 4s
    expect(loopSeconds(8, getRhythm('straight-quarters'), 120)).toBeCloseTo(4)
  })

  it('estimateStepSeconds is exact for minutes and derived for loops', () => {
    expect(estimateStepSeconds(step({}, { kind: 'minutes', minutes: 3 }), 999)).toBe(180)
    // 4 loops of an 8-quarter-note exercise at 120bpm: 4 * 4s = 16s
    const loopStep = step({ bpm: 120, rhythmId: 'straight-quarters' }, { kind: 'loops', loops: 4 })
    expect(estimateStepSeconds(loopStep, 8)).toBeCloseTo(16)
  })

  it('estimateRoutineSeconds sums steps, only resolving counts for loops steps', () => {
    let resolveCalls = 0
    const routine: Routine = {
      id: 'r1',
      name: 'R',
      steps: [
        step({}, { kind: 'minutes', minutes: 2 }),
        step({ bpm: 120, rhythmId: 'straight-quarters' }, { kind: 'loops', loops: 2 }),
      ],
    }
    const total = estimateRoutineSeconds(routine, () => {
      resolveCalls += 1
      return 8
    })
    // 120s (minutes) + 2 loops * 4s = 128s
    expect(total).toBeCloseTo(128)
    expect(resolveCalls).toBe(1) // only the loops step resolved its count
  })
})

describe('advance / completion', () => {
  const routine: Routine = {
    id: 'r',
    name: 'R',
    steps: [step({}, DEFAULT_STEP_DURATION), step({ bpm: 90 }, { kind: 'loops', loops: 2 })],
  }

  it('nextStep returns the following step, then null at the end', () => {
    expect(nextStep(routine, 0)?.index).toBe(1)
    expect(nextStep(routine, 1)).toBeNull()
    expect(nextStep(routine, 5)).toBeNull()
  })

  it('isLastStep flags the final index', () => {
    expect(isLastStep(routine, 0)).toBe(false)
    expect(isLastStep(routine, 1)).toBe(true)
  })

  it('stepIsComplete for loops compares completed loops', () => {
    const s = step({}, { kind: 'loops', loops: 2 })
    expect(stepIsComplete(s, 15, 8, 0)).toBe(false) // 1 loop done
    expect(stepIsComplete(s, 16, 8, 0)).toBe(true) // 2 loops done
    expect(stepIsComplete(s, 0, 0, 0)).toBe(true) // empty exercise never stalls
  })

  it('stepIsComplete for minutes compares elapsed seconds', () => {
    const s = step({}, { kind: 'minutes', minutes: 1 })
    expect(stepIsComplete(s, 0, 8, 59.9)).toBe(false)
    expect(stepIsComplete(s, 0, 8, 60)).toBe(true)
  })
})

describe('normalizeRoutine', () => {
  it('drops steps referencing unknown drill ids', () => {
    const raw = {
      id: 'r1',
      name: 'Warm up',
      steps: [
        { config: { ...spiderConfig, mode: 'pattern', patternId: 'string-crossing-12' }, duration: { kind: 'minutes', minutes: 2 } },
        { config: { ...spiderConfig, mode: 'pattern', patternId: 'removed-pattern' }, duration: { kind: 'minutes', minutes: 2 } },
      ],
    }
    const routine = normalizeRoutine(raw)
    expect(routine).not.toBeNull()
    expect(routine!.steps).toHaveLength(1)
    expect(routine!.steps[0]!.config.patternId).toBe('string-crossing-12')
  })

  it('returns null when no id, or when every step is unresolvable', () => {
    expect(normalizeRoutine({ name: 'x', steps: [] })).toBeNull()
    expect(
      normalizeRoutine({
        id: 'r',
        name: 'x',
        steps: [{ config: { ...spiderConfig, mode: 'pattern', patternId: 'nope' }, duration: DEFAULT_STEP_DURATION }],
      }),
    ).toBeNull()
  })
})

describe('normalizeRoutinesState', () => {
  it('drops unusable routines and clears a dangling lastUsedId', () => {
    const state = normalizeRoutinesState({
      routines: [
        { id: 'good', name: 'Good', steps: [{ config: spiderConfig, duration: DEFAULT_STEP_DURATION }] },
        { id: 'bad', name: 'Bad', steps: [] },
      ],
      lastUsedId: 'missing',
    })
    expect(state.routines.map((r) => r.id)).toEqual(['good'])
    expect(state.lastUsedId).toBeNull()
  })

  it('falls back for garbage', () => {
    expect(normalizeRoutinesState(null)).toEqual(DEFAULT_ROUTINES_STATE)
  })
})

describe('routines store', () => {
  const validRoutine: Routine = {
    id: 'r1',
    name: 'Daily',
    steps: [step({}, { kind: 'minutes', minutes: 2 }), step({ bpm: 90 }, { kind: 'loops', loops: 4 })],
  }

  it('round-trips a normalized state through an injected backend', () => {
    const store = createRoutinesStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_ROUTINES_STATE)
    const state = { routines: [validRoutine], lastUsedId: 'r1' }
    store.set(state)
    expect(normalizeRoutinesState(store.get())).toEqual(state)
  })

  it('migrates a stored value, dropping steps with unknown drill ids', () => {
    const backend = memoryBackend()
    const stored = {
      routines: [
        {
          id: 'r1',
          name: 'Daily',
          steps: [
            { config: { ...spiderConfig, mode: 'pattern', patternId: 'string-crossing-12' }, duration: { kind: 'loops', loops: 3 } },
            { config: { ...spiderConfig, mode: 'pattern', patternId: 'gone' }, duration: { kind: 'minutes', minutes: 2 } },
          ],
        },
      ],
      lastUsedId: 'r1',
    }
    // Tag as an older version so the store runs its migrate on read.
    backend.setItem('mt:routines:dexterity', JSON.stringify({ v: 0, data: stored }))
    const store = createRoutinesStore(backend)
    const loaded = store.get()
    expect(loaded.routines).toHaveLength(1)
    expect(loaded.routines[0]!.steps).toHaveLength(1)
    // The migrated (cleaned) shape is persisted at the current version.
    const rawAfter = JSON.parse(backend.getItem('mt:routines:dexterity')!) as { v: number }
    expect(rawAfter.v).toBe(1)
  })
})

describe('editing helpers', () => {
  const steps = [step({ bpm: 60 }, DEFAULT_STEP_DURATION), step({ bpm: 70 }, DEFAULT_STEP_DURATION), step({ bpm: 80 }, DEFAULT_STEP_DURATION)]

  it('moveStep swaps within bounds and is a no-op out of bounds', () => {
    expect(moveStep(steps, 0, 1).map((s) => s.config.bpm)).toEqual([70, 60, 80])
    expect(moveStep(steps, 0, -1).map((s) => s.config.bpm)).toEqual([60, 70, 80])
    expect(moveStep(steps, 2, 1).map((s) => s.config.bpm)).toEqual([60, 70, 80])
  })

  it('removeStep drops the indexed item', () => {
    expect(removeStep(steps, 1).map((s) => s.config.bpm)).toEqual([60, 80])
  })
})
