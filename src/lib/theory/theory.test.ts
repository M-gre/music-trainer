import { describe, expect, it } from 'vitest'
import {
  BASS_TUNINGS,
  CIRCLE_OF_FIFTHS,
  GUITAR_TUNINGS,
  TUNINGS,
  getTuning,
  tuningsFor,
  chordPcs,
  diatonicTriads,
  fretMidi,
  getChordQuality,
  getScale,
  intervalName,
  majorKeySignature,
  midiToFreq,
  midiToName,
  nameToMidi,
  nameToPc,
  pcToName,
  prefersFlats,
  progressionChords,
  scalePcs,
  spellScale,
} from './index.ts'

describe('notes', () => {
  it('parses note names to pitch classes', () => {
    expect(nameToPc('C')).toBe(0)
    expect(nameToPc('C#')).toBe(1)
    expect(nameToPc('Db')).toBe(1)
    expect(nameToPc('B')).toBe(11)
    expect(nameToPc('Cb')).toBe(11)
    expect(nameToPc('B#')).toBe(0)
    expect(nameToPc('F##')).toBe(7)
    expect(() => nameToPc('H')).toThrow()
    expect(() => nameToPc('C#b')).toThrow()
  })

  it('parses full note names to midi', () => {
    expect(nameToMidi('C4')).toBe(60)
    expect(nameToMidi('A4')).toBe(69)
    expect(nameToMidi('E1')).toBe(28)
    expect(nameToMidi('B#3')).toBe(60) // enharmonic of C4, spelled from B3
    expect(nameToMidi('Cb4')).toBe(59)
  })

  it('formats midi back to names', () => {
    expect(midiToName(60)).toBe('C4')
    expect(midiToName(61)).toBe('C#4')
    expect(midiToName(61, 'flat')).toBe('Db4')
    expect(midiToName(28)).toBe('E1')
  })

  it('names pitch classes', () => {
    expect(pcToName(10)).toBe('A#')
    expect(pcToName(10, 'flat')).toBe('Bb')
  })

  it('computes frequencies', () => {
    expect(midiToFreq(69)).toBe(440)
    expect(midiToFreq(60)).toBeCloseTo(261.626, 2)
  })
})

describe('intervals', () => {
  it('names intervals', () => {
    expect(intervalName(7).short).toBe('P5')
    expect(intervalName(3).name).toBe('Minor Third')
    expect(() => intervalName(13)).toThrow()
  })
})

describe('scales', () => {
  it('builds scale pitch classes', () => {
    expect(scalePcs(nameToPc('C'), getScale('major'))).toEqual([0, 2, 4, 5, 7, 9, 11])
    expect(scalePcs(nameToPc('A'), getScale('minor'))).toEqual([9, 11, 0, 2, 4, 5, 7])
    expect(scalePcs(nameToPc('E'), getScale('minor-pentatonic'))).toEqual([4, 7, 9, 11, 2])
  })

  it('knows the circle of fifths', () => {
    expect(CIRCLE_OF_FIFTHS.slice(0, 4)).toEqual([0, 7, 2, 9]) // C G D A
    expect(new Set(CIRCLE_OF_FIFTHS).size).toBe(12)
  })

  it('computes key signatures', () => {
    expect(majorKeySignature(nameToPc('C'))).toBe(0)
    expect(majorKeySignature(nameToPc('G'))).toBe(1)
    expect(majorKeySignature(nameToPc('E'))).toBe(4)
    expect(majorKeySignature(nameToPc('F'))).toBe(-1)
    expect(majorKeySignature(nameToPc('Eb'))).toBe(-3)
  })
})

describe('spelling', () => {
  it('spells major scales with correct enharmonics', () => {
    expect(spellScale(nameToPc('C'), getScale('major').intervals)).toEqual(['C', 'D', 'E', 'F', 'G', 'A', 'B'])
    expect(spellScale(nameToPc('F'), getScale('major').intervals)).toEqual(['F', 'G', 'A', 'Bb', 'C', 'D', 'E'])
    expect(spellScale(nameToPc('D'), getScale('major').intervals)).toEqual(['D', 'E', 'F#', 'G', 'A', 'B', 'C#'])
    expect(spellScale(nameToPc('F#'), getScale('major').intervals)).toEqual(['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#'])
    expect(spellScale(nameToPc('Gb'), getScale('major').intervals, 'G')).toEqual(['Gb', 'Ab', 'Bb', 'Cb', 'Db', 'Eb', 'F'])
  })

  it('spells minor scales', () => {
    expect(spellScale(nameToPc('E'), getScale('minor').intervals)).toEqual(['E', 'F#', 'G', 'A', 'B', 'C', 'D'])
  })

  it('knows which keys prefer flats', () => {
    expect(prefersFlats(nameToPc('F'))).toBe(true)
    expect(prefersFlats(nameToPc('Bb'))).toBe(true)
    expect(prefersFlats(nameToPc('G'))).toBe(false)
    expect(prefersFlats(nameToPc('C'))).toBe(false)
  })
})

describe('chords', () => {
  it('builds chord pitch classes', () => {
    expect(chordPcs(nameToPc('C'), getChordQuality('maj'))).toEqual([0, 4, 7])
    expect(chordPcs(nameToPc('A'), getChordQuality('min7'))).toEqual([9, 0, 4, 7])
    expect(chordPcs(nameToPc('G'), getChordQuality('dom7'))).toEqual([7, 11, 2, 5])
  })

  it('derives diatonic triads of a major key', () => {
    const triads = diatonicTriads(nameToPc('C'))
    expect(triads.map((t) => t.numeral)).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'])
    expect(triads.map((t) => t.quality.id)).toEqual(['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'])
    expect(triads[4]!.root).toBe(nameToPc('G'))
  })

  it('derives diatonic triads of harmonic minor', () => {
    const triads = diatonicTriads(nameToPc('A'), getScale('harmonic-minor'))
    expect(triads.map((t) => t.quality.id)).toEqual(['min', 'dim', 'aug', 'min', 'maj', 'maj', 'dim'])
  })

  it('resolves progressions like 1-5-6-4', () => {
    const chords = progressionChords(nameToPc('G'), [1, 5, 6, 4])
    expect(chords.map((c) => pcToName(c.root))).toEqual(['G', 'D', 'E', 'C'])
    expect(chords.map((c) => c.quality.id)).toEqual(['maj', 'maj', 'min', 'maj'])
    expect(() => progressionChords(0, [8])).toThrow()
  })
})

describe('instruments', () => {
  it('computes fretboard pitches for standard bass', () => {
    const bass = getTuning('bass-4')
    expect(fretMidi(bass, 0, 0)).toBe(nameToMidi('E1'))
    expect(fretMidi(bass, 0, 5)).toBe(nameToMidi('A1')) // 5th fret = next open string
    expect(fretMidi(bass, 3, 12)).toBe(nameToMidi('G3'))
    expect(() => fretMidi(bass, 4, 0)).toThrow()
  })

  it('computes fretboard pitches for standard guitar', () => {
    const guitar = getTuning('guitar-6')
    expect(guitar.strings.length).toBe(6)
    expect(fretMidi(guitar, 0, 0)).toBe(nameToMidi('E2'))
    expect(fretMidi(guitar, 1, 2)).toBe(nameToMidi('B2'))
    expect(fretMidi(guitar, 4, 0)).toBe(nameToMidi('B3')) // B string, unlike bass fourths
    expect(fretMidi(guitar, 5, 12)).toBe(nameToMidi('E5'))
  })

  it('groups tunings by instrument with unique ids', () => {
    expect(BASS_TUNINGS.every((t) => t.instrument === 'bass')).toBe(true)
    expect(GUITAR_TUNINGS.every((t) => t.instrument === 'guitar')).toBe(true)
    expect(tuningsFor('guitar').map((t) => t.strings.length)).toEqual([6, 6, 6, 7])
    expect(new Set(TUNINGS.map((t) => t.id)).size).toBe(TUNINGS.length)
    expect(() => getTuning('banjo-5')).toThrow()
  })
})
