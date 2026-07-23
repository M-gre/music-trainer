import { describe, expect, it } from 'vitest'
import type { ExerciseStep, Finger } from './exercises.ts'
import { locateStep } from './exercises.ts'
import {
  accentEveryN,
  applyAccent,
  DEFAULT_RHYTHM_ID,
  fraction,
  fractionsEqual,
  fractionToNumber,
  fractionToTicks,
  getRhythm,
  isAccentEveryN,
  isRhythmId,
  noteDurationsTicks,
  rhythmForNotesPerBeat,
  RHYTHM_IDS,
  RHYTHM_RESOLUTION,
  RHYTHMS,
  rhythmizeSteps,
  rhythmTiming,
  type Fraction,
  type RhythmId,
} from './rhythmVariations.ts'

/** Minimal fake steps — only midi/duration matter downstream; the rest is filler. */
function steps(count: number): ExerciseStep[] {
  return Array.from({ length: count }, (_, i) => ({
    string: 0,
    fret: i,
    finger: ((i % 4) + 1) as Finger,
    duration: 1,
    midi: 40 + i,
  }))
}

/** Compact `num/den` view of a sequence's offsets for exact comparison. */
function offsets(rhythmId: RhythmId, n: number): [number, number][] {
  return rhythmizeSteps(steps(n), getRhythm(rhythmId)).events.map((e) => [
    e.beatOffset.num,
    e.beatOffset.den,
  ])
}

describe('fraction', () => {
  it('reduces to lowest terms', () => {
    expect(fraction(2, 4)).toEqual({ num: 1, den: 2 })
    expect(fraction(6, 3)).toEqual({ num: 2, den: 1 })
    expect(fraction(0, 5)).toEqual({ num: 0, den: 1 })
  })
  it('normalizes a negative denominator', () => {
    expect(fraction(1, -2)).toEqual({ num: -1, den: 2 })
  })
  it('throws on a zero denominator', () => {
    expect(() => fraction(1, 0)).toThrow()
  })
  it('fractionToNumber and fractionsEqual', () => {
    expect(fractionToNumber(fraction(3, 4))).toBeCloseTo(0.75)
    expect(fractionsEqual(fraction(2, 4), fraction(1, 2))).toBe(true)
    expect(fractionsEqual(fraction(1, 3), fraction(1, 2))).toBe(false)
  })
})

describe('fractionToTicks', () => {
  it('is exact for thirds and quarters at resolution 12', () => {
    expect(fractionToTicks(fraction(1, 3), 12)).toBe(4)
    expect(fractionToTicks(fraction(2, 3), 12)).toBe(8)
    expect(fractionToTicks(fraction(3, 4), 12)).toBe(9)
    expect(fractionToTicks(fraction(1, 2), 12)).toBe(6)
    expect(fractionToTicks(fraction(0, 1), 12)).toBe(0)
    expect(fractionToTicks(fraction(4, 3), 12)).toBe(16)
  })
  it('throws when the denominator does not divide the resolution', () => {
    expect(() => fractionToTicks(fraction(1, 5), 12)).toThrow()
  })
})

describe('rhythm registry', () => {
  it('exposes eight rhythms with matching ids', () => {
    expect(RHYTHMS).toHaveLength(8)
    expect(RHYTHM_IDS).toHaveLength(8)
    expect(new Set(RHYTHM_IDS).size).toBe(8)
  })
  it('isRhythmId / getRhythm', () => {
    expect(isRhythmId('triplets')).toBe(true)
    expect(isRhythmId('bogus')).toBe(false)
    expect(isRhythmId(7)).toBe(false)
    expect(getRhythm('triplets').id).toBe('triplets')
    expect(getRhythm('nope').id).toBe(DEFAULT_RHYTHM_ID)
  })
  it('every offset denominator divides the grid resolution', () => {
    for (const r of RHYTHMS) {
      for (const off of r.offsets) {
        expect(RHYTHM_RESOLUTION % off.den).toBe(0)
      }
    }
  })
})

describe('rhythmForNotesPerBeat', () => {
  it('maps the legacy notes-per-beat values', () => {
    expect(rhythmForNotesPerBeat(1)).toBe('straight-quarters')
    expect(rhythmForNotesPerBeat(2)).toBe('eighths')
    expect(rhythmForNotesPerBeat(3)).toBe('triplets')
    expect(rhythmForNotesPerBeat(4)).toBe('sixteenths')
    expect(rhythmForNotesPerBeat(undefined)).toBe('straight-quarters')
    expect(rhythmForNotesPerBeat('x')).toBe('straight-quarters')
  })
})

describe('rhythmizeSteps — exact beat offsets', () => {
  it('straight quarters: one note per beat', () => {
    expect(offsets('straight-quarters', 4)).toEqual([
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
    ])
  })
  it('eighths: two per beat, cycling across beats', () => {
    expect(offsets('eighths', 4)).toEqual([
      [0, 1],
      [1, 2],
      [1, 1],
      [3, 2],
    ])
  })
  it('triplets: exact thirds, never a lossy float', () => {
    expect(offsets('triplets', 6)).toEqual([
      [0, 1],
      [1, 3],
      [2, 3],
      [1, 1],
      [4, 3],
      [5, 3],
    ])
  })
  it('sixteenths: four per beat', () => {
    expect(offsets('sixteenths', 5)).toEqual([
      [0, 1],
      [1, 4],
      [1, 2],
      [3, 4],
      [1, 1],
    ])
  })
  it('gallop: 8th + two 16ths (0, 1/2, 3/4), cycling', () => {
    expect(offsets('gallop', 6)).toEqual([
      [0, 1],
      [1, 2],
      [3, 4],
      [1, 1],
      [3, 2],
      [7, 4],
    ])
  })
  it('reverse gallop: two 16ths + 8th (0, 1/4, 1/2)', () => {
    expect(offsets('reverse-gallop', 3)).toEqual([
      [0, 1],
      [1, 4],
      [1, 2],
    ])
  })
  it('dotted 8th + 16th (0, 3/4)', () => {
    expect(offsets('dotted-8th-16th', 4)).toEqual([
      [0, 1],
      [3, 4],
      [1, 1],
      [7, 4],
    ])
  })
  it('offbeat eighths: single note per beat on the &', () => {
    expect(offsets('offbeat-8ths', 3)).toEqual([
      [1, 2],
      [3, 2],
      [5, 2],
    ])
  })
})

describe('rhythmizeSteps — loop length in whole beats', () => {
  it('rounds up to a whole number of cycles', () => {
    expect(rhythmizeSteps(steps(5), getRhythm('straight-quarters')).loopBeats).toBe(5)
    expect(rhythmizeSteps(steps(5), getRhythm('eighths')).loopBeats).toBe(3)
    expect(rhythmizeSteps(steps(8), getRhythm('triplets')).loopBeats).toBe(3)
    expect(rhythmizeSteps(steps(4), getRhythm('sixteenths')).loopBeats).toBe(1)
    expect(rhythmizeSteps(steps(5), getRhythm('sixteenths')).loopBeats).toBe(2)
    expect(rhythmizeSteps(steps(3), getRhythm('offbeat-8ths')).loopBeats).toBe(3)
  })
  it('an empty sequence yields no events and zero beats', () => {
    const seq = rhythmizeSteps([], getRhythm('eighths'))
    expect(seq.events).toEqual([])
    expect(seq.loopBeats).toBe(0)
  })
})

describe('default accents — first note of each beat', () => {
  it('eighths accents the downbeat of each beat', () => {
    const acc = rhythmizeSteps(steps(4), getRhythm('eighths')).events.map((e) => e.accent)
    expect(acc).toEqual([true, false, true, false])
  })
  it('triplets accents index 0 and 3', () => {
    const acc = rhythmizeSteps(steps(6), getRhythm('triplets')).events.map((e) => e.accent)
    expect(acc).toEqual([true, false, false, true, false, false])
  })
  it('offbeat eighths accents its single per-beat note', () => {
    const acc = rhythmizeSteps(steps(3), getRhythm('offbeat-8ths')).events.map((e) => e.accent)
    expect(acc).toEqual([true, true, true])
  })
})

describe('accentEveryN — displacement', () => {
  it('n=3 over sixteenths marches the accent through the beat', () => {
    const seq = rhythmizeSteps(steps(8), getRhythm('sixteenths'))
    const acc = accentEveryN(seq.events, 3).map((e) => e.accent)
    expect(acc).toEqual([true, false, false, true, false, false, true, false])
    // The accented onsets land on different positions within each beat.
    const accented = accentEveryN(seq.events, 3)
      .filter((e) => e.accent)
      .map((e): [number, number] => [e.beatOffset.num, e.beatOffset.den])
    expect(accented).toEqual([
      [0, 1],
      [3, 4],
      [3, 2],
    ])
  })
  it('respects a phase offset', () => {
    const seq = rhythmizeSteps(steps(7), getRhythm('sixteenths'))
    const acc = accentEveryN(seq.events, 3, 1).map((e) => e.accent)
    expect(acc).toEqual([false, true, false, false, true, false, false])
  })
  it('does not mutate the input events', () => {
    const seq = rhythmizeSteps(steps(4), getRhythm('eighths'))
    const before = seq.events.map((e) => e.accent)
    accentEveryN(seq.events, 2)
    expect(seq.events.map((e) => e.accent)).toEqual(before)
  })
  it('n<=1 accents every note', () => {
    const seq = rhythmizeSteps(steps(3), getRhythm('eighths'))
    expect(accentEveryN(seq.events, 1).every((e) => e.accent)).toBe(true)
  })
})

describe('applyAccent / isAccentEveryN', () => {
  it('0 keeps the default first-of-beat accents', () => {
    const seq = rhythmizeSteps(steps(4), getRhythm('eighths'))
    expect(applyAccent(seq.events, 0).map((e) => e.accent)).toEqual([true, false, true, false])
  })
  it('non-zero delegates to accentEveryN', () => {
    const seq = rhythmizeSteps(steps(4), getRhythm('sixteenths'))
    expect(applyAccent(seq.events, 2).map((e) => e.accent)).toEqual([true, false, true, false])
  })
  it('isAccentEveryN guards the allowed values', () => {
    expect(isAccentEveryN(0)).toBe(true)
    expect(isAccentEveryN(3)).toBe(true)
    expect(isAccentEveryN(5)).toBe(false)
    expect(isAccentEveryN('2')).toBe(false)
  })
})

describe('rhythmTiming — exact integer grid ticks', () => {
  it('triplets over 4 steps map to exact ticks', () => {
    const timing = rhythmTiming(rhythmizeSteps(steps(4), getRhythm('triplets')))
    // 0, 1/3, 2/3, 1 -> 0, 4, 8, 12 ; loop = 2 beats = 24 ticks
    expect(timing.onsets).toEqual([0, 4, 8, 12])
    expect(timing.totalGridSteps).toBe(24)
  })
  it('gallop over 3 steps', () => {
    const timing = rhythmTiming(rhythmizeSteps(steps(3), getRhythm('gallop')))
    // 0, 1/2, 3/4 -> 0, 6, 9 ; loop = 1 beat = 12 ticks
    expect(timing.onsets).toEqual([0, 6, 9])
    expect(timing.totalGridSteps).toBe(12)
  })
  it('every onset is an integer', () => {
    for (const r of RHYTHMS) {
      const timing = rhythmTiming(rhythmizeSteps(steps(9), r))
      for (const onset of timing.onsets) expect(Number.isInteger(onset)).toBe(true)
    }
  })
})

describe('noteDurationsTicks', () => {
  it('spans each gap, extending the last note to the loop end', () => {
    const timing = rhythmTiming(rhythmizeSteps(steps(3), getRhythm('gallop')))
    // onsets 0,6,9 ; total 12 -> durations 6,3,3
    expect(noteDurationsTicks(timing)).toEqual([6, 3, 3])
  })
})

describe('integration with locateStep', () => {
  it('maps absolute scheduler steps onto rhythm onsets and loops', () => {
    const timing = rhythmTiming(rhythmizeSteps(steps(2), getRhythm('eighths')))
    // onsets 0,6 ; loop = 1 beat = 12 ticks
    expect(locateStep(0, timing)).toEqual({ loop: 0, stepIndex: 0, isOnset: true })
    expect(locateStep(6, timing)).toEqual({ loop: 0, stepIndex: 1, isOnset: true })
    expect(locateStep(3, timing)).toEqual({ loop: 0, stepIndex: 0, isOnset: false })
    // next loop wraps and advances the position count
    expect(locateStep(12, timing)).toEqual({ loop: 1, stepIndex: 0, isOnset: true })
    expect(locateStep(18, timing)).toEqual({ loop: 1, stepIndex: 1, isOnset: true })
  })
})

describe('type coverage', () => {
  it('Fraction values compare structurally', () => {
    const f: Fraction = fraction(3, 6)
    expect(f).toEqual({ num: 1, den: 2 })
  })
})
