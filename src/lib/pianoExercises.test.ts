import { describe, expect, it } from 'vitest'
import { nameToMidi } from './theory/notes.ts'
import {
  applyPianoDirection,
  buildFiveFinger,
  buildScale,
  clampPianoOctave,
  fiveFingerFinger,
  hasMajorScaleFingering,
  isFiveFingerPatternId,
  isFiveFingerQuality,
  isHand,
  isPianoExerciseKind,
  isScaleOctaves,
  MAX_PIANO_OCTAVE,
  MIN_PIANO_OCTAVE,
  rootMidi,
  scaleFingers,
  scaleMidis,
  type PianoFinger,
  type PianoStep,
} from './pianoExercises.ts'

const fingers = (steps: readonly PianoStep[]): PianoFinger[] => steps.map((s) => s.finger)
const midis = (steps: readonly PianoStep[]): number[] => steps.map((s) => s.midi)

describe('rootMidi / clampPianoOctave', () => {
  it('places C4 at midi 60', () => {
    expect(rootMidi(0, 4)).toBe(60)
    expect(rootMidi(9, 4)).toBe(69) // A4 = 440Hz reference
  })
  it('clamps octaves into range', () => {
    expect(clampPianoOctave(-5)).toBe(MIN_PIANO_OCTAVE)
    expect(clampPianoOctave(99)).toBe(MAX_PIANO_OCTAVE)
    expect(clampPianoOctave(4)).toBe(4)
    expect(clampPianoOctave(Number.NaN)).toBe(4)
  })
})

describe('fiveFingerFinger', () => {
  it('runs thumb→pinky for the right hand', () => {
    expect([0, 1, 2, 3, 4].map((d) => fiveFingerFinger(d, 'right'))).toEqual([1, 2, 3, 4, 5])
  })
  it('runs pinky→thumb for the left hand', () => {
    expect([0, 1, 2, 3, 4].map((d) => fiveFingerFinger(d, 'left'))).toEqual([5, 4, 3, 2, 1])
  })
})

describe('buildFiveFinger', () => {
  it('plays C major up-and-down with RH fingers 1-2-3-4-5-4-3-2-1', () => {
    const steps = buildFiveFinger({ root: 0, octave: 4, quality: 'major', patternId: 'up-down', hand: 'right' })
    expect(fingers(steps)).toEqual([1, 2, 3, 4, 5, 4, 3, 2, 1])
    // C D E F G F E D C around middle C.
    expect(midis(steps)).toEqual([60, 62, 64, 65, 67, 65, 64, 62, 60])
    expect(steps.every((s) => s.hand === 'right')).toBe(true)
  })

  it('flattens the third for a D minor five-finger pattern (LH fingers 5-4-3-2-1…)', () => {
    // D minor five-finger box: D E F G A (root, +2, +3, +5, +7).
    const steps = buildFiveFinger({ root: 2, octave: 3, quality: 'minor', patternId: 'up-down', hand: 'left' })
    const D3 = nameToMidi('D3')
    expect(midis(steps)).toEqual([
      D3,
      D3 + 2, // E3
      D3 + 3, // F3 (minor third)
      D3 + 5, // G3
      D3 + 7, // A3
      D3 + 5,
      D3 + 3,
      D3 + 2,
      D3,
    ])
    // Left hand: pinky on the low root, thumb on the top note.
    expect(fingers(steps)).toEqual([5, 4, 3, 2, 1, 2, 3, 4, 5])
  })

  it('broken thirds skip a finger and never repeat a note in place', () => {
    const steps = buildFiveFinger({ root: 0, octave: 4, quality: 'major', patternId: 'broken-thirds', hand: 'right' })
    expect(fingers(steps)).toEqual([1, 3, 2, 4, 3, 5, 4, 2, 3, 1])
    // No two adjacent notes are the same pitch.
    const m = midis(steps)
    expect(m.some((v, i) => i > 0 && v === m[i - 1])).toBe(false)
  })

  it('hanon figure loops to the pinky and back to the index without resolving', () => {
    const steps = buildFiveFinger({ root: 0, octave: 4, quality: 'major', patternId: 'hanon-1', hand: 'right' })
    expect(fingers(steps)).toEqual([1, 2, 3, 4, 5, 4, 3, 2])
  })
})

describe('scaleMidis', () => {
  it('is an ascending C major scale, one octave = 8 notes ending on the octave', () => {
    expect(scaleMidis(0, 4, 1)).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
  })
  it('two octaves = 15 notes ending two octaves up', () => {
    const m = scaleMidis(0, 4, 2)
    expect(m).toHaveLength(15)
    expect(m[0]).toBe(60)
    expect(m[7]).toBe(72) // octave boundary
    expect(m[14]).toBe(84)
  })
})

describe('scaleFingers — one octave (standard fingerings)', () => {
  it('C major RH: 1-2-3-1-2-3-4-5', () => {
    expect(scaleFingers(0, 'right', 1)).toEqual([1, 2, 3, 1, 2, 3, 4, 5])
  })
  it('C major LH: 5-4-3-2-1-3-2-1', () => {
    expect(scaleFingers(0, 'left', 1)).toEqual([5, 4, 3, 2, 1, 3, 2, 1])
  })
  it('F major RH crosses the thumb after the 4th finger: 1-2-3-4-1-2-3-4', () => {
    // The thumb-under lands on Bb → white-key F... the crossing is at index 4.
    const f = scaleFingers(5, 'right', 1)
    expect(f).toEqual([1, 2, 3, 4, 1, 2, 3, 4])
    expect(f[4]).toBe(1) // thumb crossing point
  })
  it('B major LH is the exception 4-3-2-1-4-3-2-1', () => {
    expect(scaleFingers(11, 'left', 1)).toEqual([4, 3, 2, 1, 4, 3, 2, 1])
  })
  it('black-key scales never start the thumb on the tonic', () => {
    // Db, Eb, Gb, Ab, Bb tonics — RH and LH first finger is never the thumb.
    for (const pc of [1, 3, 6, 8, 10]) {
      expect(scaleFingers(pc, 'right', 1)[0]).not.toBe(1)
      expect(scaleFingers(pc, 'left', 1)[0]).not.toBe(1)
    }
  })
  it('provides a fingering for every one of the twelve pitch classes', () => {
    for (let pc = 0; pc < 12; pc += 1) {
      expect(hasMajorScaleFingering(pc)).toBe(true)
      expect(scaleFingers(pc, 'right', 1)).toHaveLength(8)
      expect(scaleFingers(pc, 'left', 1)).toHaveLength(8)
    }
  })
})

describe('scaleFingers — two-octave continuation', () => {
  it('C major RH repeats the octave cycle and only ends on the pinky', () => {
    // Cycle 1-2-3-1-2-3-4 twice, then terminal 5.
    expect(scaleFingers(0, 'right', 2)).toEqual([1, 2, 3, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 4, 5])
  })
  it('C major LH starts on the pinky but crosses to the thumb at the boundary', () => {
    expect(scaleFingers(0, 'left', 2)).toEqual([5, 4, 3, 2, 1, 3, 2, 1, 4, 3, 2, 1, 3, 2, 1])
  })
  it('length is 7*octaves + 1 and matches the midi count', () => {
    for (const pc of [0, 5, 10, 11]) {
      for (const octaves of [1, 2] as const) {
        const f = scaleFingers(pc, 'right', octaves)
        expect(f).toHaveLength(7 * octaves + 1)
        expect(f).toHaveLength(scaleMidis(pc, 4, octaves).length)
      }
    }
  })
  it('never plays two consecutive notes with the thumb (no stuck thumb at the boundary)', () => {
    for (let pc = 0; pc < 12; pc += 1) {
      for (const hand of ['right', 'left'] as const) {
        const f = scaleFingers(pc, hand, 2)
        const adjacentThumbs = f.some((v, i) => i > 0 && v === 1 && f[i - 1] === 1)
        expect(adjacentThumbs).toBe(false)
      }
    }
  })
})

describe('buildScale', () => {
  it('pairs each pitch with its finger and hand for a two-octave G major LH scale', () => {
    const steps = buildScale({ root: 7, octave: 2, octaves: 2, hand: 'left' })
    expect(midis(steps)).toEqual(scaleMidis(7, 2, 2))
    expect(fingers(steps)).toEqual(scaleFingers(7, 'left', 2))
    expect(steps.every((s) => s.hand === 'left')).toBe(true)
  })
})

describe('applyPianoDirection', () => {
  const steps: PianoStep[] = [
    { midi: 60, finger: 1, hand: 'right' },
    { midi: 62, finger: 2, hand: 'right' },
    { midi: 64, finger: 3, hand: 'right' },
  ]
  it('forward keeps the order', () => {
    expect(midis(applyPianoDirection(steps, 'forward'))).toEqual([60, 62, 64])
  })
  it('reverse flips it', () => {
    expect(midis(applyPianoDirection(steps, 'reverse'))).toEqual([64, 62, 60])
  })
  it('forward-reverse plays up then down without repeating the turnaround', () => {
    expect(midis(applyPianoDirection(steps, 'forward-reverse'))).toEqual([60, 62, 64, 62, 60])
  })
  it('forward-reverse on a single step is unchanged', () => {
    expect(applyPianoDirection([steps[0]!], 'forward-reverse')).toHaveLength(1)
  })
})

describe('type guards', () => {
  it('validate persisted piano fields', () => {
    expect(isFiveFingerPatternId('broken-thirds')).toBe(true)
    expect(isFiveFingerPatternId('nope')).toBe(false)
    expect(isFiveFingerQuality('minor')).toBe(true)
    expect(isFiveFingerQuality('diminished')).toBe(false)
    expect(isHand('left')).toBe(true)
    expect(isHand('middle')).toBe(false)
    expect(isScaleOctaves(2)).toBe(true)
    expect(isScaleOctaves(3)).toBe(false)
    expect(isPianoExerciseKind('scale')).toBe(true)
    expect(isPianoExerciseKind('arpeggio')).toBe(false)
  })
})
