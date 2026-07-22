import { describe, expect, it } from 'vitest'
import {
  clamp01,
  computeEnvelope,
  DEFAULT_ADSR,
  envelopeValueAt,
  resolveAdsr,
  velocityToGain,
  type AdsrParams,
} from './envelope.ts'

describe('clamp01', () => {
  it('clamps into 0..1', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.5)).toBe(0.5)
    expect(clamp01(2)).toBe(1)
  })
  it('treats NaN as 0', () => {
    expect(clamp01(Number.NaN)).toBe(0)
  })
})

describe('velocityToGain', () => {
  it('is 0 at 0 and 1 at 1', () => {
    expect(velocityToGain(0)).toBe(0)
    expect(velocityToGain(1)).toBe(1)
  })
  it('applies a downward curve and clamps', () => {
    expect(velocityToGain(0.5)).toBeCloseTo(0.25)
    expect(velocityToGain(-3)).toBe(0)
    expect(velocityToGain(9)).toBe(1)
  })
})

describe('resolveAdsr', () => {
  it('returns the defaults when nothing is passed', () => {
    expect(resolveAdsr()).toEqual(DEFAULT_ADSR)
  })
  it('overrides only the provided fields', () => {
    expect(resolveAdsr({ attack: 0.2 })).toEqual({ ...DEFAULT_ADSR, attack: 0.2 })
  })
  it('clamps negatives to 0 and sustain into 0..1', () => {
    expect(resolveAdsr({ attack: -1, decay: -2, release: -3, sustain: 5 })).toEqual({
      attack: 0,
      decay: 0,
      release: 0,
      sustain: 1,
    })
  })
})

const P: AdsrParams = { attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 }

describe('envelopeValueAt', () => {
  it('is 0 before and at the start', () => {
    expect(envelopeValueAt(-1, 0, 1, P)).toBe(0)
    expect(envelopeValueAt(0, 0, 1, P)).toBe(0)
  })
  it('ramps linearly through attack to the peak', () => {
    expect(envelopeValueAt(0.05, 0, 1, P)).toBeCloseTo(0.5)
    expect(envelopeValueAt(0.1, 0, 1, P)).toBeCloseTo(1)
  })
  it('decays linearly from peak to the sustain level', () => {
    // halfway through decay: between peak(1) and sustain(0.5) -> 0.75
    expect(envelopeValueAt(0.2, 0, 1, P)).toBeCloseTo(0.75)
    expect(envelopeValueAt(0.3, 0, 1, P)).toBeCloseTo(0.5)
  })
  it('holds the sustain level afterwards', () => {
    expect(envelopeValueAt(5, 0, 1, P)).toBeCloseTo(0.5)
  })
  it('handles zero attack and zero decay without dividing by zero', () => {
    const instant: AdsrParams = { attack: 0, decay: 0, sustain: 0.5, release: 0.1 }
    expect(envelopeValueAt(0.001, 0, 1, instant)).toBeCloseTo(0.5)
  })
})

describe('computeEnvelope', () => {
  it('starts at silence and ends at silence', () => {
    const { points } = computeEnvelope({ startTime: 1, duration: 1, peak: 0.8, params: P })
    expect(points[0]).toEqual({ time: 1, value: 0, ramp: 'set' })
    const last = points[points.length - 1]
    expect(last?.value).toBe(0)
  })

  it('produces attack, decay, sustain-hold and release for a long note', () => {
    const start = 2
    const { points, stopTime } = computeEnvelope({ startTime: start, duration: 1, peak: 1, params: P })
    // set@2 (0), attack@2.1 (1), decay@2.3 (0.5), gateEnd@3 (0.5), stop@3.3 (0)
    expect(points.map((p) => Number(p.time.toFixed(3)))).toEqual([2, 2.1, 2.3, 3, 3.3])
    expect(points.map((p) => Number(p.value.toFixed(3)))).toEqual([0, 1, 0.5, 0.5, 0])
    expect(points[1]?.ramp).toBe('linear')
    expect(stopTime).toBeCloseTo(3.3)
  })

  it('scales the peak and sustain by the peak level', () => {
    const { points } = computeEnvelope({ startTime: 0, duration: 1, peak: 0.4, params: P })
    expect(points[1]?.value).toBeCloseTo(0.4) // peak
    expect(points[2]?.value).toBeCloseTo(0.2) // sustain = 0.5 * 0.4
  })

  it('starts release from the interpolated level when the gate ends mid-decay', () => {
    // gate ends at 0.2, halfway through decay -> level 0.75
    const { points, stopTime } = computeEnvelope({ startTime: 0, duration: 0.2, peak: 1, params: P })
    // set@0, attack@0.1 (1), gateEnd@0.2 (0.75), stop@0.5 (0)
    expect(points.map((p) => Number(p.time.toFixed(3)))).toEqual([0, 0.1, 0.2, 0.5])
    expect(points[2]?.value).toBeCloseTo(0.75)
    expect(stopTime).toBeCloseTo(0.5)
  })

  it('handles a gate that ends during the attack (no peak reached)', () => {
    const { points } = computeEnvelope({ startTime: 0, duration: 0.05, peak: 1, params: P })
    // never reaches attackEnd(0.1): set@0, release-start@0.05 (~0.5), stop@0.35 (0)
    expect(points.map((p) => Number(p.time.toFixed(3)))).toEqual([0, 0.05, 0.35])
    expect(points[1]?.value).toBeCloseTo(0.5)
  })

  it('never schedules a zero-length ramp (times strictly increase)', () => {
    const { points } = computeEnvelope({ startTime: 0, duration: 0, peak: 1, params: P })
    for (let i = 1; i < points.length; i++) {
      expect(points[i]!.time).toBeGreaterThan(points[i - 1]!.time)
    }
  })

  it('treats negative durations as zero', () => {
    const a = computeEnvelope({ startTime: 0, duration: -5, peak: 1, params: P })
    const b = computeEnvelope({ startTime: 0, duration: 0, peak: 1, params: P })
    expect(a).toEqual(b)
  })
})
