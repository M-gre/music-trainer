import { describe, expect, it } from 'vitest'
import { getTuning } from './theory/instruments.ts'
import { fretMidi } from './theory/instruments.ts'
import {
  BUILTIN_PATTERNS,
  CHROMATIC_4NPS,
  expandPattern,
  getPattern,
  locateStep,
  positionForLoop,
  SPIDER_1234_UPDOWN,
  spiderMotif,
  stepTimings,
  type ExercisePattern,
} from './exercises.ts'

const bass4 = getTuning('bass-4')
const guitar6 = getTuning('guitar-6')

describe('spiderMotif', () => {
  it('maps each finger to its natural fret in play order', () => {
    expect(spiderMotif([1, 2, 3, 4])).toEqual([
      { fret: 0, finger: 1 },
      { fret: 1, finger: 2 },
      { fret: 2, finger: 3 },
      { fret: 3, finger: 4 },
    ])
  })

  it('preserves a permutation order while keeping finger→fret mapping', () => {
    expect(spiderMotif([2, 4, 1, 3])).toEqual([
      { fret: 1, finger: 2 },
      { fret: 3, finger: 4 },
      { fret: 0, finger: 1 },
      { fret: 2, finger: 3 },
    ])
  })
})

describe('expandPattern', () => {
  it('expands an ascending chromatic run across every string, low to high', () => {
    const steps = expandPattern(CHROMATIC_4NPS, { tuning: bass4, position: 5 })
    // 4 strings x 4 notes per string.
    expect(steps).toHaveLength(16)
    // First four steps are on the lowest string, frets 5..8, fingers 1..4.
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
    ])
    // Last note is on the highest string.
    expect(steps[15]!.string).toBe(3)
  })

  it('applies the position offset to every fret', () => {
    const at3 = expandPattern(CHROMATIC_4NPS, { tuning: bass4, position: 3 })
    expect(at3[0]!.fret).toBe(3)
    expect(at3[3]!.fret).toBe(6)
  })

  it('goes up then down for an ascending-descending traversal', () => {
    const steps = expandPattern(SPIDER_1234_UPDOWN, { tuning: bass4, position: 5 })
    // 4 strings up (16) + 4 strings down (16).
    expect(steps).toHaveLength(32)
    // Ascending ends on the highest string with finger 4.
    expect(steps[15]).toMatchObject({ string: 3, finger: 4, fret: 8 })
    // Descending begins on the highest string reversed (finger 4 first).
    expect(steps[16]).toMatchObject({ string: 3, finger: 4, fret: 8 })
    // Descending ends on the lowest string with finger 1.
    expect(steps[31]).toMatchObject({ string: 0, finger: 1, fret: 5 })
  })

  it('renders on any string count (tuning-aware)', () => {
    const steps = expandPattern(CHROMATIC_4NPS, { tuning: guitar6, position: 1 })
    expect(steps).toHaveLength(24) // 6 strings x 4
    expect(steps[0]!.midi).toBe(fretMidi(guitar6, 0, 1))
  })

  it('skips cells that fall off the board', () => {
    const crossing: ExercisePattern = {
      id: 'x',
      name: 'x',
      description: 'x',
      motif: [
        { fret: 0, finger: 1 },
        { fret: 0, finger: 1, stringOffset: 1 }, // reaches to the next string up
      ],
      traversal: 'ascending',
    }
    const steps = expandPattern(crossing, { tuning: bass4, position: 5 })
    // On the top string (index 3) the stringOffset:+1 cell (string 4) is dropped.
    const topStringCells = steps.filter((s) => s.string >= bass4.strings.length)
    expect(topStringCells).toHaveLength(0)
    // Every remaining string index is valid.
    expect(steps.every((s) => s.string >= 0 && s.string < bass4.strings.length)).toBe(true)
  })

  it('drops negative frets when the position is at the nut', () => {
    const reach: ExercisePattern = {
      id: 'r',
      name: 'r',
      description: 'r',
      motif: [{ fret: -1, finger: 1 }, { fret: 0, finger: 2 }],
      traversal: 'ascending',
    }
    const steps = expandPattern(reach, { tuning: bass4, position: 0 })
    expect(steps.every((s) => s.fret >= 0)).toBe(true)
  })
})

describe('stepTimings', () => {
  it('accumulates onsets from durations', () => {
    const timing = stepTimings([{ duration: 1 }, { duration: 2 }, { duration: 1 }])
    expect(timing.onsets).toEqual([0, 1, 3])
    expect(timing.totalGridSteps).toBe(4)
  })

  it('treats missing/invalid durations as 1', () => {
    const timing = stepTimings([{ duration: 0 }, { duration: 1 }])
    expect(timing.onsets).toEqual([0, 1])
    expect(timing.totalGridSteps).toBe(2)
  })
})

describe('locateStep', () => {
  const timing = stepTimings([{ duration: 1 }, { duration: 1 }, { duration: 1 }, { duration: 1 }])

  it('maps grid steps to pattern step indices', () => {
    expect(locateStep(0, timing)).toEqual({ loop: 0, stepIndex: 0, isOnset: true })
    expect(locateStep(2, timing)).toEqual({ loop: 0, stepIndex: 2, isOnset: true })
  })

  it('wraps and counts loops', () => {
    expect(locateStep(4, timing)).toEqual({ loop: 1, stepIndex: 0, isOnset: true })
    expect(locateStep(9, timing)).toEqual({ loop: 2, stepIndex: 1, isOnset: true })
  })

  it('marks non-onset grid steps for multi-step durations', () => {
    const held = stepTimings([{ duration: 2 }, { duration: 2 }])
    expect(locateStep(0, held)).toEqual({ loop: 0, stepIndex: 0, isOnset: true })
    expect(locateStep(1, held)).toEqual({ loop: 0, stepIndex: 0, isOnset: false })
    expect(locateStep(2, held)).toEqual({ loop: 0, stepIndex: 1, isOnset: true })
  })

  it('returns null for an empty pattern', () => {
    expect(locateStep(0, stepTimings([]))).toBeNull()
  })
})

describe('positionForLoop', () => {
  it('never moves when auto-advance is off (no range)', () => {
    expect(positionForLoop(0, 5)).toBe(5)
    expect(positionForLoop(9, 5)).toBe(5)
  })

  it('advances one fret per loop, wrapping within the range', () => {
    const range = { min: 1, max: 3 }
    expect(positionForLoop(0, 1, range)).toBe(1)
    expect(positionForLoop(1, 1, range)).toBe(2)
    expect(positionForLoop(2, 1, range)).toBe(3)
    expect(positionForLoop(3, 1, range)).toBe(1) // wraps back to min
  })

  it('clamps the start into the range first', () => {
    expect(positionForLoop(0, 99, { min: 2, max: 5 })).toBe(5)
    expect(positionForLoop(0, -3, { min: 2, max: 5 })).toBe(2)
  })

  it('collapses to min for a degenerate range', () => {
    expect(positionForLoop(4, 7, { min: 3, max: 3 })).toBe(3)
  })
})

describe('getPattern', () => {
  it('returns a known pattern by id', () => {
    expect(getPattern('chromatic-4nps')).toBe(CHROMATIC_4NPS)
  })

  it('falls back to the default for an unknown id', () => {
    expect(getPattern('nope')).toBe(SPIDER_1234_UPDOWN)
  })

  it('every builtin has a unique id and a non-empty motif', () => {
    const ids = BUILTIN_PATTERNS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(BUILTIN_PATTERNS.every((p) => p.motif.length > 0)).toBe(true)
  })
})
