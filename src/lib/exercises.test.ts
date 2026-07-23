import { describe, expect, it } from 'vitest'
import { getTuning } from './theory/instruments.ts'
import { fretMidi } from './theory/instruments.ts'
import {
  ANCHOR_ADJACENT_STRING,
  ANCHOR_SAME_STRING,
  applyDirection,
  BUILTIN_PATTERNS,
  CHROMATIC_POSITION_SHIFT,
  expandPattern,
  getPattern,
  LEGATO_HAMMER_ASC,
  LEGATO_PULL_DESC,
  LEGATO_TRILL_COMBO,
  locateStep,
  patternsByCategory,
  POSITION_SHIFT_1234,
  positionForLoop,
  RAKE_ARPEGGIO,
  ROLL_ONE_FINGER,
  ROLL_PER_STRING,
  SIXTHS_SKIP_STRING,
  SPIDER_1234_UPDOWN,
  SPIDER_1324_UPDOWN,
  SPIDER_2413_UPDOWN,
  SPIDER_3142_UPDOWN,
  SPIDER_4231_UPDOWN,
  spiderMotif,
  stepTimings,
  STRETCH_124,
  STRETCH_134,
  STRETCH_14_SPAN,
  STRING_CROSSING_12,
  THREE_NPS_SHIFT,
  TRILL_12,
  TRILL_13,
  TRILL_14,
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

const CHROMATIC_ASCENDING_ONLY: ExercisePattern = {
  id: 'chromatic-ascending-only-fixture',
  name: 'fixture',
  description: 'fixture',
  motif: spiderMotif([1, 2, 3, 4]),
  traversal: 'ascending',
  category: 'spider',
}

describe('expandPattern', () => {
  it('expands an ascending chromatic run across every string, low to high', () => {
    const steps = expandPattern(CHROMATIC_ASCENDING_ONLY, { tuning: bass4, position: 5 })
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
    const at3 = expandPattern(CHROMATIC_ASCENDING_ONLY, { tuning: bass4, position: 3 })
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
    const steps = expandPattern(CHROMATIC_ASCENDING_ONLY, { tuning: guitar6, position: 1 })
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
      category: 'crossing',
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
      category: 'shift',
    }
    const steps = expandPattern(reach, { tuning: bass4, position: 0 })
    expect(steps.every((s) => s.fret >= 0)).toBe(true)
  })
})

describe('spider-walk permutations', () => {
  it('1-3-2-4 plays the permuted finger order per string, up then down', () => {
    const steps = expandPattern(SPIDER_1324_UPDOWN, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(32)
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
    ])
    // Turnaround: the top string's last ascending cell repeats as the first descending cell.
    expect(steps[15]).toMatchObject({ string: 3, fret: 8, finger: 4 })
    expect(steps[16]).toMatchObject({ string: 3, fret: 8, finger: 4 })
  })

  it('2-4-1-3 renders correctly on guitar-6', () => {
    const steps = expandPattern(SPIDER_2413_UPDOWN, { tuning: guitar6, position: 5 })
    expect(steps).toHaveLength(48) // 6 strings x 4, up and down
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(guitar6, 0, 6) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(guitar6, 0, 8) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(guitar6, 0, 5) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(guitar6, 0, 7) },
    ])
  })

  it('4-2-3-1 starts pinky-first', () => {
    const steps = expandPattern(SPIDER_4231_UPDOWN, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
    ])
  })

  it('3-1-4-2 skips a finger on every consecutive pair', () => {
    const steps = expandPattern(SPIDER_3142_UPDOWN, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4).map((s) => s.finger)).toEqual([3, 1, 4, 2])
  })

  it('every permutation is a genuine reordering of 1-2-3-4 (same fret set, different order)', () => {
    for (const pattern of [SPIDER_1324_UPDOWN, SPIDER_2413_UPDOWN, SPIDER_4231_UPDOWN, SPIDER_3142_UPDOWN]) {
      const frets = pattern.motif.map((c) => c.fret).sort((a, b) => a - b)
      expect(frets).toEqual([0, 1, 2, 3])
      const fingers = pattern.motif.map((c) => c.finger).sort()
      expect(fingers).toEqual([1, 2, 3, 4])
    }
  })
})

describe('string-crossing drills', () => {
  it('String Crossing 1-2 Walk alternates fingers 1-2 across adjacent strings', () => {
    const steps = expandPattern(STRING_CROSSING_12, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(16) // 2 notes x 4 strings, up and down
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 1, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 1, 5) },
      { string: 1, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 1, 6) },
    ])
  })

  it('Skip-String Sixths pairs a root with a note two strings up', () => {
    const steps = expandPattern(SIXTHS_SKIP_STRING, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 2, fret: 7, finger: 4, duration: 1, midi: fretMidi(bass4, 2, 7) },
      { string: 1, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 1, 5) },
      { string: 3, fret: 7, finger: 4, duration: 1, midi: fretMidi(bass4, 3, 7) },
    ])
  })

  it('Skip-String Sixths drops the skip-string half on the top strings of a small instrument', () => {
    // On bass-4, base strings 2 and 3 can't reach two strings up (5 and 6 don't exist),
    // so only the root note survives for those two passes: 2+2+1+1 = 6 steps total.
    const steps = expandPattern(SIXTHS_SKIP_STRING, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(6)
    expect(steps.slice(4)).toEqual([
      { string: 2, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 2, 5) },
      { string: 3, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 3, 5) },
    ])
    // Every remaining string index is valid.
    expect(steps.every((s) => s.string >= 0 && s.string < bass4.strings.length)).toBe(true)
  })

  it('Skip-String Sixths has more headroom on guitar-6 (only the top two strings drop the pair)', () => {
    const steps = expandPattern(SIXTHS_SKIP_STRING, { tuning: guitar6, position: 5 })
    expect(steps).toHaveLength(10) // 4 full pairs + 2 single roots
    expect(steps.every((s) => s.string >= 0 && s.string < guitar6.strings.length)).toBe(true)
  })

  it('Raking Arpeggio Crossing walks a diagonal shape one fret and string higher per note', () => {
    const steps = expandPattern(RAKE_ARPEGGIO, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 1, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 1, 6) },
      { string: 2, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 2, 7) },
      { string: 3, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 3, 8) },
    ])
  })

  it('Raking Arpeggio Crossing shrinks near the top string on a small instrument', () => {
    // base=0 gives all 4 notes; base=1 gives 3 (string 4 is out of range); base=2 gives 2;
    // base=3 gives 1: 4+3+2+1 = 10 total on bass-4.
    const steps = expandPattern(RAKE_ARPEGGIO, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(10)
    expect(steps.every((s) => s.string >= 0 && s.string < bass4.strings.length)).toBe(true)
  })

  it('Raking Arpeggio Crossing has more room to run on guitar-6', () => {
    const steps = expandPattern(RAKE_ARPEGGIO, { tuning: guitar6, position: 5 })
    expect(steps).toHaveLength(18) // 4+4+4+3+2+1
    expect(steps.every((s) => s.string >= 0 && s.string < guitar6.strings.length)).toBe(true)
  })
})

describe('position-shift drills', () => {
  it('Position Shift 1-2-3-4 plays 1-2-3-4 then shifts up a fret and repeats it on the same string', () => {
    const steps = expandPattern(POSITION_SHIFT_1234, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(32) // 8 notes x 4 strings
    expect(steps.slice(0, 8)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 6, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 7, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 8, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 9, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 9) },
    ])
  })

  it('Position Shift 1-2-3-4 spans beyond the plain 4-fret box', () => {
    const frets = POSITION_SHIFT_1234.motif.map((c) => c.fret)
    expect(Math.max(...frets) - Math.min(...frets)).toBeGreaterThan(3)
  })

  it('3-Notes-Per-String Shifting Run climbs two frets per string', () => {
    const steps = expandPattern(THREE_NPS_SHIFT, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 6)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 9, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 9) },
      { string: 1, fret: 7, finger: 1, duration: 1, midi: fretMidi(bass4, 1, 7) },
      { string: 1, fret: 9, finger: 3, duration: 1, midi: fretMidi(bass4, 1, 9) },
      { string: 1, fret: 11, finger: 4, duration: 1, midi: fretMidi(bass4, 1, 11) },
    ])
  })

  it('3-Notes-Per-String Shifting Run drops the far rows near the top string of a small instrument', () => {
    // base=0 and base=1 fit all three rows (9 notes each); base=2 fits two rows (6); base=3 fits one row (3).
    const steps = expandPattern(THREE_NPS_SHIFT, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(27)
    expect(steps.every((s) => s.string >= 0 && s.string < bass4.strings.length)).toBe(true)
  })

  it('3-Notes-Per-String Shifting Run has more headroom on guitar-6', () => {
    const steps = expandPattern(THREE_NPS_SHIFT, { tuning: guitar6, position: 5 })
    expect(steps).toHaveLength(45)
    expect(steps.every((s) => s.string >= 0 && s.string < guitar6.strings.length)).toBe(true)
  })
})

describe('continuous chromatic run (Continuous Chromatic Run / chromatic-4nps)', () => {
  it('is distinct from the plain 1-2-3-4 box: consecutive strings do not repeat the same frets', () => {
    const steps = expandPattern(CHROMATIC_POSITION_SHIFT, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(16)
    // String 0 plays frets 5-8; string 1 shifts down a fret to 4-7 (a perfect fourth
    // higher open string means continuing the same pitch climb lands one fret lower).
    expect(steps.slice(0, 8)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 1, fret: 4, finger: 1, duration: 1, midi: fretMidi(bass4, 1, 4) },
      { string: 1, fret: 5, finger: 2, duration: 1, midi: fretMidi(bass4, 1, 5) },
      { string: 1, fret: 6, finger: 3, duration: 1, midi: fretMidi(bass4, 1, 6) },
      { string: 1, fret: 7, finger: 4, duration: 1, midi: fretMidi(bass4, 1, 7) },
    ])
  })

  it('never repeats or skips a semitone across the whole run', () => {
    const steps = expandPattern(CHROMATIC_POSITION_SHIFT, { tuning: bass4, position: 5 })
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.midi).toBe(steps[i - 1]!.midi + 1)
    }
  })

  it('stays continuous even across a non-uniform string interval (guitar-6 G-B major third)', () => {
    const steps = expandPattern(CHROMATIC_POSITION_SHIFT, { tuning: guitar6, position: 5 })
    expect(steps).toHaveLength(24)
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.midi).toBe(steps[i - 1]!.midi + 1)
    }
  })

  it('drops slots that would fall below the nut near the bottom of the neck (board-edge handling)', () => {
    const steps = expandPattern(CHROMATIC_POSITION_SHIFT, { tuning: guitar6, position: 1 })
    // Several early slots on the higher strings land below fret 0 and are dropped.
    expect(steps.length).toBeLessThan(24)
    expect(steps.every((s) => s.fret >= 0)).toBe(true)
    // Still gap-free among the notes that do survive.
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i]!.midi).toBeGreaterThan(steps[i - 1]!.midi)
    }
  })
})

describe('applyDirection', () => {
  const steps = expandPattern(STRING_CROSSING_12, { tuning: bass4, position: 5 }).slice(0, 4)

  it('forward returns the steps unchanged', () => {
    expect(applyDirection(steps, 'forward')).toEqual(steps)
  })

  it('reverse plays the steps back-to-front', () => {
    expect(applyDirection(steps, 'reverse')).toEqual([...steps].reverse())
  })

  it('forward-reverse concatenates without repeating the turnaround step', () => {
    const result = applyDirection(steps, 'forward-reverse')
    expect(result).toHaveLength(steps.length * 2 - 1)
    expect(result).toEqual([...steps, ...[...steps].slice(0, -1).reverse()])
    // The last step never appears twice in a row.
    for (let i = 1; i < result.length; i += 1) {
      expect(result[i]).not.toEqual(result[i - 1])
    }
  })

  it('handles empty and single-step sequences', () => {
    expect(applyDirection([], 'forward-reverse')).toEqual([])
    const one = steps.slice(0, 1)
    expect(applyDirection(one, 'reverse')).toEqual(one)
    expect(applyDirection(one, 'forward-reverse')).toEqual(one)
  })
})

describe('finger-roll drills', () => {
  it('Index Roll rolls one finger across every string at the same fret, up then down', () => {
    const steps = expandPattern(ROLL_ONE_FINGER, { tuning: bass4, position: 5 })
    // 4 strings up + 4 strings down, single note each.
    expect(steps).toHaveLength(8)
    expect(steps.every((s) => s.fret === 5 && s.finger === 1)).toBe(true)
    expect(steps.map((s) => s.string)).toEqual([0, 1, 2, 3, 3, 2, 1, 0])
  })

  it('Finger-Per-String Roll plants one finger per adjacent string on a single fret', () => {
    const steps = expandPattern(ROLL_PER_STRING, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 1, fret: 5, finger: 2, duration: 1, midi: fretMidi(bass4, 1, 5) },
      { string: 2, fret: 5, finger: 3, duration: 1, midi: fretMidi(bass4, 2, 5) },
      { string: 3, fret: 5, finger: 4, duration: 1, midi: fretMidi(bass4, 3, 5) },
    ])
    // Every note sits on the same fret (no shift) and stays on the board.
    expect(steps.every((s) => s.fret === 5 && s.string >= 0 && s.string < bass4.strings.length)).toBe(true)
  })

  it('renders on any string count (tuning-aware)', () => {
    const steps = expandPattern(ROLL_ONE_FINGER, { tuning: guitar6, position: 3 })
    expect(steps).toHaveLength(12) // 6 strings up + 6 down
    expect(steps.every((s) => s.fret === 3)).toBe(true)
  })
})

describe('trill / burst drills', () => {
  it('Trill 1-2 alternates index and middle a half step apart on each string', () => {
    const steps = expandPattern(TRILL_12, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(16) // 4-note burst x 4 strings
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
    ])
  })

  it('widens the trill span with the finger pair (1-3 whole step, 1-4 minor third)', () => {
    const t13 = expandPattern(TRILL_13, { tuning: bass4, position: 5 })
    expect(t13.slice(0, 2)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
    ])
    const t14 = expandPattern(TRILL_14, { tuning: bass4, position: 5 })
    expect(t14.slice(0, 2)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
    ])
  })
})

describe('wide-stretch drills', () => {
  it('1-2-4 spans frets 0-2-4 with fingers 1-2-4, up then down', () => {
    const steps = expandPattern(STRETCH_124, { tuning: bass4, position: 5 })
    expect(steps).toHaveLength(24) // 3-note motif x 4 strings, up and down
    expect(steps.slice(0, 3)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 7, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 9, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 9) },
    ])
    // Turnaround: top string's last ascending note repeats reversed.
    expect(steps[11]).toMatchObject({ string: 3, fret: 9, finger: 4 })
    expect(steps[12]).toMatchObject({ string: 3, fret: 9, finger: 4 })
  })

  it('1-3-4 spans frets 0-3-4 with fingers 1-3-4', () => {
    const steps = expandPattern(STRETCH_134, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 3)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 8, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 9, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 9) },
    ])
  })

  it('five-fret span reaches from index to pinky five frets apart', () => {
    const steps = expandPattern(STRETCH_14_SPAN, { tuning: bass4, position: 3 })
    expect(steps.slice(0, 2)).toEqual([
      { string: 0, fret: 3, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 3) },
      { string: 0, fret: 7, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 7) },
    ])
    // Index-to-pinky spans five frets (inclusive).
    expect(steps[1]!.fret - steps[0]!.fret).toBe(4)
  })

  it('renders on guitar-6 (tuning-aware string count)', () => {
    const steps = expandPattern(STRETCH_124, { tuning: guitar6, position: 5 })
    expect(steps).toHaveLength(36) // 3 x 6 strings, up and down
  })
})

describe('anchor-hold drills', () => {
  it('same-string variant returns to the finger-1 anchor between 2, 3, 4', () => {
    const steps = expandPattern(ANCHOR_SAME_STRING, { tuning: bass4, position: 5 })
    // One pass per string (ascending), 6 notes each.
    expect(steps.slice(0, 6)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7) },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
    ])
    // The anchor (finger 1, base fret) recurs at every even index of the pass.
    const firstPass = steps.slice(0, 6)
    expect(firstPass.filter((_, i) => i % 2 === 0).every((s) => s.finger === 1 && s.fret === 5)).toBe(true)
  })

  it('adjacent-string variant keeps the anchor on the base string, movers one string up', () => {
    const steps = expandPattern(ANCHOR_ADJACENT_STRING, { tuning: bass4, position: 5 })
    const firstPass = steps.slice(0, 6)
    // Anchor notes stay on string 0; movers (finger 2/3/4) sit on string 1.
    expect(firstPass.filter((s) => s.finger === 1).every((s) => s.string === 0)).toBe(true)
    expect(firstPass.filter((s) => s.finger !== 1).every((s) => s.string === 1)).toBe(true)
    expect(firstPass[1]).toMatchObject({ string: 1, fret: 6, finger: 2 })
    expect(firstPass[5]).toMatchObject({ string: 1, fret: 8, finger: 4 })
  })
})

describe('legato drills', () => {
  it('hammer-on run tags fingers 2-3-4 as hammered, leaves the picked note plain', () => {
    const steps = expandPattern(LEGATO_HAMMER_ASC, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5) },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6), articulation: 'hammer' },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7), articulation: 'hammer' },
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8), articulation: 'hammer' },
    ])
    // The first note of each string is picked (no articulation key).
    expect('articulation' in steps[0]!).toBe(false)
  })

  it('pull-off run picks the pinky note then tags 3-2-1 as pulled', () => {
    const steps = expandPattern(LEGATO_PULL_DESC, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4)).toEqual([
      { string: 0, fret: 8, finger: 4, duration: 1, midi: fretMidi(bass4, 0, 8) },
      { string: 0, fret: 7, finger: 3, duration: 1, midi: fretMidi(bass4, 0, 7), articulation: 'pull' },
      { string: 0, fret: 6, finger: 2, duration: 1, midi: fretMidi(bass4, 0, 6), articulation: 'pull' },
      { string: 0, fret: 5, finger: 1, duration: 1, midi: fretMidi(bass4, 0, 5), articulation: 'pull' },
    ])
  })

  it('trill combo alternates hammer and pull articulations', () => {
    const steps = expandPattern(LEGATO_TRILL_COMBO, { tuning: bass4, position: 5 })
    expect(steps.slice(0, 4).map((s) => s.articulation)).toEqual([undefined, 'hammer', 'pull', 'hammer'])
  })

  it('non-legato patterns produce steps with no articulation key', () => {
    const steps = expandPattern(SPIDER_1234_UPDOWN, { tuning: bass4, position: 5 })
    expect(steps.every((s) => !('articulation' in s))).toBe(true)
  })
})

describe('patternsByCategory', () => {
  it('groups every builtin pattern into exactly one category', () => {
    const groups = patternsByCategory()
    const total = groups.reduce((sum, g) => sum + g.patterns.length, 0)
    expect(total).toBe(BUILTIN_PATTERNS.length)
    expect(groups.map((g) => g.category)).toEqual([
      'spider',
      'crossing',
      'shift',
      'roll',
      'trill',
      'stretch',
      'anchor',
      'legato',
    ])
    expect(groups.every((g) => g.patterns.length > 0)).toBe(true)
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
    expect(getPattern('chromatic-4nps')).toBe(CHROMATIC_POSITION_SHIFT)
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
