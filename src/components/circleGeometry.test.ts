import { describe, expect, it } from 'vitest'
import {
  CIRCLE_KEYS,
  CIRCLE_SEGMENT_COUNT,
  SEGMENT_ANGLE_DEG,
  circleKeyForMajorPc,
  polarToCartesian,
  ringSegmentPath,
  segmentCenterAngle,
  segmentEndAngle,
  segmentLabelPosition,
  segmentStartAngle,
  signatureLabel,
  signatureNotes,
} from './circleGeometry.ts'

describe('CIRCLE_KEYS', () => {
  it('has 12 segments', () => {
    expect(CIRCLE_SEGMENT_COUNT).toBe(12)
    expect(CIRCLE_KEYS).toHaveLength(12)
  })

  it('orders major keys clockwise in fifths starting at C', () => {
    const names = CIRCLE_KEYS.map((k) => k.majorName)
    expect(names).toEqual(['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'Db', 'Ab', 'Eb', 'Bb', 'F'])
  })

  it('pairs each major key with its correct relative minor', () => {
    const minors = CIRCLE_KEYS.map((k) => k.minorName)
    expect(minors).toEqual(['A', 'E', 'B', 'F#', 'C#', 'G#', 'D#', 'Bb', 'F', 'C', 'G', 'D'])
  })

  it('assigns each index a distinct, ascending pitch class matching the theory circle of fifths', () => {
    const pcs = CIRCLE_KEYS.map((k) => k.majorPc)
    expect(new Set(pcs).size).toBe(12)
    // C, G, D, A, E, B, F#, Db, Ab, Eb, Bb, F
    expect(pcs).toEqual([0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5])
  })

  it('gives the correct signature (sharps positive, flats negative) per key', () => {
    const signatures = CIRCLE_KEYS.map((k) => k.signature)
    expect(signatures).toEqual([0, 1, 2, 3, 4, 5, 6, -5, -4, -3, -2, -1])
  })

  it('provides both enharmonic spellings only at the F#/Gb position', () => {
    CIRCLE_KEYS.forEach((k, i) => {
      if (i === 6) {
        expect(k.alt).toBeDefined()
        expect(k.alt?.majorName).toBe('Gb')
        expect(k.alt?.minorName).toBe('Eb')
        expect(k.alt?.signature).toBe(-6)
      } else {
        expect(k.alt).toBeUndefined()
      }
    })
  })

  it('looks up a circle key by major pitch class', () => {
    expect(circleKeyForMajorPc(0).majorName).toBe('C')
    expect(circleKeyForMajorPc(5).majorName).toBe('F')
    expect(circleKeyForMajorPc(6).majorName).toBe('F#')
  })

  it('throws for an invalid pitch class', () => {
    expect(() => circleKeyForMajorPc(0.5)).toThrow()
  })
})

describe('signatureLabel', () => {
  it('formats sharps, flats, and the natural key', () => {
    expect(signatureLabel(0)).toBe('0')
    expect(signatureLabel(3)).toBe('3♯')
    expect(signatureLabel(-2)).toBe('2♭')
    expect(signatureLabel(6)).toBe('6♯')
  })
})

describe('signatureNotes', () => {
  it('returns no accidentals for C major', () => {
    expect(signatureNotes(0)).toEqual([])
  })

  it('lists sharps in the conventional order', () => {
    expect(signatureNotes(3)).toEqual(['F#', 'C#', 'G#'])
  })

  it('lists flats in the conventional order', () => {
    expect(signatureNotes(-2)).toEqual(['Bb', 'Eb'])
  })

  it('handles the maximum 6/7-accidental keys', () => {
    expect(signatureNotes(6)).toEqual(['F#', 'C#', 'G#', 'D#', 'A#', 'E#'])
    expect(signatureNotes(-6)).toEqual(['Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'])
  })
})

describe('segment angles', () => {
  it('places index 0 at 12 o\'clock (0 degrees)', () => {
    expect(segmentCenterAngle(0)).toBe(0)
  })

  it('spaces segments evenly at 30 degrees apart, clockwise', () => {
    expect(SEGMENT_ANGLE_DEG).toBe(30)
    expect(segmentCenterAngle(1)).toBe(30)
    expect(segmentCenterAngle(3)).toBe(90)
    expect(segmentCenterAngle(6)).toBe(180)
    expect(segmentCenterAngle(9)).toBe(270)
  })

  it('wraps angles into [0, 360)', () => {
    expect(segmentCenterAngle(11)).toBe(330)
    expect(segmentCenterAngle(12)).toBe(0)
  })

  it('gives each segment a 30-degree span centred on its key angle', () => {
    for (let i = 0; i < 12; i++) {
      expect(segmentEndAngle(i) - segmentStartAngle(i)).toBeCloseTo(SEGMENT_ANGLE_DEG)
    }
  })
})

describe('polarToCartesian', () => {
  it('places 0 degrees straight up from centre', () => {
    const p = polarToCartesian(100, 100, 50, 0)
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(50)
  })

  it('places 90 degrees to the right (clockwise)', () => {
    const p = polarToCartesian(100, 100, 50, 90)
    expect(p.x).toBeCloseTo(150)
    expect(p.y).toBeCloseTo(100)
  })

  it('places 180 degrees straight down', () => {
    const p = polarToCartesian(100, 100, 50, 180)
    expect(p.x).toBeCloseTo(100)
    expect(p.y).toBeCloseTo(150)
  })

  it('places 270 degrees to the left', () => {
    const p = polarToCartesian(100, 100, 50, 270)
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(100)
  })
})

describe('ringSegmentPath', () => {
  it('produces a well-formed path with two arcs and a close', () => {
    const d = ringSegmentPath(100, 100, 50, 90, -15, 15)
    expect(d.startsWith('M ')).toBe(true)
    expect(d).toContain('A 90 90 0 0 1')
    expect(d).toContain('A 50 50 0 0 0')
    expect(d.endsWith('Z')).toBe(true)
  })

  it('sets the large-arc flag for spans over 180 degrees', () => {
    const d = ringSegmentPath(100, 100, 50, 90, 0, 200)
    expect(d).toContain('A 90 90 0 1 1')
  })
})

describe('segmentLabelPosition', () => {
  it('matches polarToCartesian at the segment center angle', () => {
    const pos = segmentLabelPosition(100, 100, 70, 3)
    const expected = polarToCartesian(100, 100, 70, segmentCenterAngle(3))
    expect(pos).toEqual(expected)
  })
})
