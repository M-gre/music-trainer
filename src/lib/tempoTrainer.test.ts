import { describe, expect, it } from 'vitest'
import {
  barsToReachMax,
  bpmForBar,
  clampTrainerBpm,
  clampTrainerEveryN,
  clampTrainerStep,
  DEFAULT_TEMPO_TRAINER,
  MAX_TRAINER_BPM,
  MAX_TRAINER_EVERY_N,
  MAX_TRAINER_STEP,
  MIN_TRAINER_BPM,
  MIN_TRAINER_EVERY_N,
  MIN_TRAINER_STEP,
  normalizeTempoTrainerConfig,
  type TempoTrainerConfig,
} from './tempoTrainer.ts'

const cfg = (overrides: Partial<TempoTrainerConfig> = {}): TempoTrainerConfig => ({
  enabled: true,
  startBpm: 100,
  stepBpm: 10,
  everyNBars: 4,
  maxBpm: 160,
  ...overrides,
})

describe('clamp helpers', () => {
  it('clamps bpm into range and rounds', () => {
    expect(clampTrainerBpm(1)).toBe(MIN_TRAINER_BPM)
    expect(clampTrainerBpm(9999)).toBe(MAX_TRAINER_BPM)
    expect(clampTrainerBpm(120.6)).toBe(121)
    expect(clampTrainerBpm(Number.NaN)).toBe(DEFAULT_TEMPO_TRAINER.startBpm)
  })

  it('clamps step and interval into range', () => {
    expect(clampTrainerStep(0)).toBe(MIN_TRAINER_STEP)
    expect(clampTrainerStep(999)).toBe(MAX_TRAINER_STEP)
    expect(clampTrainerEveryN(0)).toBe(MIN_TRAINER_EVERY_N)
    expect(clampTrainerEveryN(999)).toBe(MAX_TRAINER_EVERY_N)
  })
})

describe('bpmForBar', () => {
  it('returns the start tempo across a whole block before the first boundary', () => {
    const c = cfg({ everyNBars: 4 })
    expect(bpmForBar(c, 0)).toBe(100)
    expect(bpmForBar(c, 1)).toBe(100)
    expect(bpmForBar(c, 3)).toBe(100)
  })

  it('steps up exactly on every-N boundaries', () => {
    const c = cfg({ startBpm: 100, stepBpm: 10, everyNBars: 4, maxBpm: 200 })
    expect(bpmForBar(c, 4)).toBe(110) // first increment
    expect(bpmForBar(c, 7)).toBe(110)
    expect(bpmForBar(c, 8)).toBe(120) // second increment
    expect(bpmForBar(c, 12)).toBe(130)
  })

  it('increments every bar when everyNBars is 1', () => {
    const c = cfg({ startBpm: 80, stepBpm: 5, everyNBars: 1, maxBpm: 200 })
    expect(bpmForBar(c, 0)).toBe(80)
    expect(bpmForBar(c, 1)).toBe(85)
    expect(bpmForBar(c, 2)).toBe(90)
    expect(bpmForBar(c, 10)).toBe(130)
  })

  it('clamps at maxBpm and never overshoots', () => {
    const c = cfg({ startBpm: 100, stepBpm: 10, everyNBars: 2, maxBpm: 130 })
    expect(bpmForBar(c, 6)).toBe(130) // start + 3*10 = 130
    expect(bpmForBar(c, 8)).toBe(130) // would be 140, clamped
    expect(bpmForBar(c, 1000)).toBe(130)
  })

  it('reaches max exactly when the step divides the span evenly', () => {
    const c = cfg({ startBpm: 100, stepBpm: 20, everyNBars: 1, maxBpm: 160 })
    expect(bpmForBar(c, 2)).toBe(140)
    expect(bpmForBar(c, 3)).toBe(160) // lands on max exactly
    expect(bpmForBar(c, 4)).toBe(160) // holds at max
  })

  it('passes the start tempo through unchanged when disabled', () => {
    const c = cfg({ enabled: false })
    expect(bpmForBar(c, 0)).toBe(100)
    expect(bpmForBar(c, 100)).toBe(100)
  })

  it('never steps below the start when maxBpm is misconfigured below it', () => {
    const c = cfg({ startBpm: 140, maxBpm: 100 })
    expect(bpmForBar(c, 0)).toBe(140)
    expect(bpmForBar(c, 8)).toBe(140)
  })

  it('is safe on raw / out-of-range configs and negative bars', () => {
    const c = cfg({ startBpm: 5, stepBpm: 0, everyNBars: 0, maxBpm: 9999 })
    // step clamps to MIN_TRAINER_STEP, everyN clamps to MIN_TRAINER_EVERY_N, start clamps up
    expect(bpmForBar(c, -3)).toBe(MIN_TRAINER_BPM)
    expect(bpmForBar(c, 1)).toBe(MIN_TRAINER_BPM + MIN_TRAINER_STEP)
    expect(bpmForBar(c, Number.NaN)).toBe(MIN_TRAINER_BPM)
  })
})

describe('barsToReachMax', () => {
  it('reports the bar the ceiling is first reached', () => {
    expect(barsToReachMax(cfg({ startBpm: 100, stepBpm: 10, everyNBars: 4, maxBpm: 140 }))).toBe(16)
  })

  it('rounds up when the step does not divide the span evenly', () => {
    // span 25, step 10 -> 3 increments, every 2 bars -> 6
    expect(barsToReachMax(cfg({ startBpm: 100, stepBpm: 10, everyNBars: 2, maxBpm: 125 }))).toBe(6)
  })

  it('is null when disabled or already at the ceiling', () => {
    expect(barsToReachMax(cfg({ enabled: false }))).toBeNull()
    expect(barsToReachMax(cfg({ startBpm: 160, maxBpm: 160 }))).toBeNull()
  })
})

describe('normalizeTempoTrainerConfig', () => {
  it('passes through a valid config', () => {
    const c = cfg({ enabled: false, startBpm: 90, stepBpm: 5, everyNBars: 8, maxBpm: 150 })
    expect(normalizeTempoTrainerConfig(c)).toEqual(c)
  })

  it('fills missing fields from the defaults', () => {
    expect(normalizeTempoTrainerConfig({})).toEqual(DEFAULT_TEMPO_TRAINER)
    expect(normalizeTempoTrainerConfig(null)).toEqual(DEFAULT_TEMPO_TRAINER)
    expect(normalizeTempoTrainerConfig('nope')).toEqual(DEFAULT_TEMPO_TRAINER)
  })

  it('clamps out-of-range fields', () => {
    const result = normalizeTempoTrainerConfig({
      enabled: true,
      startBpm: 5,
      stepBpm: 999,
      everyNBars: 999,
      maxBpm: 9999,
    })
    expect(result).toEqual({
      enabled: true,
      startBpm: MIN_TRAINER_BPM,
      stepBpm: MAX_TRAINER_STEP,
      everyNBars: MAX_TRAINER_EVERY_N,
      maxBpm: MAX_TRAINER_BPM,
    })
  })

  it('raises the ceiling to at least the start tempo', () => {
    const result = normalizeTempoTrainerConfig({ startBpm: 150, maxBpm: 100 })
    expect(result.startBpm).toBe(150)
    expect(result.maxBpm).toBe(150)
  })
})
