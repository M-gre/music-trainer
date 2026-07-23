import { describe, expect, it } from 'vitest'
import { stepTimings } from './exercises.ts'
import {
  DEFAULT_SEQUENCE_ID,
  expandScaleSequence,
  getSequencePattern,
  isSequencePatternId,
  positionScaleTones,
  SEQUENCE_PATTERNS,
  sequenceIndices,
  type PositionTone,
} from './scaleSequences.ts'
import { fretMidi, getTuning } from './theory/instruments.ts'
import { getScale } from './theory/scales.ts'

const bass4 = getTuning('bass-4')
const guitar6 = getTuning('guitar-6')
const cMajor = getScale('major')
const C = 0

/** Compact a tone to the fields the assertions care about. */
function cell(t: PositionTone) {
  return { string: t.string, fret: t.fret, finger: t.finger, midi: t.midi }
}

describe('positionScaleTones', () => {
  it('places C major in a 4-fret position on 4-string bass (EADG), string-major order', () => {
    // Anchor 2, window frets 2..5, C major = {C,D,E,F,G,A,B}.
    const tones = positionScaleTones(bass4, C, cMajor, 2).map(cell)
    expect(tones).toEqual([
      // low E string (28): G(3), A(5)
      { string: 0, fret: 3, finger: 2, midi: fretMidi(bass4, 0, 3) },
      { string: 0, fret: 5, finger: 4, midi: fretMidi(bass4, 0, 5) },
      // A string (33): B(2), C(3), D(5)
      { string: 1, fret: 2, finger: 1, midi: fretMidi(bass4, 1, 2) },
      { string: 1, fret: 3, finger: 2, midi: fretMidi(bass4, 1, 3) },
      { string: 1, fret: 5, finger: 4, midi: fretMidi(bass4, 1, 5) },
      // D string (38): E(2), F(3), G(5)
      { string: 2, fret: 2, finger: 1, midi: fretMidi(bass4, 2, 2) },
      { string: 2, fret: 3, finger: 2, midi: fretMidi(bass4, 2, 3) },
      { string: 2, fret: 5, finger: 4, midi: fretMidi(bass4, 2, 5) },
      // G string (43): A(2), B(4), C(5)
      { string: 3, fret: 2, finger: 1, midi: fretMidi(bass4, 3, 2) },
      { string: 3, fret: 4, finger: 3, midi: fretMidi(bass4, 3, 4) },
      { string: 3, fret: 5, finger: 4, midi: fretMidi(bass4, 3, 5) },
    ])
    // Pitches climb monotonically across the position.
    const midis = tones.map((t) => t.midi)
    expect(midis).toEqual([...midis].sort((a, b) => a - b))
  })

  it('places C major on 6-string guitar (EADGBE) using real pitch math across the major-third G→B string', () => {
    const tones = positionScaleTones(guitar6, C, cMajor, 2)
    expect(tones.map((t) => t.midi)).toEqual([43, 45, 47, 48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 67, 69])

    // The B string (index 4) is a MAJOR THIRD above the G string (index 3),
    // not a fourth — so its C-major tones land on frets 3 (D) and 5 (E), NOT
    // the frets 2/4/5 a naive fret-offset copy of the G string would produce
    // (which would be C#, D#, E — wrong notes).
    const bString = tones.filter((t) => t.string === 4).map(cell)
    expect(bString).toEqual([
      { string: 4, fret: 3, finger: 2, midi: fretMidi(guitar6, 4, 3) },
      { string: 4, fret: 5, finger: 4, midi: fretMidi(guitar6, 4, 5) },
    ])
    // Those are D and E, one octave above the D/E on the D string.
    expect(bString.map((t) => t.midi % 12)).toEqual([2, 4])
  })

  it('assigns fingers by fret offset from the window start, clamped to 1..4', () => {
    // Chromatic scale fills every fret so we see the full finger progression.
    const chromatic = getScale('chromatic')
    const tones = positionScaleTones(bass4, C, chromatic, 5, 5).filter((t) => t.string === 0)
    expect(tones.map((t) => ({ fret: t.fret, finger: t.finger }))).toEqual([
      { fret: 5, finger: 1 },
      { fret: 6, finger: 2 },
      { fret: 7, finger: 3 },
      { fret: 8, finger: 4 },
      { fret: 9, finger: 4 }, // offset 4 clamps to the pinky
    ])
  })

  it('clips frets below the nut when the anchor is negative', () => {
    // Anchor -1, span 4 → candidate frets -1,0,1,2; the -1 is dropped.
    const tones = positionScaleTones(bass4, C, cMajor, -1)
    expect(tones.every((t) => t.fret >= 0)).toBe(true)
    expect(Math.min(...tones.map((t) => t.fret))).toBe(0)
  })

  it('honours a custom span', () => {
    const narrow = positionScaleTones(bass4, C, cMajor, 2, 2) // frets 2..3 only
    expect(narrow.every((t) => t.fret >= 2 && t.fret <= 3)).toBe(true)
    const wide = positionScaleTones(bass4, C, cMajor, 2, 5) // frets 2..6
    expect(wide.length).toBeGreaterThan(narrow.length)
  })
})

describe('sequenceIndices', () => {
  it('diatonic-3rds pairs each degree with the one two steps up', () => {
    expect(sequenceIndices('diatonic-3rds', 5)).toEqual([0, 2, 1, 3, 2, 4])
  })
  it('diatonic-4ths pairs each degree with the one three steps up', () => {
    expect(sequenceIndices('diatonic-4ths', 5)).toEqual([0, 3, 1, 4])
  })
  it('groups-of-3 walks three consecutive degrees per start', () => {
    expect(sequenceIndices('groups-of-3', 5)).toEqual([0, 1, 2, 1, 2, 3, 2, 3, 4])
  })
  it('groups-of-4 walks four consecutive degrees per start', () => {
    expect(sequenceIndices('groups-of-4', 5)).toEqual([0, 1, 2, 3, 1, 2, 3, 4])
  })
  it('up-and-back turns back on the middle note (1-2-3-2 …)', () => {
    expect(sequenceIndices('up-and-back', 5)).toEqual([0, 1, 2, 1, 1, 2, 3, 2, 2, 3, 4, 3])
  })
  it('returns [] when the position has too few tones for even one group', () => {
    expect(sequenceIndices('diatonic-3rds', 2)).toEqual([])
    expect(sequenceIndices('groups-of-4', 3)).toEqual([])
    expect(sequenceIndices('up-and-back', 2)).toEqual([])
  })
})

describe('sequence pattern registry', () => {
  it('recognises its own ids and rejects others', () => {
    expect(isSequencePatternId('diatonic-3rds')).toBe(true)
    expect(isSequencePatternId('groups-of-4')).toBe(true)
    expect(isSequencePatternId('bogus')).toBe(false)
  })
  it('looks patterns up with a default fallback', () => {
    expect(getSequencePattern('groups-of-3').id).toBe('groups-of-3')
    expect(getSequencePattern('nope').id).toBe(DEFAULT_SEQUENCE_ID)
  })
  it('the default id is a real pattern', () => {
    expect(SEQUENCE_PATTERNS.some((p) => p.id === DEFAULT_SEQUENCE_ID)).toBe(true)
  })
})

describe('expandScaleSequence', () => {
  it('emits ExerciseStep[] whose first group is the sequence applied to the ordered tones', () => {
    const tones = positionScaleTones(bass4, C, cMajor, 2)
    const steps = expandScaleSequence({
      tuning: bass4,
      root: C,
      scale: cMajor,
      patternId: 'diatonic-3rds',
      anchor: 2,
    })
    // 11 tones → 9 pairs → 18 steps.
    expect(steps).toHaveLength(18)
    // First pair is tone 0 then tone 2 (a diatonic third: G then B).
    expect(steps.slice(0, 2)).toEqual([
      { string: tones[0]!.string, fret: tones[0]!.fret, finger: tones[0]!.finger, duration: 1, midi: tones[0]!.midi },
      { string: tones[2]!.string, fret: tones[2]!.fret, finger: tones[2]!.finger, duration: 1, midi: tones[2]!.midi },
    ])
    // Every step lasts one grid slot, so it feeds the scheduler timing cleanly.
    expect(steps.every((s) => s.duration === 1)).toBe(true)
    expect(stepTimings(steps).totalGridSteps).toBe(18)
  })

  it('works on 6-string guitar via the same pitch math', () => {
    const steps = expandScaleSequence({
      tuning: guitar6,
      root: C,
      scale: cMajor,
      patternId: 'groups-of-4',
      anchor: 2,
    })
    // 15 tones → 12 starts × 4 notes = 48 steps.
    expect(steps).toHaveLength(48)
    expect(steps[0]!.midi).toBe(43) // low-E-string G
  })

  it('returns [] when the position is too sparse for the pattern', () => {
    const steps = expandScaleSequence({
      tuning: bass4,
      root: C,
      scale: cMajor,
      patternId: 'diatonic-4ths',
      anchor: 2,
      span: 1, // one fret per string → at most a few scattered tones
    })
    // A single-fret window yields fewer than 4 ordered tones on bass, so the
    // 4ths window never fits.
    expect(steps).toEqual([])
  })
})
