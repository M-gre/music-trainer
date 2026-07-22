import { describe, expect, it } from 'vitest'
import { nameToMidi } from '../lib/theory/notes.ts'
import {
  blackKeyMidis,
  blackKeyX,
  computeLayout,
  DEFAULT_LAYOUT,
  defaultKeyLabel,
  isBlackKey,
  isWhiteKey,
  keyCenterX,
  keyHeight,
  octaveRangeToMidi,
  snapRangeToWhite,
  whiteKeyIndex,
  whiteKeyMidis,
  whiteKeyX,
} from './keyboardGeometry.ts'

describe('isBlackKey / isWhiteKey', () => {
  it('classifies naturals as white keys', () => {
    for (const n of ['C4', 'D4', 'E4', 'F4', 'G4', 'A4', 'B4']) {
      expect(isWhiteKey(nameToMidi(n))).toBe(true)
      expect(isBlackKey(nameToMidi(n))).toBe(false)
    }
  })

  it('classifies accidentals as black keys', () => {
    for (const n of ['C#4', 'D#4', 'F#4', 'G#4', 'A#4']) {
      expect(isBlackKey(nameToMidi(n))).toBe(true)
      expect(isWhiteKey(nameToMidi(n))).toBe(false)
    }
  })

  it('is octave-independent', () => {
    expect(isBlackKey(nameToMidi('C#1'))).toBe(true)
    expect(isBlackKey(nameToMidi('C#7'))).toBe(true)
  })
})

describe('whiteKeyIndex', () => {
  it('is 0 for the range start', () => {
    const from = nameToMidi('C4')
    expect(whiteKeyIndex(from, from)).toBe(0)
  })

  it('counts white keys up to a later white key', () => {
    const from = nameToMidi('C4')
    // C D E F G A B → G is the 4th white key (index 4)
    expect(whiteKeyIndex(from, nameToMidi('G4'))).toBe(4)
  })

  it('gives a black key the index of the white key to its right', () => {
    const from = nameToMidi('C4')
    // C# sits between C (0) and D (1); its boundary index is 1.
    expect(whiteKeyIndex(from, nameToMidi('C#4'))).toBe(1)
    // F# sits between F (3) and G (4); its boundary index is 4.
    expect(whiteKeyIndex(from, nameToMidi('F#4'))).toBe(4)
  })
})

describe('whiteKeyMidis / blackKeyMidis', () => {
  it('lists 7 white and 5 black keys per octave (C..B)', () => {
    const from = nameToMidi('C4')
    const to = nameToMidi('B4')
    expect(whiteKeyMidis(from, to)).toHaveLength(7)
    expect(blackKeyMidis(from, to)).toHaveLength(5)
  })

  it('has no black key on the E–F or B–C boundary', () => {
    const from = nameToMidi('C4')
    const to = nameToMidi('B4')
    const blacks = blackKeyMidis(from, to)
    // No black key immediately above E (E#) or above B (B#).
    expect(blacks).not.toContain(nameToMidi('E4') + 1)
    expect(blacks).not.toContain(nameToMidi('B4') + 1)
  })
})

describe('snapRangeToWhite', () => {
  it('leaves a white-to-white range unchanged', () => {
    const from = nameToMidi('C3')
    const to = nameToMidi('B4')
    expect(snapRangeToWhite(from, to)).toEqual({ from, to })
  })

  it('lowers a black low end and raises a black high end', () => {
    const from = nameToMidi('C#3') // → C3
    const to = nameToMidi('A#4') // → B4
    expect(snapRangeToWhite(from, to)).toEqual({
      from: nameToMidi('C3'),
      to: nameToMidi('B4'),
    })
  })

  it('orders reversed endpoints', () => {
    const hi = nameToMidi('C5')
    const lo = nameToMidi('C4')
    const snapped = snapRangeToWhite(hi, lo)
    expect(snapped.from).toBeLessThanOrEqual(snapped.to)
    expect(snapped.from).toBe(lo)
  })
})

describe('octaveRangeToMidi', () => {
  it('spans C of the low octave through B of the high octave', () => {
    expect(octaveRangeToMidi(4, 4)).toEqual({
      from: nameToMidi('C4'),
      to: nameToMidi('B4'),
    })
  })

  it('accepts octaves in either order', () => {
    expect(octaveRangeToMidi(5, 3)).toEqual({
      from: nameToMidi('C3'),
      to: nameToMidi('B5'),
    })
  })

  it('produces white-key endpoints', () => {
    const { from, to } = octaveRangeToMidi(2, 6)
    expect(isWhiteKey(from)).toBe(true)
    expect(isWhiteKey(to)).toBe(true)
  })
})

describe('defaultKeyLabel', () => {
  it('names the pitch class without octave by default', () => {
    expect(defaultKeyLabel(nameToMidi('C4'))).toBe('C')
    expect(defaultKeyLabel(nameToMidi('C#4'))).toBe('C#')
  })

  it('appends the octave when asked', () => {
    expect(defaultKeyLabel(nameToMidi('C4'), 'sharp', true)).toBe('C4')
  })

  it('honours flat spelling', () => {
    expect(defaultKeyLabel(nameToMidi('C#4'), 'flat')).toBe('Db')
  })
})

describe('computeLayout', () => {
  it('snaps the range to white keys', () => {
    const layout = computeLayout(nameToMidi('C#4'), nameToMidi('A#4'))
    expect(layout.from).toBe(nameToMidi('C4'))
    expect(layout.to).toBe(nameToMidi('B4'))
  })

  it('sizes width to the white-key count', () => {
    const layout = computeLayout(nameToMidi('C4'), nameToMidi('B4'))
    expect(layout.whiteCount).toBe(7)
    expect(layout.width).toBe(
      DEFAULT_LAYOUT.margin * 2 + 7 * DEFAULT_LAYOUT.whiteWidth,
    )
  })

  it('makes black keys narrower and shorter than white keys', () => {
    const layout = computeLayout(nameToMidi('C4'), nameToMidi('B4'))
    expect(layout.blackWidth).toBeLessThan(layout.whiteWidth)
    expect(layout.blackHeight).toBeLessThan(layout.whiteHeight)
  })

  it('widens with more octaves', () => {
    const one = computeLayout(nameToMidi('C4'), nameToMidi('B4'))
    const two = computeLayout(nameToMidi('C3'), nameToMidi('B4'))
    expect(two.width).toBeGreaterThan(one.width)
  })
})

describe('coordinate helpers', () => {
  const layout = computeLayout(nameToMidi('C4'), nameToMidi('B4'))

  it('places white keys left to right by column', () => {
    expect(whiteKeyX(layout, nameToMidi('C4'))).toBe(layout.boardLeft)
    expect(whiteKeyX(layout, nameToMidi('D4'))).toBe(
      layout.boardLeft + layout.whiteWidth,
    )
  })

  it('centres a black key on the boundary between its white neighbours', () => {
    const cCenter = keyCenterX(layout, nameToMidi('C4'))
    const dCenter = keyCenterX(layout, nameToMidi('D4'))
    const cSharpCenter = keyCenterX(layout, nameToMidi('C#4'))
    expect(cSharpCenter).toBeGreaterThan(cCenter)
    expect(cSharpCenter).toBeLessThan(dCenter)
    // Boundary is exactly halfway between the two white-key centres.
    expect(cSharpCenter).toBeCloseTo((cCenter + dCenter) / 2)
  })

  it('offsets the black key left edge by half its width from the boundary', () => {
    const midi = nameToMidi('C#4')
    const boundary = layout.boardLeft + whiteKeyIndex(layout.from, midi) * layout.whiteWidth
    expect(blackKeyX(layout, midi)).toBe(boundary - layout.blackWidth / 2)
  })

  it('reports the correct height per key type', () => {
    expect(keyHeight(layout, nameToMidi('C4'))).toBe(layout.whiteHeight)
    expect(keyHeight(layout, nameToMidi('C#4'))).toBe(layout.blackHeight)
  })
})
