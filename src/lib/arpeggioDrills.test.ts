import { describe, expect, it } from 'vitest'
import {
  ARPEGGIO_QUALITY_IDS,
  ARPEGGIO_SPAN,
  arpeggioQualityGroups,
  DEFAULT_ARPEGGIO_QUALITY_ID,
  DEFAULT_INVERSION,
  expandArpeggio,
  getArpeggioQuality,
  INVERSIONS,
  inversionDegreeIndex,
  inversionsForIntervals,
  isArpeggioQualityId,
  isInversion,
  positionChordTones,
} from './arpeggioDrills.ts'
import { stepTimings } from './exercises.ts'
import { chordPcs, getChordQuality } from './theory/chords.ts'
import { fretMidi, getTuning } from './theory/instruments.ts'
import { mod12 } from './theory/notes.ts'

const bass4 = getTuning('bass-4')
const guitar6 = getTuning('guitar-6')
const C = 0

const majTriad = getChordQuality('maj').intervals // [0,4,7]
const dom7 = getChordQuality('dom7').intervals // [0,4,7,10]
const augTriad = getChordQuality('aug').intervals // [0,4,8]
const dimTriad = getChordQuality('dim').intervals // [0,3,6]

/** Compact a step to the load-bearing fields. */
function cell(s: { string: number; fret: number; finger: number; midi: number }) {
  return { string: s.string, fret: s.fret, finger: s.finger, midi: s.midi }
}

describe('positionChordTones', () => {
  it('collects C major triad tones in a 5-fret window on 4-string bass (EADG), string-major order', () => {
    // Anchor 2, window frets 2..6, C major = {C, E, G}.
    const tones = positionChordTones(bass4, C, majTriad, 2).map(cell)
    expect(tones).toEqual([
      { string: 0, fret: 3, finger: 2, midi: fretMidi(bass4, 0, 3) }, // G
      { string: 1, fret: 3, finger: 2, midi: fretMidi(bass4, 1, 3) }, // C
      { string: 2, fret: 2, finger: 1, midi: fretMidi(bass4, 2, 2) }, // E
      { string: 2, fret: 5, finger: 4, midi: fretMidi(bass4, 2, 5) }, // G
      { string: 3, fret: 5, finger: 4, midi: fretMidi(bass4, 3, 5) }, // C
    ])
    // Only chord-tone pitch classes appear.
    expect(new Set(tones.map((t) => mod12(t.midi)))).toEqual(new Set([0, 4, 7]))
  })

  it('assigns fingers by fret offset from the window start, clamped to 1..4', () => {
    const tones = positionChordTones(bass4, C, majTriad, 2)
    for (const t of tones) {
      expect(t.finger).toBe(Math.min(4, Math.max(1, t.fret - 2 + 1)))
    }
  })

  it('clips frets below the nut when the anchor is negative', () => {
    const tones = positionChordTones(bass4, C, majTriad, -1)
    expect(tones.every((t) => t.fret >= 0)).toBe(true)
  })

  it('gets aug and dim chord intervals right (G# vs Gb)', () => {
    // Wide window across the whole neck so every chord tone is guaranteed present.
    const aug = positionChordTones(bass4, C, augTriad, 0, 12)
    expect(new Set(aug.map((t) => mod12(t.midi)))).toEqual(new Set(chordPcs(C, getChordQuality('aug'))))
    expect(aug.some((t) => mod12(t.midi) === 8)).toBe(true) // G# present, not G

    const dim = positionChordTones(bass4, C, dimTriad, 0, 12)
    expect(new Set(dim.map((t) => mod12(t.midi)))).toEqual(new Set(chordPcs(C, getChordQuality('dim'))))
    expect(dim.some((t) => mod12(t.midi) === 6)).toBe(true) // Gb present, not G
  })
})

describe('expandArpeggio — root position', () => {
  it('emits an ascending C major arpeggio on 4-string bass starting on the root', () => {
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: majTriad, inversion: 'root', anchor: 2 })
    expect(steps.map(cell)).toEqual([
      { string: 1, fret: 3, finger: 2, midi: fretMidi(bass4, 1, 3) }, // C
      { string: 2, fret: 2, finger: 1, midi: fretMidi(bass4, 2, 2) }, // E
      { string: 2, fret: 5, finger: 4, midi: fretMidi(bass4, 2, 5) }, // G
      { string: 3, fret: 5, finger: 4, midi: fretMidi(bass4, 3, 5) }, // C
    ])
    // Bass note is the root; pitches climb; every step is one grid slot.
    expect(mod12(steps[0]!.midi)).toBe(0)
    const midis = steps.map((s) => s.midi)
    expect(midis).toEqual([...midis].sort((a, b) => a - b))
    expect(steps.every((s) => s.duration === 1)).toBe(true)
    expect(stepTimings(steps).totalGridSteps).toBe(steps.length)
  })

  it('places the same shape on 6-string guitar via real pitch math (G→B major-third string)', () => {
    const steps = expandArpeggio({ tuning: guitar6, root: C, intervals: majTriad, inversion: 'root', anchor: 2 })
    expect(steps.map((s) => ({ string: s.string, fret: s.fret }))).toEqual([
      { string: 1, fret: 3 }, // C
      { string: 2, fret: 2 }, // E
      { string: 2, fret: 5 }, // G
      { string: 3, fret: 5 }, // C
      { string: 4, fret: 5 }, // E on the B string — a major third up, so fret 5 not 4
      { string: 5, fret: 3 }, // G
    ])
    expect(steps.map((s) => s.midi)).toEqual([48, 52, 55, 60, 64, 67])
    // The B string (index 4) sits a major third above the G string, so its E
    // lands on fret 5 (midi 64), which a naive fret-offset copy would miss.
    expect(fretMidi(guitar6, 4, 5)).toBe(64)
  })

  it('includes the flat 7th of a dominant 7th arpeggio', () => {
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: dom7, inversion: 'root', anchor: 2 })
    expect(steps.map(cell)).toEqual([
      { string: 1, fret: 3, finger: 2, midi: fretMidi(bass4, 1, 3) }, // C
      { string: 2, fret: 2, finger: 1, midi: fretMidi(bass4, 2, 2) }, // E
      { string: 2, fret: 5, finger: 4, midi: fretMidi(bass4, 2, 5) }, // G
      { string: 3, fret: 3, finger: 2, midi: fretMidi(bass4, 3, 3) }, // Bb (b7)
      { string: 3, fret: 5, finger: 4, midi: fretMidi(bass4, 3, 5) }, // C
    ])
    expect(steps.some((s) => mod12(s.midi) === 10)).toBe(true) // Bb present
  })
})

describe('expandArpeggio — inversions', () => {
  it('1st inversion begins on the 3rd', () => {
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: majTriad, inversion: 'first', anchor: 2 })
    expect(mod12(steps[0]!.midi)).toBe(4) // E
    expect(steps.map(cell)).toEqual([
      { string: 2, fret: 2, finger: 1, midi: fretMidi(bass4, 2, 2) }, // E
      { string: 2, fret: 5, finger: 4, midi: fretMidi(bass4, 2, 5) }, // G
      { string: 3, fret: 5, finger: 4, midi: fretMidi(bass4, 3, 5) }, // C
    ])
  })

  it('2nd inversion begins on the 5th, picking up the lower G', () => {
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: majTriad, inversion: 'second', anchor: 2 })
    expect(mod12(steps[0]!.midi)).toBe(7) // G
    expect(steps[0]!.string).toBe(0) // the low-E-string G at fret 3
    expect(steps[0]!.fret).toBe(3)
    expect(steps).toHaveLength(5)
  })

  it('3rd inversion of a 7th chord begins on the 7th', () => {
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: dom7, inversion: 'third', anchor: 2 })
    expect(mod12(steps[0]!.midi)).toBe(10) // Bb, the b7
  })

  it('3rd inversion of a triad is empty (no 7th to sit in the bass)', () => {
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: majTriad, inversion: 'third', anchor: 2 })
    expect(steps).toEqual([])
  })

  it('is empty when the window holds no tone of the bass degree', () => {
    // Window = single fret 2: only E (str 2) is a C-major tone, so a
    // root-position drill (bass = C) has nothing to start on.
    const steps = expandArpeggio({ tuning: bass4, root: C, intervals: majTriad, inversion: 'root', anchor: 2, span: 1 })
    expect(steps).toEqual([])
  })
})

describe('inversion registry', () => {
  it('maps each inversion to its bass chord-tone index', () => {
    expect(inversionDegreeIndex('root')).toBe(0)
    expect(inversionDegreeIndex('first')).toBe(1)
    expect(inversionDegreeIndex('second')).toBe(2)
    expect(inversionDegreeIndex('third')).toBe(3)
  })
  it('recognises its own ids and rejects others', () => {
    expect(isInversion('first')).toBe(true)
    expect(isInversion('fourth')).toBe(false)
  })
  it('hides the 3rd inversion for triads but shows it for 7th chords', () => {
    expect(inversionsForIntervals(3).map((i) => i.id)).toEqual(['root', 'first', 'second'])
    expect(inversionsForIntervals(4).map((i) => i.id)).toEqual(['root', 'first', 'second', 'third'])
  })
  it('has a default that is a real inversion', () => {
    expect(INVERSIONS.some((i) => i.id === DEFAULT_INVERSION)).toBe(true)
  })
})

describe('quality registry', () => {
  it('recognises supported qualities and rejects others', () => {
    expect(isArpeggioQualityId('maj')).toBe(true)
    expect(isArpeggioQualityId('dim7')).toBe(true)
    expect(isArpeggioQualityId('sus4')).toBe(false)
  })
  it('groups triads and 7th chords for the picker', () => {
    const groups = arpeggioQualityGroups()
    expect(groups.map((g) => g.label)).toEqual(['Triads', '7th chords'])
    expect(groups[0]!.qualities.map((q) => q.id)).toEqual(['maj', 'min', 'dim', 'aug'])
    expect(groups[1]!.qualities.map((q) => q.id)).toEqual(['maj7', 'min7', 'dom7', 'min7b5', 'dim7'])
  })
  it('looks a quality up with a default fallback', () => {
    expect(getArpeggioQuality('min7').id).toBe('min7')
    expect(getArpeggioQuality('sus2').id).toBe(DEFAULT_ARPEGGIO_QUALITY_ID)
  })
  it('every quality id resolves to a real chord quality', () => {
    for (const id of ARPEGGIO_QUALITY_IDS) expect(getArpeggioQuality(id).id).toBe(id)
  })
  it('uses a sensible default span', () => {
    expect(ARPEGGIO_SPAN).toBeGreaterThanOrEqual(4)
  })
})
