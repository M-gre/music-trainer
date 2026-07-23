import { describe, expect, it } from 'vitest'
import {
  buildFretboardMarkers,
  buildKeyboardMarkers,
  buildScaleSequence,
  degreeLabelFromSemitones,
  diatonicDegreeLabel,
  markerVariantForInterval,
  playbackRootMidi,
  scaleDegreeLabelMap,
  scaleDegreeLabels,
  scaleNoteNames,
  scaleStepPattern,
  scaleStepsSemitones,
} from './scaleExplorer.ts'
import { getScale, getTuning } from './theory/index.ts'

describe('degreeLabelFromSemitones', () => {
  it('maps semitones to the fixed chromatic degree names', () => {
    expect(degreeLabelFromSemitones(0)).toBe('1')
    expect(degreeLabelFromSemitones(3)).toBe('b3')
    expect(degreeLabelFromSemitones(6)).toBe('b5')
    expect(degreeLabelFromSemitones(10)).toBe('b7')
  })

  it('wraps semitones beyond an octave', () => {
    expect(degreeLabelFromSemitones(12)).toBe('1')
    expect(degreeLabelFromSemitones(15)).toBe('b3')
  })
})

describe('diatonicDegreeLabel', () => {
  it('spells a raised fourth as #4 (Lydian) and a lowered fifth as b5 (Locrian)', () => {
    expect(diatonicDegreeLabel(6, 3)).toBe('#4')
    expect(diatonicDegreeLabel(6, 4)).toBe('b5')
  })

  it('spells lowered thirds and sevenths', () => {
    expect(diatonicDegreeLabel(3, 2)).toBe('b3')
    expect(diatonicDegreeLabel(10, 6)).toBe('b7')
  })

  it('spells natural degrees without accidentals', () => {
    expect(diatonicDegreeLabel(0, 0)).toBe('1')
    expect(diatonicDegreeLabel(7, 4)).toBe('5')
  })
})

describe('scaleDegreeLabels', () => {
  it('labels the major scale 1..7', () => {
    expect(scaleDegreeLabels(getScale('major').intervals)).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  })

  it('labels Lydian with #4 and Locrian with b5', () => {
    expect(scaleDegreeLabels(getScale('lydian').intervals)).toEqual(['1', '2', '3', '#4', '5', '6', '7'])
    expect(scaleDegreeLabels(getScale('locrian').intervals)).toEqual([
      '1',
      'b2',
      'b3',
      '4',
      'b5',
      'b6',
      'b7',
    ])
  })

  it('labels the minor pentatonic with the conventional non-consecutive degrees', () => {
    expect(scaleDegreeLabels(getScale('minor-pentatonic').intervals)).toEqual(['1', 'b3', '4', '5', 'b7'])
  })

  it('labels the blues scale', () => {
    expect(scaleDegreeLabels(getScale('blues').intervals)).toEqual(['1', 'b3', '4', 'b5', '5', 'b7'])
  })

  it('labels the chromatic scale across all twelve semitones', () => {
    expect(scaleDegreeLabels(getScale('chromatic').intervals)).toEqual([
      '1',
      'b2',
      '2',
      'b3',
      '3',
      '4',
      'b5',
      '5',
      'b6',
      '6',
      'b7',
      '7',
    ])
  })
})

describe('scaleDegreeLabelMap', () => {
  it('maps interval semitones to degree labels', () => {
    const map = scaleDegreeLabelMap(getScale('lydian').intervals)
    expect(map.get(0)).toBe('1')
    expect(map.get(6)).toBe('#4')
    expect(map.get(11)).toBe('7')
  })
})

describe('scaleStepsSemitones / scaleStepPattern', () => {
  it('computes major-scale steps wrapping to the octave', () => {
    expect(scaleStepsSemitones(getScale('major').intervals)).toEqual([2, 2, 1, 2, 2, 2, 1])
    expect(scaleStepPattern(getScale('major').intervals)).toEqual(['W', 'W', 'H', 'W', 'W', 'W', 'H'])
  })

  it('renders the augmented second in harmonic minor as W½', () => {
    expect(scaleStepPattern(getScale('harmonic-minor').intervals)).toEqual([
      'W',
      'H',
      'W',
      'W',
      'H',
      'W½',
      'H',
    ])
  })

  it('renders the chromatic scale as all half steps', () => {
    expect(scaleStepPattern(getScale('chromatic').intervals)).toEqual(Array(12).fill('H'))
  })
})

describe('markerVariantForInterval', () => {
  it('marks the root, thirds and fifths, and plain tones', () => {
    expect(markerVariantForInterval(0)).toBe('root')
    expect(markerVariantForInterval(3)).toBe('accent')
    expect(markerVariantForInterval(4)).toBe('accent')
    expect(markerVariantForInterval(7)).toBe('accent')
    expect(markerVariantForInterval(2)).toBe('default')
    expect(markerVariantForInterval(12)).toBe('root')
  })
})

describe('scaleNoteNames', () => {
  it('spells a 7-note scale with consecutive letters (F major)', () => {
    expect(scaleNoteNames(5, getScale('major'))).toEqual(['F', 'G', 'A', 'Bb', 'C', 'D', 'E'])
  })

  it('names a non-7-note scale with simple names (C blues, sharp-side root)', () => {
    expect(scaleNoteNames(0, getScale('blues'))).toEqual(['C', 'D#', 'F', 'F#', 'G', 'A#'])
  })

  it('names a non-7-note scale with flats for a flat-side root (F minor pentatonic)', () => {
    expect(scaleNoteNames(5, getScale('minor-pentatonic'))).toEqual(['F', 'Ab', 'Bb', 'C', 'Eb'])
  })

  it('forces sharp spelling for every note when a preference is given (F major)', () => {
    expect(scaleNoteNames(5, getScale('major'), 'sharp')).toEqual([
      'F',
      'G',
      'A',
      'A#',
      'C',
      'D',
      'E',
    ])
  })

  it('forces flat spelling for every note when a preference is given (C major)', () => {
    expect(scaleNoteNames(0, getScale('major'), 'flat')).toEqual([
      'C',
      'D',
      'E',
      'F',
      'G',
      'A',
      'B',
    ])
  })

  it('overrides the context choice for a non-7-note scale (C blues, forced flats)', () => {
    expect(scaleNoteNames(0, getScale('blues'), 'flat')).toEqual([
      'C',
      'Eb',
      'F',
      'Gb',
      'G',
      'Bb',
    ])
  })
})

describe('buildFretboardMarkers', () => {
  const bass = getTuning('bass-4')

  it('marks only scale tones within the fret range', () => {
    const markers = buildFretboardMarkers(bass, 0, 12, 0, getScale('major').intervals, {
      display: 'names',
      prefer: 'sharp',
    })
    // Every marker's pitch class must be in C major (no sharps/flats).
    const names = new Set(markers.map((m) => m.label))
    expect(names).toEqual(new Set(['C', 'D', 'E', 'F', 'G', 'A', 'B']))
    // Open low-E string (E) is a scale tone and gets a marker at fret 0.
    expect(markers.some((m) => m.string === 0 && m.fret === 0)).toBe(true)
  })

  it('uses the root variant for root tones and degree labels when asked', () => {
    const markers = buildFretboardMarkers(bass, 0, 5, 0, getScale('minor-pentatonic').intervals, {
      display: 'degrees',
      prefer: 'sharp',
    })
    const roots = markers.filter((m) => m.variant === 'root')
    expect(roots.length).toBeGreaterThan(0)
    expect(roots.every((m) => m.label === '1')).toBe(true)
    // A minor-pentatonic (root A = pc 9): labels are drawn from its degrees.
    expect(new Set(markers.map((m) => m.label))).toEqual(new Set(['1', 'b3', '4', '5', 'b7']))
  })
})

describe('buildKeyboardMarkers', () => {
  it('highlights the scale across octaves plus the top root', () => {
    const markers = buildKeyboardMarkers(60, getScale('major').intervals, {
      display: 'names',
      prefer: 'sharp',
      octaves: 2,
    })
    // 7 tones * 2 octaves + top root.
    expect(markers).toHaveLength(15)
    expect(markers.at(-1)).toEqual({ midi: 84, variant: 'root', label: 'C' })
    expect(markers.filter((m) => m.variant === 'root').map((m) => m.midi)).toEqual([60, 72, 84])
  })

  it('labels with degrees when asked', () => {
    const markers = buildKeyboardMarkers(60, getScale('major').intervals, {
      display: 'degrees',
      prefer: 'sharp',
      octaves: 1,
    })
    expect(markers[0]).toEqual({ midi: 60, variant: 'root', label: '1' })
    expect(markers.find((m) => m.midi === 64)?.label).toBe('3')
  })
})

describe('playbackRootMidi', () => {
  it('anchors the root in the C3 octave', () => {
    expect(playbackRootMidi(0)).toBe(48)
    expect(playbackRootMidi(9)).toBe(57)
    expect(playbackRootMidi(12)).toBe(48)
  })
})

describe('buildScaleSequence', () => {
  it('ascends one octave including the top root', () => {
    expect(buildScaleSequence(60, getScale('major').intervals, 'up')).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72,
    ])
  })

  it('descends as the reverse of the ascending run', () => {
    expect(buildScaleSequence(60, getScale('major').intervals, 'down')).toEqual([
      72, 71, 69, 67, 65, 64, 62, 60,
    ])
  })

  it('works for a pentatonic scale', () => {
    expect(buildScaleSequence(48, getScale('minor-pentatonic').intervals, 'up')).toEqual([
      48, 51, 53, 55, 58, 60,
    ])
  })
})
