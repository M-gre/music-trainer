import { describe, expect, it } from 'vitest'
import { nameToMidi } from '../lib/theory/notes.ts'
import {
  CLEF_BOTTOM_STEP,
  computeStaffLayout,
  DEFAULT_STAFF_LAYOUT,
  diatonicStep,
  ledgerLines,
  midiToStaffNote,
  preferForKey,
  yForPosition,
} from './staffGeometry.ts'

describe('diatonicStep', () => {
  it('is monotonic across octaves and letters', () => {
    expect(diatonicStep('C', 4)).toBe(28)
    expect(diatonicStep('E', 4)).toBe(30)
    expect(diatonicStep('G', 2)).toBe(18)
    expect(diatonicStep('B', 3)).toBe(diatonicStep('C', 4) - 1)
    expect(diatonicStep('C', 5)).toBe(diatonicStep('C', 4) + 7)
  })
})

describe('CLEF_BOTTOM_STEP', () => {
  it('matches the conventional bottom staff line of each clef', () => {
    // Treble bottom line is E4, bass bottom line is G2.
    expect(CLEF_BOTTOM_STEP.treble).toBe(diatonicStep('E', 4))
    expect(CLEF_BOTTOM_STEP.bass).toBe(diatonicStep('G', 2))
  })
})

describe('midiToStaffNote — treble clef', () => {
  it('places E4 on the bottom line (position 0)', () => {
    const n = midiToStaffNote(nameToMidi('E4'), 'treble')
    expect(n.letter).toBe('E')
    expect(n.octave).toBe(4)
    expect(n.accidental).toBeNull()
    expect(n.position).toBe(0)
  })

  it('places F5 on the top line (position 8)', () => {
    const n = midiToStaffNote(nameToMidi('F5'), 'treble')
    expect(n.position).toBe(8)
    expect(n.letter).toBe('F')
  })

  it('places middle C (C4) one ledger line below (position -2)', () => {
    const n = midiToStaffNote(nameToMidi('C4'), 'treble')
    expect(n.letter).toBe('C')
    expect(n.position).toBe(-2)
    expect(ledgerLines(n.position)).toEqual([-2])
  })

  it('places G4 on the second line from the bottom (position 2)', () => {
    const n = midiToStaffNote(nameToMidi('G4'), 'treble')
    expect(n.position).toBe(2)
  })
})

describe('midiToStaffNote — bass clef', () => {
  it('places G2 on the bottom line (position 0)', () => {
    const n = midiToStaffNote(nameToMidi('G2'), 'bass')
    expect(n.letter).toBe('G')
    expect(n.position).toBe(0)
  })

  it('places A3 on the top line (position 8)', () => {
    const n = midiToStaffNote(nameToMidi('A3'), 'bass')
    expect(n.position).toBe(8)
  })

  it('places middle C (C4) one ledger line above (position 10)', () => {
    const n = midiToStaffNote(nameToMidi('C4'), 'bass')
    expect(n.letter).toBe('C')
    expect(n.position).toBe(10)
    expect(ledgerLines(n.position)).toEqual([10])
  })

  it('places E2 one ledger line below (position -2)', () => {
    const n = midiToStaffNote(nameToMidi('E2'), 'bass')
    expect(n.position).toBe(-2)
    expect(ledgerLines(n.position)).toEqual([-2])
  })

  it('places low C2 two ledger lines below (position -4)', () => {
    const n = midiToStaffNote(nameToMidi('C2'), 'bass')
    expect(n.position).toBe(-4)
    expect(ledgerLines(n.position)).toEqual([-4, -2])
  })
})

describe('midiToStaffNote — accidentals and spelling', () => {
  it('spells with sharps by default', () => {
    const n = midiToStaffNote(nameToMidi('F#4'), 'treble', 'sharp')
    expect(n.letter).toBe('F')
    expect(n.accidental).toBe('sharp')
    // F# sits on the same staff position as F natural.
    expect(n.position).toBe(midiToStaffNote(nameToMidi('F4'), 'treble').position)
  })

  it('spells with flats when asked', () => {
    const n = midiToStaffNote(nameToMidi('Bb3'), 'treble', 'flat')
    expect(n.letter).toBe('B')
    expect(n.accidental).toBe('flat')
    expect(n.position).toBe(midiToStaffNote(nameToMidi('B3'), 'treble').position)
  })

  it('the same pitch draws on different letters/positions per spelling', () => {
    const sharp = midiToStaffNote(nameToMidi('C#4'), 'treble', 'sharp')
    const flat = midiToStaffNote(nameToMidi('Db4'), 'treble', 'flat')
    expect(sharp.letter).toBe('C')
    expect(flat.letter).toBe('D')
    expect(flat.position).toBe(sharp.position + 1)
  })

  it('naturals carry no accidental', () => {
    expect(midiToStaffNote(nameToMidi('A3'), 'bass').accidental).toBeNull()
  })
})

describe('ledgerLines', () => {
  it('returns none for notes on or within the staff', () => {
    expect(ledgerLines(0)).toEqual([])
    expect(ledgerLines(4)).toEqual([])
    expect(ledgerLines(8)).toEqual([])
  })

  it('returns none for the space just outside the staff', () => {
    expect(ledgerLines(-1)).toEqual([])
    expect(ledgerLines(9)).toEqual([])
  })

  it('adds lines below in ascending order', () => {
    expect(ledgerLines(-2)).toEqual([-2])
    expect(ledgerLines(-3)).toEqual([-2])
    expect(ledgerLines(-4)).toEqual([-4, -2])
    expect(ledgerLines(-6)).toEqual([-6, -4, -2])
  })

  it('adds lines above in ascending order', () => {
    expect(ledgerLines(10)).toEqual([10])
    expect(ledgerLines(11)).toEqual([10])
    expect(ledgerLines(12)).toEqual([10, 12])
  })
})

describe('preferForKey', () => {
  it('uses sharps for sharp keys and flats for flat keys', () => {
    expect(preferForKey(nameToMidi('C4') % 12)).toBe('sharp') // C major
    expect(preferForKey(nameToMidi('G4') % 12)).toBe('sharp') // G major (1 sharp)
    expect(preferForKey(nameToMidi('F4') % 12)).toBe('flat') // F major (1 flat)
    expect(preferForKey(nameToMidi('Bb4') % 12)).toBe('flat') // Bb major
  })
})

describe('pixel layout', () => {
  const layout = computeStaffLayout()

  it('has five evenly spaced staff lines', () => {
    expect(layout.lineYs).toHaveLength(5)
    const gaps = layout.lineYs.slice(1).map((y, i) => y - layout.lineYs[i]!)
    for (const g of gaps) expect(g).toBe(DEFAULT_STAFF_LAYOUT.lineGap)
  })

  it('maps the bottom line to position 0 and the top line to position 8', () => {
    expect(yForPosition(layout, 0)).toBe(layout.bottomLineY)
    expect(yForPosition(layout, 8)).toBe(layout.topLineY)
  })

  it('moves up (smaller y) as the position rises', () => {
    expect(yForPosition(layout, 2)).toBeLessThan(yForPosition(layout, 0))
    expect(yForPosition(layout, -2)).toBeGreaterThan(yForPosition(layout, 0))
  })

  it('keeps every element inside the SVG bounds', () => {
    expect(layout.width).toBeGreaterThan(layout.staffRight)
    expect(layout.height).toBeGreaterThan(layout.bottomLineY)
    // Room for two ledger lines above the staff (position 12).
    expect(yForPosition(layout, 12)).toBeGreaterThan(0)
    expect(yForPosition(layout, -4)).toBeLessThan(layout.height)
  })
})
