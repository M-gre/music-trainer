import { describe, expect, it } from 'vitest'
import { buildChordToneMarkers, chordDegreeLabel } from './chordTones.ts'
import { getChordQuality } from './theory/chords.ts'
import { getTuning } from './theory/instruments.ts'
import { mod12 } from './theory/notes.ts'

describe('chordDegreeLabel', () => {
  it('labels the basic chromatic degrees', () => {
    expect(chordDegreeLabel(0)).toBe('R')
    expect(chordDegreeLabel(3)).toBe('b3')
    expect(chordDegreeLabel(4)).toBe('3')
    expect(chordDegreeLabel(7)).toBe('5')
    expect(chordDegreeLabel(10)).toBe('b7')
    expect(chordDegreeLabel(11)).toBe('7')
  })

  it('labels sus/altered degrees', () => {
    expect(chordDegreeLabel(2)).toBe('2')
    expect(chordDegreeLabel(5)).toBe('4')
    expect(chordDegreeLabel(6)).toBe('b5')
    expect(chordDegreeLabel(8)).toBe('#5')
    expect(chordDegreeLabel(9)).toBe('6')
  })

  it('bumps compound intervals by 7 per octave, keeping the root as R', () => {
    expect(chordDegreeLabel(14)).toBe('9') // add9's ninth
    expect(chordDegreeLabel(12)).toBe('R') // octave of the root
    expect(chordDegreeLabel(15)).toBe('b10')
  })

  it('throws on a negative interval', () => {
    expect(() => chordDegreeLabel(-1)).toThrow()
  })
})

const BASS_4 = getTuning('bass-4') // E A D G
const GUITAR_6 = getTuning('guitar-6') // E A D G B E

describe('buildChordToneMarkers', () => {
  it('marks only chord tones with the right degrees for a major triad', () => {
    const markers = buildChordToneMarkers(
      { root: 0, quality: getChordQuality('maj') },
      BASS_4,
      0,
      12,
      0,
    )
    const degrees = new Set(markers.map((m) => m.degree))
    expect(degrees).toEqual(new Set(['R', '3', '5']))
    // C major on a 4-string bass has a fretted-and-open board full of tones.
    expect(markers.length).toBeGreaterThan(0)
  })

  it('uses b3 for a minor triad and b7 for a dominant seventh', () => {
    const minor = buildChordToneMarkers(
      { root: 0, quality: getChordQuality('min') },
      BASS_4,
      0,
      12,
      0,
    )
    expect(new Set(minor.map((m) => m.degree))).toEqual(new Set(['R', 'b3', '5']))

    const dom7 = buildChordToneMarkers(
      { root: 0, quality: getChordQuality('dom7') },
      BASS_4,
      0,
      12,
      0,
    )
    expect(new Set(dom7.map((m) => m.degree))).toEqual(new Set(['R', '3', '5', 'b7']))
  })

  it('emphasises roots: every root marker is variant "root"/degree "R", others "default"', () => {
    const markers = buildChordToneMarkers(
      { root: 0, quality: getChordQuality('maj') },
      BASS_4,
      0,
      12,
      0,
    )
    for (const m of markers) {
      if (m.isRoot) {
        expect(m.variant).toBe('root')
        expect(m.degree).toBe('R')
        expect(mod12(BASS_4.strings[m.string]! + m.fret)).toBe(0)
      } else {
        expect(m.variant).toBe('default')
        expect(m.degree).not.toBe('R')
      }
    }
    expect(markers.some((m) => m.isRoot)).toBe(true)
  })

  it('works on a 6-string guitar tuning too', () => {
    const markers = buildChordToneMarkers(
      { root: 7, quality: getChordQuality('maj') }, // G major
      GUITAR_6,
      0,
      12,
      7,
    )
    expect(GUITAR_6.strings.length).toBe(6)
    expect(new Set(markers.map((m) => m.degree))).toEqual(new Set(['R', '3', '5']))
    // Every marker is a genuine G-major pitch class (G=7, B=11, D=2).
    for (const m of markers) {
      expect([7, 11, 2]).toContain(mod12(GUITAR_6.strings[m.string]! + m.fret))
    }
  })

  it('clips to the given fret range (inclusive) and never emits negative frets', () => {
    const markers = buildChordToneMarkers(
      { root: 0, quality: getChordQuality('maj') },
      BASS_4,
      5,
      7,
      0,
    )
    for (const m of markers) {
      expect(m.fret).toBeGreaterThanOrEqual(5)
      expect(m.fret).toBeLessThanOrEqual(7)
    }
    // A reversed range is normalised to the same window.
    const reversed = buildChordToneMarkers(
      { root: 0, quality: getChordQuality('maj') },
      BASS_4,
      7,
      5,
      0,
    )
    expect(reversed).toEqual(markers)
  })

  it('spells note names per the selected key (flats in a flat key)', () => {
    // Bb major chord in the key of F (a flat key): tones Bb, D, F.
    const markers = buildChordToneMarkers(
      { root: 10, quality: getChordQuality('maj') },
      BASS_4,
      0,
      12,
      5, // key of F
    )
    const notes = new Set(markers.map((m) => m.note))
    expect(notes.has('Bb')).toBe(true)
    expect(notes.has('A#')).toBe(false)
    expect(notes).toEqual(new Set(['Bb', 'D', 'F']))
    // The root note keeps degree R.
    for (const m of markers) if (m.note === 'Bb') expect(m.degree).toBe('R')
  })

  it('spells with sharps in a sharp key', () => {
    // A major chord in the key of A (sharp key): tones A, C#, E.
    const markers = buildChordToneMarkers(
      { root: 9, quality: getChordQuality('maj') },
      GUITAR_6,
      0,
      12,
      9,
    )
    const notes = new Set(markers.map((m) => m.note))
    expect(notes.has('C#')).toBe(true)
    expect(notes.has('Db')).toBe(false)
  })
})
