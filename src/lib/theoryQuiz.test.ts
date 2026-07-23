import { describe, expect, it } from 'vitest'
import {
  checkAnswer,
  createTheoryQuizSettingsStore,
  DEFAULT_THEORY_QUIZ_SETTINGS,
  enabledCategories,
  generateQuestion,
  normalizeTheoryQuizSettings,
  QUIZ_CATEGORIES,
  srsKeyForInterval,
  type QuizCategory,
  type TheoryQuizQuestion,
} from './theoryQuiz.ts'
import { memoryBackend } from './storage.ts'
import { STEP_MS, type SrsData, type SrsItem } from './spacedRepetition.ts'
import type { Rng } from './quiz.ts'

const ALL_CATEGORIES: QuizCategory[] = QUIZ_CATEGORIES.map((c) => c.id)

/** Deterministic rng cycling through a fixed sequence of values in [0, 1). */
function seq(...values: number[]): Rng {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

/** A simple seeded PRNG (mulberry32) for property-style tests over many draws. */
function mulberry32(seed: number): Rng {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function assertWellFormed(q: TheoryQuizQuestion) {
  expect(q.options).toHaveLength(4)
  expect(new Set(q.options).size).toBe(4)
  expect(q.options).toContain(q.answer)
  expect(q.prompt.length).toBeGreaterThan(0)
}

describe('generateQuestion — general shape', () => {
  it('throws when no categories are enabled', () => {
    expect(() => generateQuestion([], null, seq(0))).toThrow()
  })

  it('is deterministic for a given rng', () => {
    const a = generateQuestion(ALL_CATEGORIES, null, seq(0.1, 0.2, 0.3, 0.4, 0.5))
    const b = generateQuestion(ALL_CATEGORIES, null, seq(0.1, 0.2, 0.3, 0.4, 0.5))
    expect(a).toEqual(b)
  })

  it('restricts generation to the enabled categories', () => {
    const rng = mulberry32(42)
    for (let i = 0; i < 100; i++) {
      const q = generateQuestion(['interval'], null, rng)
      expect(q.category).toBe('interval')
    }
  })

  it('avoids an immediate repeat of the previous question when possible', () => {
    const rng = mulberry32(7)
    let prev: TheoryQuizQuestion | null = null
    for (let i = 0; i < 200; i++) {
      const next = generateQuestion(ALL_CATEGORIES, prev, rng)
      if (prev) expect(next.prompt).not.toBe(prev.prompt)
      prev = next
    }
  })

  it('every generated question (across many seeds/categories) is well-formed', () => {
    for (const categories of [
      ['keySignature'],
      ['diatonicChord'],
      ['interval'],
      ALL_CATEGORIES,
    ] as QuizCategory[][]) {
      const rng = mulberry32(categories.join('').length + 1)
      for (let i = 0; i < 150; i++) {
        const q = generateQuestion(categories, null, rng)
        assertWellFormed(q)
        expect(categories).toContain(q.category)
      }
    }
  })

  it('checkAnswer grades by exact string match against the answer', () => {
    const q = generateQuestion(ALL_CATEGORIES, null, mulberry32(1))
    expect(checkAnswer(q, q.answer)).toBe(true)
    expect(checkAnswer(q, `${q.answer} nope`)).toBe(false)
  })
})

describe('key signature questions', () => {
  it('produces a plausible count question with sharps/flats phrasing', () => {
    const rng = mulberry32(2)
    let found: TheoryQuizQuestion | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const q = generateQuestion(['keySignature'], null, rng)
      if (q.kind === 'count') found = q
    }
    expect(found).toBeDefined()
    expect(found!.prompt).toMatch(/How many sharps or flats does .+ have\?/)
    expect(found!.answer).toMatch(/^(No sharps or flats|\d+ (sharp|flat)s?)$/)
  })

  it('produces a plausible reverse (name-the-key) question', () => {
    const rng = mulberry32(3)
    let found: TheoryQuizQuestion | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const q = generateQuestion(['keySignature'], null, rng)
      if (q.kind === 'name') found = q
    }
    expect(found).toBeDefined()
    expect(found!.prompt).toMatch(/^Which (major|minor) key has /)
  })

  it('covers major and minor variants over many draws', () => {
    const rng = mulberry32(4)
    let sawMajor = false
    let sawMinor = false
    for (let i = 0; i < 200; i++) {
      const q = generateQuestion(['keySignature'], null, rng)
      if (/major/.test(q.prompt)) sawMajor = true
      if (/minor/.test(q.prompt)) sawMinor = true
    }
    expect(sawMajor).toBe(true)
    expect(sawMinor).toBe(true)
  })

  it('never offers a distractor equal to the answer, over many draws', () => {
    const rng = mulberry32(5)
    for (let i = 0; i < 300; i++) {
      const q = generateQuestion(['keySignature'], null, rng)
      const distractors = q.options.filter((o) => o !== q.answer)
      expect(distractors).toHaveLength(3)
      expect(new Set(distractors).size).toBe(3)
    }
  })
})

describe('diatonic chord questions', () => {
  it('asks for the chord of a scale degree with a chord-symbol answer', () => {
    const rng = mulberry32(6)
    let found: TheoryQuizQuestion | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const q = generateQuestion(['diatonicChord'], null, rng)
      if (q.kind === 'chordOfDegree') found = q
    }
    expect(found).toBeDefined()
    expect(found!.prompt).toMatch(/^What is the .+ chord in .+ major\?$/)
  })

  it('asks for the roman-numeral degree of a chord symbol', () => {
    const rng = mulberry32(8)
    let found: TheoryQuizQuestion | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const q = generateQuestion(['diatonicChord'], null, rng)
      if (q.kind === 'degreeOfChord') found = q
    }
    expect(found).toBeDefined()
    expect(found!.prompt).toMatch(/^What scale degree is .+ in .+ major\?$/)
    // The seven diatonic-triad numerals of a major key.
    expect(found!.answer).toMatch(/^(I|ii|iii|IV|V|vi|vii°)$/)
  })

  it('the V chord of C major is G, and vii° of C major is Bdim', () => {
    // Call order per generateQuestion -> generateDiatonicChordQuestion:
    // 1) category pick (single-element array, value irrelevant)
    // 2) key index: randomIndex(12, rng) -> 0 selects CIRCLE_KEYS[0] (C major)
    // 3) degree index: randomIndex(7, rng) -> 4 selects the V triad (0-based)
    // 4) askForChord: rng() < 0.5 -> true
    const rngForV = seq(0, 0, 4 / 7 + 0.01, 0.1)
    const vQuestion = generateQuestion(['diatonicChord'], null, rngForV)
    expect(vQuestion.kind).toBe('chordOfDegree')
    expect(vQuestion.prompt).toBe('What is the V chord in C major?')
    expect(vQuestion.answer).toBe('G')

    // Same shape, degree index 6 -> vii° triad.
    const rngForVii = seq(0, 0, 6 / 7 + 0.01, 0.1)
    const viiQuestion = generateQuestion(['diatonicChord'], null, rngForVii)
    expect(viiQuestion.kind).toBe('chordOfDegree')
    expect(viiQuestion.prompt).toBe('What is the vii° chord in C major?')
    expect(viiQuestion.answer).toBe('Bdim')
  })

  it('the ii chord of C major (Dm) is scale degree ii', () => {
    // Same call order, but askForChord >= 0.5 -> false (ask for the degree instead).
    const rng = seq(0, 0, 1 / 7 + 0.01, 0.9)
    const q = generateQuestion(['diatonicChord'], null, rng)
    expect(q.kind).toBe('degreeOfChord')
    expect(q.prompt).toBe('What scale degree is Dm in C major?')
    expect(q.answer).toBe('ii')
  })

  it('never offers a duplicate distractor (chord symbols and numerals are all distinct per key)', () => {
    const rng = mulberry32(9)
    for (let i = 0; i < 300; i++) {
      const q = generateQuestion(['diatonicChord'], null, rng)
      expect(new Set(q.options).size).toBe(4)
    }
  })
})

describe('interval questions', () => {
  it('asks how many semitones a named interval is', () => {
    const rng = mulberry32(10)
    let found: TheoryQuizQuestion | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const q = generateQuestion(['interval'], null, rng)
      if (q.kind === 'semitones') found = q
    }
    expect(found).toBeDefined()
    expect(found!.prompt).toMatch(/^How many semitones is a /)
    expect(Number(found!.answer)).toBeGreaterThanOrEqual(0)
    expect(Number(found!.answer)).toBeLessThanOrEqual(12)
  })

  it('a perfect fifth is 7 semitones', () => {
    // Call order: 1) category pick, 2) askSemitones = rng()<0.5 -> true,
    // 3) INTERVALS index via randomIndex(13, rng); P5 is INTERVALS[7].
    const rng = seq(0, 0, 7 / 13 + 0.01)
    const q = generateQuestion(['interval'], null, rng)
    expect(q.kind).toBe('semitones')
    expect(q.prompt).toBe('How many semitones is a P5 (Perfect Fifth)?')
    expect(q.answer).toBe('7')
  })

  it('names the interval between two spelled notes (note-to-note)', () => {
    const rng = mulberry32(11)
    let found: TheoryQuizQuestion | undefined
    for (let i = 0; i < 50 && !found; i++) {
      const q = generateQuestion(['interval'], null, rng)
      if (q.kind === 'noteToNote') found = q
    }
    expect(found).toBeDefined()
    expect(found!.prompt).toMatch(/^What interval is [A-G] to [A-G][#b]?\?$/)
  })

  it('C to Ab is a minor sixth', () => {
    // Call order: 1) category pick, 2) askSemitones = rng()<0.5 -> false,
    // 3) rootLetter: randomIndex(7, rng) -> 0 selects 'C',
    // 4) distance = 1 + randomIndex(11, rng); want 8 (m6) -> randomIndex returns 7,
    // 5) prefer: rng()<0.5 ? sharp : flat -> want flat, so >= 0.5.
    const rng = seq(0, 0.9, 0, 7 / 11 + 0.01, 0.9)
    const q = generateQuestion(['interval'], null, rng)
    expect(q.kind).toBe('noteToNote')
    expect(q.prompt).toBe('What interval is C to Ab?')
    expect(q.answer).toBe('m6 (Minor Sixth)')
  })

  it('never offers a duplicate distractor', () => {
    const rng = mulberry32(12)
    for (let i = 0; i < 300; i++) {
      const q = generateQuestion(['interval'], null, rng)
      expect(new Set(q.options).size).toBe(4)
    }
  })
})

describe('srsKey stamping', () => {
  it('stamps every generated question with a stable, category-appropriate key', () => {
    const cases: { category: QuizCategory; prefix: string }[] = [
      { category: 'keySignature', prefix: 'keysig:' },
      { category: 'diatonicChord', prefix: 'diatonic:' },
      { category: 'interval', prefix: 'interval:' },
    ]
    for (const { category, prefix } of cases) {
      const rng = mulberry32(prefix.length + 3)
      for (let i = 0; i < 60; i++) {
        const q = generateQuestion([category], null, rng)
        expect(q.srsKey.startsWith(prefix)).toBe(true)
        expect(q.srsKey.length).toBeGreaterThan(prefix.length)
      }
    }
  })

  it('gives both directions of the same interval fact the same key', () => {
    // Over many draws every P5 question (either direction) keys to interval:7.
    const rng = mulberry32(21)
    let sawSemitones = false
    let sawNoteToNote = false
    for (let i = 0; i < 400; i++) {
      const q = generateQuestion(['interval'], null, rng)
      if (q.srsKey !== srsKeyForInterval(7)) continue
      if (q.kind === 'semitones') sawSemitones = true
      if (q.kind === 'noteToNote') sawNoteToNote = true
    }
    expect(sawSemitones).toBe(true)
    expect(sawNoteToNote).toBe(true)
  })
})

describe('generateQuestion — SRS-blended picking', () => {
  const NOW = 5_000_000

  function lcg(seed: number): Rng {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  function srsItem(due: number): SrsItem {
    return { interval: 1, ease: 2.5, due, lapses: 0, reps: 1, lastSeen: due }
  }

  /** How often each interval fact key is drawn over `n` runs. */
  function keyCounts(srs: SrsData, n: number): Map<string, number> {
    const rng = lcg(2024)
    const counts = new Map<string, number>()
    for (let i = 0; i < n; i++) {
      const q = generateQuestion(['interval'], null, rng, { srs, now: NOW })
      counts.set(q.srsKey, (counts.get(q.srsKey) ?? 0) + 1)
    }
    return counts
  }

  it('is deterministic for a given rng', () => {
    const srs: SrsData = { [srsKeyForInterval(7)]: srsItem(NOW - 3 * STEP_MS) }
    const a = generateQuestion(['interval'], null, lcg(5), { srs, now: NOW })
    const b = generateQuestion(['interval'], null, lcg(5), { srs, now: NOW })
    expect(a).toEqual(b)
  })

  it('biases toward the one overdue fact when all others are not due', () => {
    const srs: SrsData = {}
    for (let s = 0; s <= 12; s++) srs[srsKeyForInterval(s)] = srsItem(NOW + 100 * STEP_MS)
    srs[srsKeyForInterval(7)] = srsItem(NOW - 5 * STEP_MS) // very overdue
    const counts = keyCounts(srs, 4000)
    const p5 = counts.get(srsKeyForInterval(7)) ?? 0
    const others = 4000 - p5
    expect(p5).toBeGreaterThan(others)
  })

  it('prioritises a never-seen fact over reviewed, not-due ones', () => {
    const srs: SrsData = {}
    for (let s = 0; s <= 12; s++) srs[srsKeyForInterval(s)] = srsItem(NOW + 100 * STEP_MS)
    delete srs[srsKeyForInterval(3)] // m3 is now "new"
    const counts = keyCounts(srs, 4000)
    const m3 = counts.get(srsKeyForInterval(3)) ?? 0
    const others = 4000 - m3
    expect(m3).toBeGreaterThan(others)
  })

  it('produces well-formed questions under SRS picking', () => {
    const srs: SrsData = { [srsKeyForInterval(0)]: srsItem(NOW - 2 * STEP_MS) }
    const rng = lcg(88)
    for (let i = 0; i < 150; i++) {
      const q = generateQuestion(ALL_CATEGORIES, null, rng, { srs, now: NOW })
      assertWellFormed(q)
      expect(ALL_CATEGORIES).toContain(q.category)
    }
  })
})

describe('normalizeTheoryQuizSettings', () => {
  it('defaults all categories on for junk input', () => {
    expect(normalizeTheoryQuizSettings(null)).toEqual(DEFAULT_THEORY_QUIZ_SETTINGS)
    expect(normalizeTheoryQuizSettings('nope')).toEqual(DEFAULT_THEORY_QUIZ_SETTINGS)
    expect(normalizeTheoryQuizSettings(undefined)).toEqual(DEFAULT_THEORY_QUIZ_SETTINGS)
  })

  it('respects explicit false values', () => {
    const s = normalizeTheoryQuizSettings({ categories: { interval: false } })
    expect(s.categories.interval).toBe(false)
    expect(s.categories.keySignature).toBe(true)
    expect(s.categories.diatonicChord).toBe(true)
  })

  it('falls back to defaults if every category would be disabled', () => {
    const s = normalizeTheoryQuizSettings({
      categories: { keySignature: false, diatonicChord: false, interval: false },
    })
    expect(s).toEqual(DEFAULT_THEORY_QUIZ_SETTINGS)
  })

  it('ignores unrelated junk inside categories', () => {
    const s = normalizeTheoryQuizSettings({ categories: { bogus: false, interval: 'x' } })
    expect(s.categories).toEqual({ keySignature: true, diatonicChord: true, interval: true })
  })
})

describe('enabledCategories', () => {
  it('returns all categories in QUIZ_CATEGORIES order by default', () => {
    expect(enabledCategories(DEFAULT_THEORY_QUIZ_SETTINGS)).toEqual(ALL_CATEGORIES)
  })

  it('filters out disabled categories', () => {
    const s = normalizeTheoryQuizSettings({ categories: { diatonicChord: false } })
    expect(enabledCategories(s)).toEqual(['keySignature', 'interval'])
  })
})

describe('theory quiz settings store', () => {
  it('defaults when empty', () => {
    const store = createTheoryQuizSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_THEORY_QUIZ_SETTINGS)
  })

  it('round-trips settings across store instances sharing a backend', () => {
    const backend = memoryBackend()
    const written = { categories: { keySignature: true, diatonicChord: false, interval: true } }
    createTheoryQuizSettingsStore(backend).set(written)
    expect(createTheoryQuizSettingsStore(backend).get()).toEqual(written)
  })

  it('migrates unversioned/old data by normalizing it', () => {
    const backend = memoryBackend()
    backend.setItem(
      'mt:settings:theory-quiz',
      JSON.stringify({ v: 0, data: { categories: { keySignature: false } } }),
    )
    const migrated = createTheoryQuizSettingsStore(backend).get()
    expect(migrated.categories.keySignature).toBe(false)
    expect(migrated.categories.diatonicChord).toBe(true)
  })
})
