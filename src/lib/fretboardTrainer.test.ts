import { describe, expect, it } from 'vitest'
import {
  checkAnswer,
  createTrainerSettingsStore,
  DEFAULT_TRAINER_SETTINGS,
  generateQuestion,
  MAX_FRET,
  normalizeTrainerSettings,
  possibleQuestions,
  resolveIncludedStrings,
  type FindQuestion,
  type NameQuestion,
  type QuestionContext,
  type TrainerQuestion,
} from './fretboardTrainer.ts'
import { getTuning } from './theory/instruments.ts'
import { midiToPc } from './theory/notes.ts'
import { memoryBackend } from './storage.ts'
import type { Rng } from './quiz.ts'

const bass4 = getTuning('bass-4') // E1 A1 D2 G2

function seq(...values: number[]): Rng {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

function ctx(partial: Partial<QuestionContext>): QuestionContext {
  return {
    tuning: bass4,
    mode: 'find',
    fromFret: 0,
    toFret: 12,
    includedStrings: [0, 1, 2, 3],
    ...partial,
  }
}

describe('checkAnswer', () => {
  const find: FindQuestion = { mode: 'find', pc: 4, string: 0, answerFrets: [0, 12] }
  const name: NameQuestion = { mode: 'name', string: 0, fret: 1, pc: 5 }

  it('accepts any listed fret on the right string for a find question', () => {
    expect(checkAnswer(find, { kind: 'position', string: 0, fret: 0 })).toBe(true)
    expect(checkAnswer(find, { kind: 'position', string: 0, fret: 12 })).toBe(true)
  })

  it('rejects the right pitch class on the wrong string', () => {
    expect(checkAnswer(find, { kind: 'position', string: 1, fret: 0 })).toBe(false)
  })

  it('rejects a fret that is not a match', () => {
    expect(checkAnswer(find, { kind: 'position', string: 0, fret: 5 })).toBe(false)
  })

  it('grades a name question by pitch class', () => {
    expect(checkAnswer(name, { kind: 'pc', pc: 5 })).toBe(true)
    expect(checkAnswer(name, { kind: 'pc', pc: 6 })).toBe(false)
  })

  it('is incorrect when the answer kind does not match the question mode', () => {
    expect(checkAnswer(find, { kind: 'pc', pc: 4 })).toBe(false)
    expect(checkAnswer(name, { kind: 'position', string: 0, fret: 1 })).toBe(false)
  })
})

describe('possibleQuestions', () => {
  it('name mode yields one question per (string, fret) in range', () => {
    const qs = possibleQuestions(ctx({ mode: 'name', fromFret: 0, toFret: 2, includedStrings: [0] }))
    expect(qs).toHaveLength(3)
    expect(qs.every((q) => q.mode === 'name' && q.string === 0)).toBe(true)
    // E1 open = E (4), fret1 = F (5), fret2 = F# (6)
    expect((qs as NameQuestion[]).map((q) => q.pc)).toEqual([4, 5, 6])
  })

  it('find mode groups all matching frets of a pitch class into one question', () => {
    const qs = possibleQuestions(
      ctx({ mode: 'find', fromFret: 0, toFret: 12, includedStrings: [0] }),
    ) as FindQuestion[]
    // On a 0-12 span each of the 12 pitch classes appears; the open E repeats at 12.
    expect(qs).toHaveLength(12)
    const openE = qs.find((q) => q.pc === 4)
    expect(openE?.answerFrets).toEqual([0, 12])
  })

  it('every generated answer fret genuinely matches its pitch class', () => {
    const qs = possibleQuestions(ctx({ mode: 'find' })) as FindQuestion[]
    for (const q of qs) {
      for (const fret of q.answerFrets) {
        expect(midiToPc(bass4.strings[q.string]! + fret)).toBe(q.pc)
      }
    }
  })

  it('respects the included-strings filter', () => {
    const qs = possibleQuestions(ctx({ mode: 'name', includedStrings: [2] }))
    expect(qs.every((q) => q.string === 2)).toBe(true)
  })

  it('handles a reversed range by normalizing from/to', () => {
    const qs = possibleQuestions(ctx({ mode: 'name', fromFret: 5, toFret: 3, includedStrings: [0] }))
    expect(qs).toHaveLength(3)
  })
})

describe('generateQuestion', () => {
  it('is deterministic for a given rng', () => {
    const c = ctx({ mode: 'name', fromFret: 0, toFret: 2, includedStrings: [0] })
    const a = generateQuestion(c, null, seq(0))
    const b = generateQuestion(c, null, seq(0))
    expect(a).toEqual(b)
  })

  it('avoids an immediate repeat of the previous question', () => {
    const c = ctx({ mode: 'name', fromFret: 0, toFret: 2, includedStrings: [0] })
    const first = generateQuestion(c, null, seq(0)) // index 0
    // rng 0 would pick index 0 again, but `first` is filtered out.
    const second = generateQuestion(c, first, seq(0))
    expect(second).not.toEqual(first)
  })

  it('avoids repeats by target even when fret lists differ (find mode)', () => {
    const c = ctx({ mode: 'find', fromFret: 0, toFret: 12, includedStrings: [0] })
    const prev: TrainerQuestion = { mode: 'find', pc: 4, string: 0, answerFrets: [0, 12] }
    const next = generateQuestion(c, prev, seq(0)) as FindQuestion
    expect(next.pc === prev.pc && next.string === prev.string).toBe(false)
  })

  it('throws when no question is answerable', () => {
    expect(() => generateQuestion(ctx({ includedStrings: [] }), null, seq(0))).toThrow()
  })
})

describe('resolveIncludedStrings', () => {
  it('returns all strings when none are excluded', () => {
    expect(resolveIncludedStrings([], 4)).toEqual([0, 1, 2, 3])
  })

  it('removes excluded strings', () => {
    expect(resolveIncludedStrings([1, 3], 4)).toEqual([0, 2])
  })

  it('falls back to all strings if everything is excluded', () => {
    expect(resolveIncludedStrings([0, 1, 2, 3], 4)).toEqual([0, 1, 2, 3])
  })

  it('ignores exclusions beyond the string count (fewer strings than before)', () => {
    expect(resolveIncludedStrings([4, 5], 4)).toEqual([0, 1, 2, 3])
  })
})

describe('normalizeTrainerSettings', () => {
  it('returns defaults for junk', () => {
    expect(normalizeTrainerSettings(null)).toEqual(DEFAULT_TRAINER_SETTINGS)
    expect(normalizeTrainerSettings('nope')).toEqual(DEFAULT_TRAINER_SETTINGS)
  })

  it('clamps frets into [0, MAX_FRET] and keeps to >= from', () => {
    const s = normalizeTrainerSettings({ fromFret: -3, toFret: 99 })
    expect(s.fromFret).toBe(0)
    expect(s.toFret).toBe(MAX_FRET)
    const flipped = normalizeTrainerSettings({ fromFret: 10, toFret: 4 })
    expect(flipped.fromFret).toBe(10)
    expect(flipped.toFret).toBe(10)
  })

  it('validates mode and accidentals', () => {
    expect(normalizeTrainerSettings({ mode: 'name' }).mode).toBe('name')
    expect(normalizeTrainerSettings({ mode: 'bogus' }).mode).toBe('find')
    expect(normalizeTrainerSettings({ accidentals: 'flat' }).accidentals).toBe('flat')
    expect(normalizeTrainerSettings({ accidentals: 'x' }).accidentals).toBe('sharp')
  })

  it('dedupes, sorts, and filters excluded strings', () => {
    const s = normalizeTrainerSettings({ excludedStrings: [3, 1, 1, -2, 'x', 0.5] })
    expect(s.excludedStrings).toEqual([1, 3])
  })
})

describe('trainer settings store', () => {
  it('defaults when empty', () => {
    const store = createTrainerSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_TRAINER_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const written = { ...DEFAULT_TRAINER_SETTINGS, mode: 'name' as const, toFret: 5 }
    createTrainerSettingsStore(backend).set(written)
    expect(createTrainerSettingsStore(backend).get()).toEqual(written)
  })
})
