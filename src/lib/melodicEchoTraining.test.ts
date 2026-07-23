import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import type { Rng } from './quiz.ts'
import { midiToPc } from './theory/notes.ts'
import {
  accumulateStat,
  accuracy,
  ALL_ROOT_PCS,
  clampLength,
  createMelodicEchoSettingsStore,
  createMelodicEchoStatsStore,
  DEFAULT_LENGTH,
  DEFAULT_MELODIC_ECHO_SETTINGS,
  DEFAULT_STEP_SECONDS,
  DEGREE_MAX,
  DEGREE_MIN,
  degreeToMidi,
  EMPTY_MELODIC_ECHO_STATS,
  generateMelodicEchoQuestion,
  generatePhraseDegrees,
  initialEchoState,
  MAX_LENGTH,
  MIN_LENGTH,
  noteMatches,
  normalizeMelodicEchoSettings,
  normalizeMelodicEchoStats,
  phraseLength,
  questionPhraseSteps,
  scaleIdFor,
  submitEchoNote,
  tonicMidi,
  TONIC_OCTAVE_BASE,
  type MelodicEchoContext,
  type MelodicEchoQuestion,
} from './melodicEchoTraining.ts'

/** Deterministic rng cycling through the given values in [0,1). */
function seq(values: number[]): Rng {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

/** Build a question directly from degrees for reducer tests. */
function makeQuestion(degrees: number[], rootPc = 0, scaleType: 'major' | 'minor' = 'major'): MelodicEchoQuestion {
  return {
    rootPc,
    scaleType,
    degrees,
    midis: degrees.map((d) => degreeToMidi(rootPc, scaleType, d)),
  }
}

describe('scaleIdFor', () => {
  it('maps the two flavours to theory scale ids', () => {
    expect(scaleIdFor('major')).toBe('major')
    expect(scaleIdFor('minor')).toBe('minor')
  })
})

describe('ALL_ROOT_PCS', () => {
  it('is the twelve pitch classes in chromatic order', () => {
    expect(ALL_ROOT_PCS).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })
})

describe('tonicMidi', () => {
  it('places the tonic in the C4-based octave', () => {
    expect(tonicMidi(0)).toBe(TONIC_OCTAVE_BASE) // C4
    expect(tonicMidi(7)).toBe(67) // G4
    expect(tonicMidi(11)).toBe(71) // B4
  })

  it('wraps pitch classes into range', () => {
    expect(tonicMidi(12)).toBe(60)
    expect(tonicMidi(-1)).toBe(71)
  })
})

describe('degreeToMidi', () => {
  it('builds C major degrees from the tonic through the ninth', () => {
    // C D E F G A B C D  => degrees 0..8
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((d) => degreeToMidi(0, 'major', d))).toEqual([
      60, 62, 64, 65, 67, 69, 71, 72, 74,
    ])
  })

  it('builds A minor (natural) degrees', () => {
    // rootPc 9 -> tonic A4 = 69; natural minor intervals 0 2 3 5 7 8 10
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => degreeToMidi(9, 'minor', d))).toEqual([
      69, 71, 72, 74, 76, 77, 79, 81,
    ])
  })

  it('degree 7 is exactly the octave above the tonic', () => {
    expect(degreeToMidi(0, 'major', 7)).toBe(degreeToMidi(0, 'major', 0) + 12)
    expect(degreeToMidi(5, 'minor', 7)).toBe(degreeToMidi(5, 'minor', 0) + 12)
  })
})

describe('generatePhraseDegrees', () => {
  it('produces exactly `length` notes (clamped)', () => {
    expect(generatePhraseDegrees(3, seq([0.4, 0.9, 0.4, 0.9]))).toHaveLength(3)
    expect(generatePhraseDegrees(6, () => 0.4)).toHaveLength(6)
    expect(generatePhraseDegrees(99, () => 0.4)).toHaveLength(MAX_LENGTH)
    expect(generatePhraseDegrees(0, () => 0.4)).toHaveLength(MIN_LENGTH)
  })

  it('starts on the tonic (degree 0) or the fifth (degree 4)', () => {
    expect(generatePhraseDegrees(2, seq([0.2, 0.4, 0.9]))[0]).toBe(0) // rng<0.5 -> tonic
    expect(generatePhraseDegrees(2, seq([0.7, 0.4, 0.9]))[0]).toBe(4) // rng>=0.5 -> fifth
  })

  it('keeps every note within DEGREE_MIN..DEGREE_MAX for many random phrases', () => {
    const rng = seq([0.05, 0.2, 0.35, 0.55, 0.7, 0.85, 0.95, 0.15, 0.45, 0.65])
    for (let i = 0; i < 200; i += 1) {
      for (const d of generatePhraseDegrees(6, rng)) {
        expect(d).toBeGreaterThanOrEqual(DEGREE_MIN)
        expect(d).toBeLessThanOrEqual(DEGREE_MAX)
      }
    }
  })

  it('moves stepwise when the third roll misses and direction fits', () => {
    // start fifth (0.7), then: magnitude roll 0.9 (>=0.25 -> step of 1),
    // direction roll 0.2 (<0.5 -> +1) => 4 -> 5.
    const degrees = generatePhraseDegrees(2, seq([0.7, 0.9, 0.2]))
    expect(degrees).toEqual([4, 5])
  })

  it('takes a third when the magnitude roll is below THIRD_PROBABILITY', () => {
    // start tonic (0.2), magnitude roll 0.1 (<0.25 -> third of 2),
    // direction roll 0.2 (<0.5 -> +1) => 0 -> 2.
    const degrees = generatePhraseDegrees(2, seq([0.2, 0.1, 0.2]))
    expect(degrees).toEqual([0, 2])
  })

  it('flips a direction that would leave the range', () => {
    // start tonic 0 (0.2); magnitude step (0.9); direction -1 (0.7) would go to
    // -1 (out of range) -> flip to +1 => 1.
    const degrees = generatePhraseDegrees(2, seq([0.2, 0.9, 0.7]))
    expect(degrees).toEqual([0, 1])
  })
})

describe('generateMelodicEchoQuestion', () => {
  const ctx: MelodicEchoContext = { length: 4, rootPc: 0, scaleType: 'major' }

  it('produces a phrase of the requested length with matching midis', () => {
    const q = generateMelodicEchoQuestion(ctx, null, seq([0.2, 0.9, 0.2, 0.9, 0.2, 0.9, 0.2]))
    expect(q.degrees).toHaveLength(4)
    expect(q.midis).toHaveLength(4)
    expect(q.midis).toEqual(q.degrees.map((d) => degreeToMidi(0, 'major', d)))
    expect(q.rootPc).toBe(0)
    expect(q.scaleType).toBe('major')
  })

  it('every phrase pitch class is diatonic to the key', () => {
    const rng = seq([0.05, 0.2, 0.35, 0.55, 0.7, 0.85, 0.95])
    const diatonic = new Set([0, 2, 4, 5, 7, 9, 11]) // C major pcs
    for (let i = 0; i < 50; i += 1) {
      const q = generateMelodicEchoQuestion(ctx, null, rng)
      for (const midi of q.midis) expect(diatonic.has(midiToPc(midi))).toBe(true)
    }
  })

  it('normalizes an out-of-range root pitch class and unknown scale type', () => {
    const q = generateMelodicEchoQuestion(
      { length: 2, rootPc: 14, scaleType: 'bogus' as unknown as 'major' },
      null,
      seq([0.2, 0.9, 0.2]),
    )
    expect(q.rootPc).toBe(2)
    expect(q.scaleType).toBe('major')
  })

  it('avoids handing back the previous phrase unchanged when it can', () => {
    // A single fixed rng would reproduce the same phrase; the generator retries
    // and here the constant rng cannot escape, so it must not loop forever.
    const previous = makeQuestion([0, 1])
    const q = generateMelodicEchoQuestion({ length: 2, rootPc: 0, scaleType: 'major' }, previous, () => 0.2)
    expect(q.degrees).toHaveLength(2)
  })
})

describe('questionPhraseSteps', () => {
  it('spaces notes by DEFAULT_STEP_SECONDS from startTime', () => {
    const q = makeQuestion([0, 2, 4])
    const steps = questionPhraseSteps(q, 0.5, 1)
    expect(steps).toEqual([
      { midi: 60, when: 1 },
      { midi: 64, when: 1.5 },
      { midi: 67, when: 2 },
    ])
  })

  it('defaults to ~90 BPM quarter-note spacing', () => {
    const q = makeQuestion([0, 2])
    const steps = questionPhraseSteps(q)
    expect(steps[0]!.when).toBe(0)
    expect(steps[1]!.when).toBeCloseTo(DEFAULT_STEP_SECONDS)
    expect(DEFAULT_STEP_SECONDS).toBeCloseTo(0.6667, 3)
  })
})

describe('noteMatches', () => {
  it('exact mode requires the same midi', () => {
    expect(noteMatches(60, 60, 'exact')).toBe(true)
    expect(noteMatches(60, 72, 'exact')).toBe(false)
  })

  it('pitch-class mode accepts any octave of the same pitch class', () => {
    expect(noteMatches(60, 72, 'pitch-class')).toBe(true)
    expect(noteMatches(60, 48, 'pitch-class')).toBe(true)
    expect(noteMatches(60, 61, 'pitch-class')).toBe(false)
  })
})

describe('submitEchoNote', () => {
  const q = makeQuestion([0, 2, 4]) // C E G at 60, 64, 67
  const total = phraseLength(q)

  it('advances on a correct note without recording a mistake', () => {
    const r = submitEchoNote(q, initialEchoState(), 60, 'exact')
    expect(r.result).toBe('correct')
    expect(r.state).toEqual({ matched: 1, mistakes: 0 })
    expect(r.complete).toBe(false)
    expect(r.expected).toBe(60)
  })

  it('completes cleanly when all notes are echoed with no mistakes', () => {
    let state = initialEchoState()
    for (let i = 0; i < total - 1; i += 1) state = submitEchoNote(q, state, q.midis[i]!, 'exact').state
    const last = submitEchoNote(q, state, q.midis[total - 1]!, 'exact')
    expect(last.result).toBe('complete')
    expect(last.complete).toBe(true)
    expect(last.clean).toBe(true)
    expect(last.state.matched).toBe(total)
  })

  it('resets to the start and records a mistake on a wrong note', () => {
    const state = { matched: 2, mistakes: 0 }
    const r = submitEchoNote(q, state, 61, 'exact')
    expect(r.result).toBe('wrong')
    expect(r.state).toEqual({ matched: 0, mistakes: 1 })
    expect(r.expected).toBe(67) // was expecting the 3rd note (G)
  })

  it('lets the player finish after a mistake, but not cleanly', () => {
    let state = initialEchoState()
    state = submitEchoNote(q, state, 60, 'exact').state // correct
    const wrong = submitEchoNote(q, state, 99, 'exact') // wrong -> reset
    expect(wrong.result).toBe('wrong')
    state = wrong.state
    for (let i = 0; i < total - 1; i += 1) state = submitEchoNote(q, state, q.midis[i]!, 'exact').state
    const done = submitEchoNote(q, state, q.midis[total - 1]!, 'exact')
    expect(done.complete).toBe(true)
    expect(done.clean).toBe(false)
    expect(done.state.mistakes).toBe(1)
  })

  it('accepts any octave in pitch-class mode', () => {
    const r = submitEchoNote(q, initialEchoState(), 72, 'pitch-class') // C5 for C4
    expect(r.result).toBe('correct')
    expect(r.state.matched).toBe(1)
  })

  it('is a no-op once the phrase is complete', () => {
    const state = { matched: total, mistakes: 0 }
    const r = submitEchoNote(q, state, 60, 'exact')
    expect(r.result).toBe('complete')
    expect(r.state).toBe(state)
  })

  it('does not mutate the input state', () => {
    const state = initialEchoState()
    submitEchoNote(q, state, 60, 'exact')
    expect(state).toEqual({ matched: 0, mistakes: 0 })
  })
})

describe('accuracy / accumulateStat', () => {
  it('accuracy is clean/attempts, or null with no attempts', () => {
    expect(accuracy(EMPTY_MELODIC_ECHO_STATS)).toBeNull()
    expect(accuracy({ attempts: 4, clean: 3, bestStreak: 2 })).toBeCloseTo(0.75)
  })

  it('folds attempts, clean finishes and best streak without mutating input', () => {
    const empty = { ...EMPTY_MELODIC_ECHO_STATS }
    const a = accumulateStat(empty, true, 1)
    const b = accumulateStat(a, false, 0)
    expect(empty).toEqual(EMPTY_MELODIC_ECHO_STATS)
    expect(a).toEqual({ attempts: 1, clean: 1, bestStreak: 1 })
    expect(b).toEqual({ attempts: 2, clean: 1, bestStreak: 1 })
  })

  it('raises best streak only when the new streak is higher', () => {
    let s = accumulateStat(EMPTY_MELODIC_ECHO_STATS, true, 3)
    expect(s.bestStreak).toBe(3)
    s = accumulateStat(s, true, 2)
    expect(s.bestStreak).toBe(3)
    s = accumulateStat(s, true, 5)
    expect(s.bestStreak).toBe(5)
  })
})

describe('normalizeMelodicEchoStats', () => {
  it('coerces valid data and clamps clean to attempts', () => {
    expect(normalizeMelodicEchoStats({ attempts: 5, clean: 9, bestStreak: 3 })).toEqual({
      attempts: 5,
      clean: 5,
      bestStreak: 3,
    })
  })

  it('floors and rejects negatives / non-numbers', () => {
    expect(normalizeMelodicEchoStats({ attempts: -2, clean: 'x', bestStreak: 4.9 })).toEqual({
      attempts: 0,
      clean: 0,
      bestStreak: 4,
    })
  })

  it('returns empty stats for non-object input', () => {
    expect(normalizeMelodicEchoStats(null)).toEqual(EMPTY_MELODIC_ECHO_STATS)
    expect(normalizeMelodicEchoStats('nope')).toEqual(EMPTY_MELODIC_ECHO_STATS)
  })
})

describe('clampLength', () => {
  it('clamps to MIN_LENGTH..MAX_LENGTH and floors', () => {
    expect(clampLength(1)).toBe(MIN_LENGTH)
    expect(clampLength(7)).toBe(MAX_LENGTH)
    expect(clampLength(3.9)).toBe(3)
  })

  it('defaults invalid input', () => {
    expect(clampLength('x')).toBe(DEFAULT_LENGTH)
    expect(clampLength(NaN)).toBe(DEFAULT_LENGTH)
    expect(clampLength(undefined)).toBe(DEFAULT_LENGTH)
  })
})

describe('normalizeMelodicEchoSettings', () => {
  it('passes through valid settings', () => {
    expect(
      normalizeMelodicEchoSettings({ length: 5, rootPc: 7, scaleType: 'minor', inputMode: 'keyboard' }),
    ).toEqual({ length: 5, rootPc: 7, scaleType: 'minor', inputMode: 'keyboard' })
  })

  it('repairs each field', () => {
    expect(normalizeMelodicEchoSettings({ length: 99, rootPc: 15, scaleType: 'x', inputMode: 'y' })).toEqual({
      length: MAX_LENGTH,
      rootPc: 3,
      scaleType: 'major',
      inputMode: 'fretboard',
    })
  })

  it('falls back entirely for non-object input', () => {
    expect(normalizeMelodicEchoSettings(null)).toEqual(DEFAULT_MELODIC_ECHO_SETTINGS)
  })
})

describe('settings store', () => {
  it('defaults to the standard settings', () => {
    const store = createMelodicEchoSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_MELODIC_ECHO_SETTINGS)
  })

  it('round-trips settings across instances sharing a backend', () => {
    const backend = memoryBackend()
    const value = { length: 4, rootPc: 2, scaleType: 'minor' as const, inputMode: 'keyboard' as const }
    createMelodicEchoSettingsStore(backend).set(value)
    expect(createMelodicEchoSettingsStore(backend).get()).toEqual(value)
  })
})

describe('stats store', () => {
  it('defaults to empty stats', () => {
    const store = createMelodicEchoStatsStore(memoryBackend())
    expect(store.get()).toEqual(EMPTY_MELODIC_ECHO_STATS)
  })

  it('round-trips accumulated stats', () => {
    const backend = memoryBackend()
    let stats = accumulateStat(EMPTY_MELODIC_ECHO_STATS, true, 1)
    stats = accumulateStat(stats, false, 0)
    createMelodicEchoStatsStore(backend).set(stats)
    expect(normalizeMelodicEchoStats(createMelodicEchoStatsStore(backend).get())).toEqual({
      attempts: 2,
      clean: 1,
      bestStreak: 1,
    })
  })
})
