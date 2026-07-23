import { describe, expect, it } from 'vitest'
import {
  checkAnswer,
  createKeyboardTrainerSettingsStore,
  DEFAULT_KEYBOARD_TRAINER_SETTINGS,
  generateQuestion,
  MAX_OCTAVE,
  normalizeTrainerSettings,
  possibleQuestions,
  type FindQuestion,
  type NameQuestion,
  type QuestionContext,
  type TrainerQuestion,
} from './keyboardTrainer.ts'
import { midiToPc, nameToMidi } from './theory/notes.ts'
import { memoryBackend } from './storage.ts'
import type { Rng } from './quiz.ts'

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
    mode: 'find',
    fromMidi: nameToMidi('C3'),
    toMidi: nameToMidi('C5'),
    ...partial,
  }
}

describe('checkAnswer', () => {
  const find: FindQuestion = { mode: 'find', pc: 4, answerMidis: [64, 76] }
  const name: NameQuestion = { mode: 'name', midi: 65, pc: 5 }

  it('accepts any listed key for a find question', () => {
    expect(checkAnswer(find, { kind: 'key', midi: 64 })).toBe(true)
    expect(checkAnswer(find, { kind: 'key', midi: 76 })).toBe(true)
  })

  it('rejects a key that is not a match', () => {
    expect(checkAnswer(find, { kind: 'key', midi: 65 })).toBe(false)
  })

  it('grades a name question by pitch class', () => {
    expect(checkAnswer(name, { kind: 'pc', pc: 5 })).toBe(true)
    expect(checkAnswer(name, { kind: 'pc', pc: 6 })).toBe(false)
  })

  it('is incorrect when the answer kind does not match the question mode', () => {
    expect(checkAnswer(find, { kind: 'pc', pc: 4 })).toBe(false)
    expect(checkAnswer(name, { kind: 'key', midi: 65 })).toBe(false)
  })
})

describe('possibleQuestions', () => {
  it('name mode yields one question per midi key in range', () => {
    const from = nameToMidi('C4')
    const to = nameToMidi('D4')
    const qs = possibleQuestions(ctx({ mode: 'name', fromMidi: from, toMidi: to }))
    expect(qs).toHaveLength(3) // C4, C#4, D4
    expect(qs.every((q) => q.mode === 'name')).toBe(true)
    expect((qs as NameQuestion[]).map((q) => q.midi)).toEqual([from, from + 1, from + 2])
  })

  it('find mode groups all matching keys of a pitch class into one question', () => {
    const from = nameToMidi('C3')
    const to = nameToMidi('C5')
    const qs = possibleQuestions(ctx({ mode: 'find', fromMidi: from, toMidi: to })) as FindQuestion[]
    // Two full octaves plus the closing C: all 12 pitch classes appear, C twice.
    expect(qs).toHaveLength(12)
    const cQuestion = qs.find((q) => q.pc === 0)
    expect(cQuestion?.answerMidis).toEqual([from, from + 12, from + 24])
  })

  it('every generated answer midi genuinely matches its pitch class', () => {
    const qs = possibleQuestions(ctx({ mode: 'find' })) as FindQuestion[]
    for (const q of qs) {
      for (const midi of q.answerMidis) {
        expect(midiToPc(midi)).toBe(q.pc)
      }
    }
  })

  it('handles a reversed range by normalizing from/to', () => {
    const from = nameToMidi('C4')
    const to = nameToMidi('D4')
    const qs = possibleQuestions(ctx({ mode: 'name', fromMidi: to, toMidi: from }))
    expect(qs).toHaveLength(3)
  })
})

describe('generateQuestion', () => {
  it('is deterministic for a given rng', () => {
    const c = ctx({ mode: 'name', fromMidi: nameToMidi('C4'), toMidi: nameToMidi('D4') })
    const a = generateQuestion(c, null, seq(0))
    const b = generateQuestion(c, null, seq(0))
    expect(a).toEqual(b)
  })

  it('avoids an immediate repeat of the previous question', () => {
    const c = ctx({ mode: 'name', fromMidi: nameToMidi('C4'), toMidi: nameToMidi('D4') })
    const first = generateQuestion(c, null, seq(0)) // index 0
    const second = generateQuestion(c, first, seq(0))
    expect(second).not.toEqual(first)
  })

  it('avoids repeats by target even when key lists differ (find mode)', () => {
    const c = ctx({ mode: 'find', fromMidi: nameToMidi('C3'), toMidi: nameToMidi('C5') })
    const prev: TrainerQuestion = { mode: 'find', pc: 0, answerMidis: [48, 60, 72] }
    const next = generateQuestion(c, prev, seq(0)) as FindQuestion
    expect(next.pc === prev.pc).toBe(false)
  })

  it('generates a single-key question for a one-note range', () => {
    const c4 = nameToMidi('C4')
    const c = ctx({ mode: 'name', fromMidi: c4, toMidi: c4 })
    const q = generateQuestion(c, null, seq(0)) as NameQuestion
    expect(q.midi).toBe(c4)
  })
})

describe('normalizeTrainerSettings', () => {
  it('returns defaults for junk', () => {
    expect(normalizeTrainerSettings(null)).toEqual(DEFAULT_KEYBOARD_TRAINER_SETTINGS)
    expect(normalizeTrainerSettings('nope')).toEqual(DEFAULT_KEYBOARD_TRAINER_SETTINGS)
  })

  it('clamps octaves into [MIN_OCTAVE, MAX_OCTAVE] and keeps to >= from', () => {
    const s = normalizeTrainerSettings({ fromOctave: -3, toOctave: 99 })
    expect(s.fromOctave).toBe(0)
    expect(s.toOctave).toBe(MAX_OCTAVE)
    const flipped = normalizeTrainerSettings({ fromOctave: 6, toOctave: 4 })
    expect(flipped.fromOctave).toBe(6)
    expect(flipped.toOctave).toBe(6)
  })

  it('validates mode and accidentals', () => {
    expect(normalizeTrainerSettings({ mode: 'name' }).mode).toBe('name')
    expect(normalizeTrainerSettings({ mode: 'bogus' }).mode).toBe('find')
    expect(normalizeTrainerSettings({ accidentals: 'flat' }).accidentals).toBe('flat')
    expect(normalizeTrainerSettings({ accidentals: 'x' }).accidentals).toBe('sharp')
  })
})

describe('keyboard trainer settings store', () => {
  it('defaults when empty', () => {
    const store = createKeyboardTrainerSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_KEYBOARD_TRAINER_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const written = { ...DEFAULT_KEYBOARD_TRAINER_SETTINGS, mode: 'name' as const, toOctave: 4 }
    createKeyboardTrainerSettingsStore(backend).set(written)
    expect(createKeyboardTrainerSettingsStore(backend).get()).toEqual(written)
  })
})
