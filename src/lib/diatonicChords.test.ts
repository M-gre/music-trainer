import { describe, expect, it } from 'vitest'
import { voicingMidis } from './chordExplorer.ts'
import { memoryBackend } from './storage.ts'
import { nameToPc } from './theory/notes.ts'
import {
  buildDiatonicChordCards,
  cardVoicing,
  chordDurationSeconds,
  COMMON_PROGRESSIONS,
  createDiatonicChordsSettingsStore,
  DEFAULT_DIATONIC_CHORDS_SETTINGS,
  isDiatonicScaleId,
  keyPrefersFlats,
  nearestVoicing,
  normalizeDiatonicChordsSettings,
  PROGRESSION_BEATS_PER_CHORD,
  PROGRESSION_BPM,
  scheduleProgression,
} from './diatonicChords.ts'

describe('buildDiatonicChordCards', () => {
  it('builds the seven diatonic triads of C major with correct numerals, symbols, and tones', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    expect(cards).toHaveLength(7)
    expect(cards.map((c) => c.numeral)).toEqual(['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'])
    expect(cards.map((c) => c.symbol)).toEqual(['C', 'Dm', 'Em', 'F', 'G', 'Am', 'Bdim'])
    expect(cards.map((c) => c.toneNames)).toEqual([
      ['C', 'E', 'G'],
      ['D', 'F', 'A'],
      ['E', 'G', 'B'],
      ['F', 'A', 'C'],
      ['G', 'B', 'D'],
      ['A', 'C', 'E'],
      ['B', 'D', 'F'],
    ])
    expect(cards.map((c) => c.degree)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('spells F major diatonic chords with Bb, not A#', () => {
    const cards = buildDiatonicChordCards(nameToPc('F'), 'major')
    // ii = Gm (G Bb D), IV = Bb (Bb D F)
    expect(cards[1]!.symbol).toBe('Gm')
    expect(cards[1]!.toneNames).toEqual(['G', 'Bb', 'D'])
    expect(cards[3]!.symbol).toBe('Bb')
    expect(cards[3]!.toneNames).toEqual(['Bb', 'D', 'F'])
  })

  it('produces a major V chord and augmented III+ in harmonic minor (raised leading tone)', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'harmonic-minor')
    expect(cards[0]!.numeral).toBe('i')
    expect(cards[4]!.numeral).toBe('V') // raised 7th makes v -> V
    expect(cards[4]!.symbol).toBe('G')
    expect(cards[2]!.numeral).toBe('III+')
    expect(cards[2]!.quality.id).toBe('aug')
  })

  it('gives natural minor a minor v and bVII, unlike harmonic minor', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'minor')
    expect(cards[4]!.numeral).toBe('v')
    expect(cards[4]!.quality.id).toBe('min')
    expect(cards[6]!.quality.id).toBe('maj')
  })
})

describe('keyPrefersFlats', () => {
  it('matches the major key signature directly for major scales', () => {
    expect(keyPrefersFlats(nameToPc('F'), 'major')).toBe(true)
    expect(keyPrefersFlats(nameToPc('G'), 'major')).toBe(false)
  })

  it('borrows the relative major signature for minor scales', () => {
    // E minor's relative major is G major (sharps) -> not flats.
    expect(keyPrefersFlats(nameToPc('E'), 'minor')).toBe(false)
    // C minor's relative major is Eb major (flats).
    expect(keyPrefersFlats(nameToPc('C'), 'minor')).toBe(true)
    expect(keyPrefersFlats(nameToPc('C'), 'harmonic-minor')).toBe(true)
  })
})

describe('isDiatonicScaleId', () => {
  it('accepts the three supported scale ids and rejects everything else', () => {
    expect(isDiatonicScaleId('major')).toBe(true)
    expect(isDiatonicScaleId('minor')).toBe(true)
    expect(isDiatonicScaleId('harmonic-minor')).toBe(true)
    expect(isDiatonicScaleId('dorian')).toBe(false)
    expect(isDiatonicScaleId(undefined)).toBe(false)
    expect(isDiatonicScaleId(42)).toBe(false)
  })
})

describe('cardVoicing', () => {
  it('returns a root-position triad anchored around the base midi', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    const voicing = cardVoicing(cards[0]!) // C major triad
    expect(voicing).toEqual([60, 64, 67])
  })
})

describe('nearestVoicing', () => {
  it('falls back to root position with no previous chord', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    const voicing = nearestVoicing(cards[0]!.root, cards[0]!.quality, null)
    expect(voicing).toEqual(cardVoicing(cards[0]!))
  })

  it('picks the inversion whose average pitch is closest to the previous chord', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    const previous = cardVoicing(cards[0]!) // C4 E4 G4
    const gCard = cards[4]! // V = G
    const voicing = nearestVoicing(gCard.root, gCard.quality, previous)

    // Brute-force every inversion of the G triad and confirm nearestVoicing
    // picked the one whose average pitch is closest to the previous chord.
    const center = (m: readonly number[]) => m.reduce((a, b) => a + b, 0) / m.length
    const prevCenter = center(previous)
    const chosenDist = Math.abs(center(voicing) - prevCenter)
    for (let inv = 0; inv < gCard.quality.intervals.length; inv++) {
      const alt = voicingMidis(gCard.root, gCard.quality, inv)
      expect(chosenDist).toBeLessThanOrEqual(Math.abs(center(alt) - prevCenter) + 1e-9)
    }
  })

  it('always returns as many notes as the quality has intervals', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    for (const card of cards) {
      const voicing = nearestVoicing(card.root, card.quality, [60, 64, 67])
      expect(voicing).toHaveLength(card.quality.intervals.length)
    }
  })
})

describe('chordDurationSeconds', () => {
  it('defaults to ~80 BPM, 2 beats per chord (1.5s)', () => {
    expect(chordDurationSeconds()).toBeCloseTo(1.5)
    expect(PROGRESSION_BPM).toBe(80)
    expect(PROGRESSION_BEATS_PER_CHORD).toBe(2)
  })

  it('scales with bpm and beats-per-chord', () => {
    expect(chordDurationSeconds(120, 1)).toBeCloseTo(0.5)
    expect(chordDurationSeconds(60, 4)).toBeCloseTo(4)
  })
})

describe('scheduleProgression', () => {
  it('schedules I-IV-V-I with sequential when offsets and correct chord roots', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    const progression = COMMON_PROGRESSIONS.find((p) => p.id === 'I-IV-V-I')!
    const steps = scheduleProgression(cards, progression.degrees, { startTime: 10 })
    expect(steps).toHaveLength(4)
    expect(steps.map((s) => s.cardIndex)).toEqual([0, 3, 4, 0])
    const duration = chordDurationSeconds()
    expect(steps.map((s) => s.when)).toEqual([10, 10 + duration, 10 + 2 * duration, 10 + 3 * duration])
    for (const step of steps) expect(step.duration).toBe(duration)
    // Roots: I=C(0), IV=F(5), V=G(7), I=C(0). An inversion may put the root
    // anywhere in the voicing (not necessarily the lowest note), so check
    // set membership rather than position.
    const expectedRootPcs = [0, 5, 7, 0]
    steps.forEach((step, i) => {
      expect(step.midis.map((m) => m % 12)).toContain(expectedRootPcs[i])
    })
  })

  it('throws for an out-of-range degree', () => {
    const cards = buildDiatonicChordCards(nameToPc('C'), 'major')
    expect(() => scheduleProgression(cards, [8])).toThrow()
    expect(() => scheduleProgression(cards, [0])).toThrow()
  })

  it('every named progression in COMMON_PROGRESSIONS resolves against any key', () => {
    const cards = buildDiatonicChordCards(nameToPc('Bb'), 'harmonic-minor')
    for (const progression of COMMON_PROGRESSIONS) {
      const steps = scheduleProgression(cards, progression.degrees)
      expect(steps).toHaveLength(progression.degrees.length)
    }
  })
})

describe('normalizeDiatonicChordsSettings', () => {
  it('returns the default for garbage input', () => {
    expect(normalizeDiatonicChordsSettings(null)).toEqual(DEFAULT_DIATONIC_CHORDS_SETTINGS)
    expect(normalizeDiatonicChordsSettings(undefined)).toEqual(DEFAULT_DIATONIC_CHORDS_SETTINGS)
    expect(normalizeDiatonicChordsSettings('nope')).toEqual(DEFAULT_DIATONIC_CHORDS_SETTINGS)
    expect(normalizeDiatonicChordsSettings({})).toEqual(DEFAULT_DIATONIC_CHORDS_SETTINGS)
  })

  it('clamps rootPc and falls back to major for an invalid scaleId', () => {
    expect(normalizeDiatonicChordsSettings({ rootPc: 14, scaleId: 'lydian' })).toEqual({
      rootPc: 2,
      scaleId: 'major',
    })
    expect(normalizeDiatonicChordsSettings({ rootPc: -1, scaleId: 'minor' })).toEqual({
      rootPc: 11,
      scaleId: 'minor',
    })
  })

  it('passes through valid values unchanged', () => {
    expect(normalizeDiatonicChordsSettings({ rootPc: 7, scaleId: 'harmonic-minor' })).toEqual({
      rootPc: 7,
      scaleId: 'harmonic-minor',
    })
  })
})

describe('createDiatonicChordsSettingsStore', () => {
  it('round-trips through a memory backend', () => {
    const store = createDiatonicChordsSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_DIATONIC_CHORDS_SETTINGS)
    store.set({ rootPc: 9, scaleId: 'minor' })
    expect(store.get()).toEqual({ rootPc: 9, scaleId: 'minor' })
  })

  it('is isolated per backend instance', () => {
    const a = createDiatonicChordsSettingsStore(memoryBackend())
    const b = createDiatonicChordsSettingsStore(memoryBackend())
    a.set({ rootPc: 3, scaleId: 'harmonic-minor' })
    expect(b.get()).toEqual(DEFAULT_DIATONIC_CHORDS_SETTINGS)
  })
})
