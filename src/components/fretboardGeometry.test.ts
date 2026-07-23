import { describe, expect, it } from 'vitest'
import { nameToMidi } from '../lib/theory/notes.ts'
import {
  computeLayout,
  DEFAULT_LAYOUT,
  defaultMarkerLabel,
  FRET_NUMBER_FONT_SIZE,
  inlayCenterY,
  inlayDots,
  inlayDoubleOffset,
  inlayRadius,
  markerRadius,
  mirrorX,
  noteX,
  stringStrokeWidth,
  stringY,
  wireX,
} from './fretboardGeometry.ts'

describe('inlayDots', () => {
  it('returns single and double inlays within a 0–12 range, sorted', () => {
    expect(inlayDots(0, 12)).toEqual([
      { fret: 3, double: false },
      { fret: 5, double: false },
      { fret: 7, double: false },
      { fret: 9, double: false },
      { fret: 12, double: true },
    ])
  })

  it('never includes fret 0 (the open/nut position)', () => {
    expect(inlayDots(0, 2)).toEqual([])
  })

  it('respects a non-zero starting fret', () => {
    expect(inlayDots(9, 17)).toEqual([
      { fret: 9, double: false },
      { fret: 12, double: true },
      { fret: 15, double: false },
      { fret: 17, double: false },
    ])
  })

  it('marks fret 24 as a double inlay', () => {
    expect(inlayDots(21, 24)).toEqual([
      { fret: 21, double: false },
      { fret: 24, double: true },
    ])
  })
})

describe('defaultMarkerLabel', () => {
  it('names the pitch class without octave', () => {
    expect(defaultMarkerLabel(nameToMidi('E1'))).toBe('E')
    expect(defaultMarkerLabel(nameToMidi('C4'))).toBe('C')
  })

  it('uses sharps by default and flats when asked', () => {
    const midi = nameToMidi('C#3')
    expect(defaultMarkerLabel(midi)).toBe('C#')
    expect(defaultMarkerLabel(midi, 'flat')).toBe('Db')
  })
})

describe('stringStrokeWidth', () => {
  it('makes the lowest string the thickest', () => {
    const low = stringStrokeWidth(0, 4)
    const high = stringStrokeWidth(3, 4)
    expect(low).toBeGreaterThan(high)
  })

  it('returns the max for a single string', () => {
    expect(stringStrokeWidth(0, 1, 1, 2.6)).toBe(2.6)
  })

  it('interpolates monotonically across strings', () => {
    const widths = [0, 1, 2, 3, 4].map((i) => stringStrokeWidth(i, 5))
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!)
    }
  })
})

describe('computeLayout', () => {
  it('reserves a nut area and open flag when fromFret is 0', () => {
    const layout = computeLayout(0, 12, 4, true)
    expect(layout.open).toBe(true)
    expect(layout.firstFret).toBe(1)
    expect(layout.cells).toBe(12)
    expect(layout.boardLeft).toBe(DEFAULT_LAYOUT.nutArea)
  })

  it('is not open when starting above the nut', () => {
    const layout = computeLayout(5, 12, 6, true)
    expect(layout.open).toBe(false)
    expect(layout.firstFret).toBe(5)
    expect(layout.cells).toBe(8)
  })

  it('scales height with string count', () => {
    const four = computeLayout(0, 12, 4, true)
    const six = computeLayout(0, 12, 6, true)
    expect(six.boardBottom).toBeGreaterThan(four.boardBottom)
  })

  it('adds a label gutter only when fret numbers are shown', () => {
    const withNums = computeLayout(0, 12, 4, true)
    const without = computeLayout(0, 12, 4, false)
    expect(without.labelGutter).toBe(0)
    expect(withNums.labelGutter).toBeGreaterThan(0)
    expect(withNums.height - without.height).toBe(withNums.labelGutter)
  })

  it('reserves a gutter no smaller than the configured floor', () => {
    const layout = computeLayout(0, 12, 4, true)
    expect(layout.labelGutter).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.labelGutter)
  })

  it('guards against an inverted range', () => {
    const layout = computeLayout(12, 12, 4, false)
    expect(layout.cells).toBeGreaterThanOrEqual(1)
  })
})

describe('coordinate helpers', () => {
  const layout = computeLayout(0, 12, 4, true)

  it('places open notes left of the board and fretted notes within cells', () => {
    expect(noteX(layout, 0)).toBeLessThan(layout.boardLeft)
    const f1 = noteX(layout, 1)
    const f2 = noteX(layout, 2)
    expect(f1).toBeGreaterThan(layout.boardLeft)
    expect(f2).toBeGreaterThan(f1)
  })

  it('places note centres between their fret wires', () => {
    const x = noteX(layout, 3)
    expect(x).toBeGreaterThan(wireX(layout, 2))
    expect(x).toBeLessThan(wireX(layout, 3))
  })

  it('draws the lowest string at the bottom (largest y)', () => {
    expect(stringY(layout, 0)).toBeGreaterThan(stringY(layout, 3))
    expect(stringY(layout, 3)).toBe(layout.boardTop)
    expect(stringY(layout, 0)).toBe(layout.boardBottom)
  })
})

describe('marker and inlay radii', () => {
  it('makes markers larger than inlays', () => {
    expect(markerRadius(DEFAULT_LAYOUT)).toBeGreaterThan(inlayRadius(DEFAULT_LAYOUT))
  })

  it('scales both radii with the smaller cell dimension', () => {
    const narrow = { ...DEFAULT_LAYOUT, stringSpacing: 10 }
    expect(markerRadius(narrow)).toBeLessThan(markerRadius(DEFAULT_LAYOUT))
    expect(inlayRadius(narrow)).toBeLessThan(inlayRadius(DEFAULT_LAYOUT))
  })
})

describe('fret-number gutter never sits under a marker', () => {
  for (const strings of [4, 5, 6, 7]) {
    it(`clears the bottom-string marker for a ${strings}-string board`, () => {
      const layout = computeLayout(0, 12, strings, true)
      // The bottom string is at boardBottom; a marker there reaches this y.
      const markerBottom = layout.boardBottom + markerRadius(DEFAULT_LAYOUT)
      // The number's topmost pixel (baseline minus cap height) must clear it.
      const numberTop = layout.fretNumberY - FRET_NUMBER_FONT_SIZE
      expect(numberTop).toBeGreaterThanOrEqual(markerBottom)
      // And the whole number row must fit inside the reserved gutter.
      expect(layout.fretNumberY).toBeLessThanOrEqual(layout.boardBottom + layout.labelGutter)
    })
  }
})

describe('inlay positions avoid string rows', () => {
  function stringYs(layout: ReturnType<typeof computeLayout>): number[] {
    return Array.from({ length: layout.stringCount }, (_, s) => stringY(layout, s))
  }

  it('keeps the single inlay off every string row (even and odd counts)', () => {
    for (const strings of [4, 5, 6, 7]) {
      const layout = computeLayout(0, 12, strings, true)
      const cy = inlayCenterY(layout)
      for (const y of stringYs(layout)) {
        expect(Math.abs(cy - y)).toBeGreaterThan(inlayRadius(DEFAULT_LAYOUT))
      }
    }
  })

  it('keeps both dots of a double inlay off every string row', () => {
    for (const strings of [4, 5, 6, 7]) {
      const layout = computeLayout(0, 12, strings, true)
      const cy = inlayCenterY(layout)
      const off = inlayDoubleOffset(layout)
      for (const dotY of [cy - off, cy + off]) {
        for (const y of stringYs(layout)) {
          expect(Math.abs(dotY - y)).toBeGreaterThan(inlayRadius(DEFAULT_LAYOUT))
        }
      }
    }
  })

  it('leaves an even-string mid-line unchanged but nudges an odd one', () => {
    const even = computeLayout(0, 12, 4, true)
    expect(inlayCenterY(even)).toBe((even.boardTop + even.boardBottom) / 2)
    const odd = computeLayout(0, 12, 5, true)
    expect(inlayCenterY(odd)).not.toBe((odd.boardTop + odd.boardBottom) / 2)
  })
})

describe('mirrorX (left-handed flip)', () => {
  const layout = computeLayout(0, 12, 4, true)

  it('reflects an x coordinate about the board width', () => {
    expect(mirrorX(layout, 0)).toBe(layout.width)
    expect(mirrorX(layout, layout.width)).toBe(0)
    expect(mirrorX(layout, layout.width / 2)).toBe(layout.width / 2)
  })

  it('is its own inverse (mirroring twice is the identity)', () => {
    for (const x of [0, 12, 40, 100, layout.boardRight]) {
      expect(mirrorX(layout, mirrorX(layout, x))).toBe(x)
    }
  })

  it('flips fret order: the nut ends up to the right of high frets', () => {
    // Right-handed: fret 1 sits left of fret 12. Mirrored, that order reverses.
    expect(noteX(layout, 1)).toBeLessThan(noteX(layout, 12))
    expect(mirrorX(layout, noteX(layout, 1))).toBeGreaterThan(
      mirrorX(layout, noteX(layout, 12)),
    )
  })

  it('keeps mirrored fretted-note centres on-canvas', () => {
    for (let fret = 1; fret <= 12; fret += 1) {
      const x = mirrorX(layout, noteX(layout, fret))
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(layout.width)
    }
  })
})
