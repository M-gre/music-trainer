import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import { CHORD_QUALITIES, getChordQuality } from './theory/chords.ts'
import { getTuning } from './theory/instruments.ts'
import { nameToPc } from './theory/notes.ts'
import {
  arpeggioSteps,
  buildChordFretboardMarkers,
  buildChordKeyboardMarkers,
  chordSymbol,
  chordTones,
  chordVoicing,
  createChordExplorerSettingsStore,
  DEFAULT_CHORD_EXPLORER_SETTINGS,
  groupedQualities,
  intervalLabel,
  inversionCount,
  normalizeChordExplorerSettings,
  qualityGroup,
  voicingMidis,
  VOICING_BASE_MIDI,
} from './chordExplorer.ts'

describe('intervalLabel', () => {
  it('matches intervalName for simple (within-octave) intervals', () => {
    expect(intervalLabel(0)).toBe('P1')
    expect(intervalLabel(3)).toBe('m3')
    expect(intervalLabel(4)).toBe('M3')
    expect(intervalLabel(7)).toBe('P5')
    expect(intervalLabel(10)).toBe('m7')
    expect(intervalLabel(11)).toBe('M7')
    expect(intervalLabel(12)).toBe('P8')
  })

  it('names compound intervals beyond an octave', () => {
    expect(intervalLabel(13)).toBe('m9') // octave + m2
    expect(intervalLabel(14)).toBe('M9') // octave + M2 -- add9's ninth
    expect(intervalLabel(15)).toBe('m10')
    expect(intervalLabel(19)).toBe('P12')
  })

  it('throws on a negative interval', () => {
    expect(() => intervalLabel(-1)).toThrow()
  })
})

describe('chordTones', () => {
  it('labels the root as "R" and others by interval, matching the chord symbol example', () => {
    // Am7: A C E G -> R, m3, P5, m7
    const tones = chordTones(nameToPc('A'), getChordQuality('min7'))
    expect(tones.map((t) => t.pc)).toEqual([9, 0, 4, 7])
    expect(tones.map((t) => t.label)).toEqual(['R', 'm3', 'P5', 'm7'])
  })

  it('labels add9 tones including the compound ninth', () => {
    const tones = chordTones(nameToPc('C'), getChordQuality('add9'))
    expect(tones.map((t) => t.label)).toEqual(['R', 'M3', 'P5', 'M9'])
  })
})

describe('chordSymbol', () => {
  it('builds symbols like "Am7" and "C"', () => {
    expect(chordSymbol(nameToPc('A'), getChordQuality('min7'))).toBe('Am7')
    expect(chordSymbol(nameToPc('C'), getChordQuality('maj'))).toBe('C')
    expect(chordSymbol(nameToPc('F'), getChordQuality('dim7'), 'flat')).toBe('Fdim7')
  })
})

describe('quality grouping', () => {
  it('groups every quality into exactly one bucket, covering all qualities', () => {
    const groups = groupedQualities()
    const total = groups.triads.length + groups.sevenths.length + groups.other.length
    expect(total).toBe(CHORD_QUALITIES.length)
  })

  it('classifies known qualities', () => {
    expect(qualityGroup(getChordQuality('maj'))).toBe('triads')
    expect(qualityGroup(getChordQuality('sus4'))).toBe('triads')
    expect(qualityGroup(getChordQuality('dom7'))).toBe('sevenths')
    expect(qualityGroup(getChordQuality('min7b5'))).toBe('sevenths')
    expect(qualityGroup(getChordQuality('maj6'))).toBe('other')
    expect(qualityGroup(getChordQuality('add9'))).toBe('other')
  })
})

describe('inversionCount', () => {
  it('is 3 for triads and 4 for sevenths/other 4-note qualities', () => {
    expect(inversionCount(getChordQuality('maj'))).toBe(3)
    expect(inversionCount(getChordQuality('min7'))).toBe(4)
    expect(inversionCount(getChordQuality('add9'))).toBe(4)
  })
})

describe('chordVoicing / voicingMidis', () => {
  it('voices a C major triad through all inversions around C4', () => {
    const root = nameToPc('C')
    const maj = getChordQuality('maj')
    expect(voicingMidis(root, maj, 0)).toEqual([60, 64, 67]) // C4 E4 G4
    expect(voicingMidis(root, maj, 1)).toEqual([64, 67, 72]) // E4 G4 C5
    expect(voicingMidis(root, maj, 2)).toEqual([67, 72, 76]) // G4 C5 E5
  })

  it('wraps inversion numbers into range', () => {
    const root = nameToPc('C')
    const maj = getChordQuality('maj')
    expect(voicingMidis(root, maj, 3)).toEqual(voicingMidis(root, maj, 0))
    expect(voicingMidis(root, maj, -1)).toEqual(voicingMidis(root, maj, 2))
  })

  it('voices a dominant 7th (G7) through all four inversions, bass note matching the tone', () => {
    const root = nameToPc('G')
    const dom7 = getChordQuality('dom7')
    expect(voicingMidis(root, dom7, 0)).toEqual([67, 71, 74, 77]) // G4 B4 D5 F5
    expect(voicingMidis(root, dom7, 1)).toEqual([71, 74, 77, 79]) // B4 D5 F5 G5
    expect(voicingMidis(root, dom7, 2)).toEqual([74, 77, 79, 83]) // D5 F5 G5 B5
    expect(voicingMidis(root, dom7, 3)).toEqual([77, 79, 83, 86]) // F5 G5 B5 D6
  })

  it('keeps every voicing note tagged with its originating interval', () => {
    const notes = chordVoicing(nameToPc('A'), getChordQuality('min7'), 0)
    expect(notes.map((n) => n.semitones)).toEqual(expect.arrayContaining([0, 3, 7, 10]))
    expect(notes.every((n) => Number.isInteger(n.midi))).toBe(true)
  })

  it('uses a custom base midi', () => {
    expect(voicingMidis(0, getChordQuality('maj'), 0, 48)).toEqual([48, 52, 55])
    expect(VOICING_BASE_MIDI).toBe(60)
  })
})

describe('buildChordFretboardMarkers', () => {
  const bass = getTuning('bass-4') // E1 A1 D2 G2

  it('marks the root, accents the 3rd, and defaults everything else', () => {
    const markers = buildChordFretboardMarkers(bass, nameToPc('C'), getChordQuality('maj'), 0, 12, 'note')
    expect(markers.length).toBeGreaterThan(0)
    // Every marked pitch class must be a chord tone (C, E, or G).
    for (const m of markers) {
      expect(['C', 'E', 'G']).toContain(m.label)
    }
    const rootMarkers = markers.filter((m) => m.variant === 'root')
    expect(rootMarkers.every((m) => m.label === 'C')).toBe(true)
    const accentMarkers = markers.filter((m) => m.variant === 'accent')
    expect(accentMarkers.every((m) => m.label === 'E')).toBe(true)
    const defaultMarkers = markers.filter((m) => m.variant === 'default')
    expect(defaultMarkers.every((m) => m.label === 'G')).toBe(true)
  })

  it('labels by interval when asked', () => {
    const markers = buildChordFretboardMarkers(bass, nameToPc('C'), getChordQuality('maj'), 0, 12, 'interval')
    const labels = new Set(markers.map((m) => m.label))
    expect(labels).toEqual(new Set(['R', 'M3', 'P5']))
  })

  it('finds the open low-E string as the major 3rd of a C major chord', () => {
    const markers = buildChordFretboardMarkers(bass, nameToPc('C'), getChordQuality('maj'), 0, 12, 'note')
    const openLowE = markers.find((m) => m.string === 0 && m.fret === 0)
    expect(openLowE).toEqual({ string: 0, fret: 0, variant: 'accent', label: 'E' })
  })
})

describe('buildChordKeyboardMarkers', () => {
  it('produces one marker per chord tone, matching chordVoicing', () => {
    const markers = buildChordKeyboardMarkers(nameToPc('A'), getChordQuality('min7'), 1, 'interval')
    expect(markers).toHaveLength(4)
    expect(markers.map((m) => m.midi)).toEqual(voicingMidis(nameToPc('A'), getChordQuality('min7'), 1))
    expect(markers.find((m) => m.variant === 'root')?.label).toBe('R')
  })
})

describe('arpeggioSteps', () => {
  it('sorts ascending and spaces steps by stepSeconds', () => {
    const steps = arpeggioSteps([67, 60, 64], 0.2, 1, false)
    expect(steps).toEqual([
      { midi: 60, when: 1 },
      { midi: 64, when: 1.2 },
      { midi: 67, when: 1.4 },
    ])
  })

  it('descends back down without repeating the top note', () => {
    const steps = arpeggioSteps([60, 64, 67], 0.2, 0, true)
    expect(steps.map((s) => s.midi)).toEqual([60, 64, 67, 64, 60])
  })

  it('stays ascending-only when descend is false', () => {
    const steps = arpeggioSteps([60, 64, 67], 0.2, 0, false)
    expect(steps.map((s) => s.midi)).toEqual([60, 64, 67])
  })
})

describe('chord explorer settings', () => {
  it('normalizes a valid value unchanged', () => {
    expect(normalizeChordExplorerSettings({ root: 9, qualityId: 'min7', inversion: 2 })).toEqual({
      root: 9,
      qualityId: 'min7',
      inversion: 2,
    })
  })

  it('wraps pitch class and inversion out-of-range values', () => {
    expect(normalizeChordExplorerSettings({ root: 14, qualityId: 'maj', inversion: 5 })).toEqual({
      root: 2,
      qualityId: 'maj',
      inversion: 2, // maj has 3 inversions: 5 % 3 = 2
    })
  })

  it('falls back to defaults for an unknown quality id', () => {
    expect(normalizeChordExplorerSettings({ root: 0, qualityId: 'nope', inversion: 0 })).toEqual(
      DEFAULT_CHORD_EXPLORER_SETTINGS,
    )
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeChordExplorerSettings(null)).toEqual(DEFAULT_CHORD_EXPLORER_SETTINGS)
    expect(normalizeChordExplorerSettings('nope')).toEqual(DEFAULT_CHORD_EXPLORER_SETTINGS)
  })

  it('re-clamps inversion after a quality change reduces the tone count', () => {
    // inversion 3 is valid for a 4-note quality but not for a 3-note triad.
    expect(normalizeChordExplorerSettings({ root: 0, qualityId: 'maj', inversion: 3 })).toEqual({
      root: 0,
      qualityId: 'maj',
      inversion: 0,
    })
  })
})

describe('chord explorer settings store', () => {
  it('defaults to C major, root position', () => {
    const store = createChordExplorerSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_CHORD_EXPLORER_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { root: 4, qualityId: 'dom7', inversion: 2 }
    createChordExplorerSettingsStore(backend).set(value)
    expect(createChordExplorerSettingsStore(backend).get()).toEqual(value)
  })
})
