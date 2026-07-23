import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import { getTuning } from './theory/instruments.ts'
import { nameToMidi } from './theory/notes.ts'
import {
  checkFretboardAnswer,
  checkKeyboardAnswer,
  checkNameAnswer,
  checkNoteReadingAnswer,
  CLEF_RANGE,
  CLEF_STAFF_RANGE,
  createNoteReadingSettingsStore,
  CUSTOM_RANGE_MAX,
  CUSTOM_RANGE_MIN,
  DEFAULT_CUSTOM_RANGE,
  DEFAULT_NOTE_READING_SETTINGS,
  generateNoteReadingQuestion,
  isCountdownOver,
  normalizeNoteReadingSettings,
  pitchOnBoard,
  RANGE_NOTE_OPTIONS,
  randomNote,
  remainingMs,
  remainingSeconds,
  resolveQuestionClef,
  resolveRange,
  srsKeyForNote,
  startCountdown,
  summarizeTimedResults,
  updateCustomRange,
  type CustomRange,
  type GenerateContext,
  type NoteReadingQuestion,
} from './noteReading.ts'
import { STEP_MS, type SrsData, type SrsItem } from './spacedRepetition.ts'
import type { Rng } from './quiz.ts'

describe('randomNote', () => {
  it('stays within the given range', () => {
    for (let r = 0; r <= 1; r += 0.05) {
      const bass = randomNote(CLEF_RANGE.bass, () => r)
      expect(bass).toBeGreaterThanOrEqual(CLEF_RANGE.bass.low)
      expect(bass).toBeLessThanOrEqual(CLEF_RANGE.bass.high)
      const treble = randomNote(CLEF_RANGE.treble, () => r)
      expect(treble).toBeGreaterThanOrEqual(CLEF_RANGE.treble.low)
      expect(treble).toBeLessThanOrEqual(CLEF_RANGE.treble.high)
    }
  })

  it('maps rng 0 to the low bound and near-1 to the high bound', () => {
    expect(randomNote(CLEF_RANGE.bass, () => 0)).toBe(CLEF_RANGE.bass.low)
    expect(randomNote(CLEF_RANGE.bass, () => 0.999999)).toBe(CLEF_RANGE.bass.high)
  })

  it('avoids repeating the previous note when possible', () => {
    // rng cycles so the first pick equals `avoid`, forcing a re-roll.
    const values = [0, 0.5]
    let i = 0
    const rng = (): number => values[i++ % values.length]!
    const first = randomNote(CLEF_RANGE.bass, () => 0) // low bound
    const next = randomNote(CLEF_RANGE.bass, rng, first)
    expect(next).not.toBe(first)
  })
})

describe('resolveRange', () => {
  const custom: CustomRange = { bass: { low: 30, high: 40 }, treble: { low: 60, high: 70 } }

  it('resolves the staff-only preset to the staff bounds', () => {
    expect(resolveRange('bass', 'staff', custom)).toEqual(CLEF_STAFF_RANGE.bass)
    expect(resolveRange('treble', 'staff', custom)).toEqual(CLEF_STAFF_RANGE.treble)
  })

  it('resolves the ledger preset to the (default) staff+ledger range', () => {
    expect(resolveRange('bass', 'ledger', custom)).toEqual(CLEF_RANGE.bass)
  })

  it('resolves custom to the per-clef custom range', () => {
    expect(resolveRange('bass', 'custom', custom)).toEqual({ low: 30, high: 40 })
    expect(resolveRange('treble', 'custom', custom)).toEqual({ low: 60, high: 70 })
  })

  it('staff-only is narrower than staff+ledger for both clefs', () => {
    for (const clef of ['bass', 'treble'] as const) {
      const staff = CLEF_STAFF_RANGE[clef]
      const ledger = CLEF_RANGE[clef]
      expect(staff.low).toBeGreaterThanOrEqual(ledger.low)
      expect(staff.high).toBeLessThanOrEqual(ledger.high)
    }
  })
})

describe('resolveQuestionClef', () => {
  it('returns the fixed clef unchanged', () => {
    expect(resolveQuestionClef('bass', () => 0.9)).toBe('bass')
    expect(resolveQuestionClef('treble', () => 0.1)).toBe('treble')
  })

  it('splits "both" by rng at 0.5', () => {
    expect(resolveQuestionClef('both', () => 0)).toBe('bass')
    expect(resolveQuestionClef('both', () => 0.4999)).toBe('bass')
    expect(resolveQuestionClef('both', () => 0.5)).toBe('treble')
    expect(resolveQuestionClef('both', () => 0.9999)).toBe('treble')
  })
})

describe('generateNoteReadingQuestion', () => {
  const ctx = { clefSetting: 'both' as const, rangePreset: 'ledger' as const, customRange: DEFAULT_CUSTOM_RANGE }

  it('produces a question within the resolved clef range', () => {
    const q = generateNoteReadingQuestion(ctx, null, () => 0.2)
    expect(q.clef).toBe('bass') // rng < 0.5 picks bass
    expect(q.midi).toBeGreaterThanOrEqual(CLEF_RANGE.bass.low)
    expect(q.midi).toBeLessThanOrEqual(CLEF_RANGE.bass.high)
  })

  it('avoids repeating the same note when the clef repeats', () => {
    const values = [0.2, 0, 0.2, 0.5]
    let i = 0
    const rng = (): number => values[i++ % values.length]!
    const first = generateNoteReadingQuestion(ctx, null, rng) // clef bass, low note
    const second = generateNoteReadingQuestion(ctx, first, rng)
    expect(second).not.toEqual(first)
  })

  it('does not force avoidance across a clef change', () => {
    // First question bass low note; rng then picks treble (>=0.5) at its low bound.
    const first: NoteReadingQuestion = { clef: 'bass', midi: CLEF_RANGE.bass.low }
    const values = [0.9, 0] // clef -> treble, then low bound of treble range
    let i = 0
    const rng = (): number => values[i++ % values.length]!
    const second = generateNoteReadingQuestion(ctx, first, rng)
    expect(second).toEqual({ clef: 'treble', midi: CLEF_RANGE.treble.low })
  })
})

describe('srsKeyForNote', () => {
  it('distinguishes the same pitch across clefs', () => {
    expect(srsKeyForNote('bass', 48)).toBe('bass:48')
    expect(srsKeyForNote('treble', 48)).toBe('treble:48')
    expect(srsKeyForNote('bass', 48)).not.toBe(srsKeyForNote('treble', 48))
  })
})

describe('generateNoteReadingQuestion — SRS-blended picking', () => {
  const NOW = 5_000_000

  /** A seeded LCG for distribution tests — deterministic but well-spread. */
  function lcg(seed: number): Rng {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
  }

  /** A reviewed SRS item due at `due`. */
  function srsItem(due: number): SrsItem {
    return { interval: 1, ease: 2.5, due, lapses: 0, reps: 1, lastSeen: due }
  }

  // A fixed bass clef with a two-note custom range, so the pick is purely a
  // per-note weighting decision between `LOW` and `HIGH`.
  const LOW = 48
  const HIGH = 49
  const ctx: GenerateContext = {
    clefSetting: 'bass',
    rangePreset: 'custom',
    customRange: { bass: { low: LOW, high: HIGH }, treble: { low: 60, high: 61 } },
  }

  function midiCounts(srs: SrsData, n: number): Map<number, number> {
    const rng = lcg(999)
    const counts = new Map<number, number>()
    for (let i = 0; i < n; i++) {
      const q = generateNoteReadingQuestion(ctx, null, rng, { srs, now: NOW })
      expect(q.clef).toBe('bass')
      counts.set(q.midi, (counts.get(q.midi) ?? 0) + 1)
    }
    return counts
  }

  it('biases toward the overdue note over a not-yet-due one', () => {
    const srs: SrsData = {
      [srsKeyForNote('bass', LOW)]: srsItem(NOW - 5 * STEP_MS), // very overdue
      [srsKeyForNote('bass', HIGH)]: srsItem(NOW + 100 * STEP_MS), // not due for ages
    }
    const counts = midiCounts(srs, 4000)
    expect(counts.get(LOW) ?? 0).toBeGreaterThan((counts.get(HIGH) ?? 0) * 3)
  })

  it('prioritises a never-seen note over a recently-reviewed, not-due one', () => {
    // HIGH reviewed and not due; LOW is new (no entry).
    const srs: SrsData = { [srsKeyForNote('bass', HIGH)]: srsItem(NOW + 100 * STEP_MS) }
    const counts = midiCounts(srs, 4000)
    expect(counts.get(LOW) ?? 0).toBeGreaterThan((counts.get(HIGH) ?? 0) * 3)
  })

  it('still draws both notes with empty srs (uniform-ish)', () => {
    const counts = midiCounts({}, 2000)
    expect(counts.get(LOW) ?? 0).toBeGreaterThan(0)
    expect(counts.get(HIGH) ?? 0).toBeGreaterThan(0)
  })

  it('keys the schedule by clef, so a treble draw ignores bass entries', () => {
    // Both bass entries overdue, but a treble question keys off treble:* which
    // are all new — so the pick can never collapse onto a bass key.
    const trebleCtx: GenerateContext = { ...ctx, clefSetting: 'treble' }
    const srs: SrsData = {
      [srsKeyForNote('bass', LOW)]: srsItem(NOW - 100 * STEP_MS),
      [srsKeyForNote('bass', HIGH)]: srsItem(NOW - 100 * STEP_MS),
    }
    const rng = lcg(7)
    for (let i = 0; i < 100; i++) {
      const q = generateNoteReadingQuestion(trebleCtx, null, rng, { srs, now: NOW })
      expect(q.clef).toBe('treble')
      expect([60, 61]).toContain(q.midi)
    }
  })
})

describe('checkNameAnswer', () => {
  it('matches by pitch class regardless of octave', () => {
    expect(checkNameAnswer(0, nameToMidi('C4'))).toBe(true)
    expect(checkNameAnswer(0, nameToMidi('C2'))).toBe(true)
    expect(checkNameAnswer(2, nameToMidi('C4'))).toBe(false)
  })
})

describe('checkKeyboardAnswer', () => {
  it('requires the exact midi pitch', () => {
    expect(checkKeyboardAnswer(nameToMidi('C4'), nameToMidi('C4'))).toBe(true)
    expect(checkKeyboardAnswer(nameToMidi('C3'), nameToMidi('C4'))).toBe(false)
  })
})

describe('pitchOnBoard', () => {
  const bass4 = getTuning('bass-4') // E1 A1 D2 G2

  it('finds a pitch reachable within the fret range', () => {
    // C2 = E1 + 8 semitones → fret 8 on the low string.
    expect(pitchOnBoard(bass4, nameToMidi('C2'), 0, 12)).toBe(true)
  })

  it('reports pitches below the lowest string as unreachable', () => {
    expect(pitchOnBoard(bass4, nameToMidi('C1'), 0, 12)).toBe(false)
  })

  it('reports pitches above the highest fret as unreachable', () => {
    // G3 needs fret 12 on the G2 string; a 0–4 range cannot reach it.
    expect(pitchOnBoard(bass4, nameToMidi('G3'), 0, 4)).toBe(false)
    expect(pitchOnBoard(bass4, nameToMidi('G3'), 0, 12)).toBe(true)
  })
})

describe('checkFretboardAnswer', () => {
  const bass4 = getTuning('bass-4')

  it('accepts the exact pitch', () => {
    const c2 = nameToMidi('C2')
    expect(checkFretboardAnswer(bass4, c2, c2, 0, 12)).toBe(true)
  })

  it('rejects a wrong octave when the exact pitch is reachable', () => {
    // C2 and C3 are both on the board, so the exact octave is required.
    expect(checkFretboardAnswer(bass4, nameToMidi('C3'), nameToMidi('C2'), 0, 12)).toBe(false)
  })

  it('rejects a wrong pitch class outright', () => {
    expect(checkFretboardAnswer(bass4, nameToMidi('D2'), nameToMidi('C2'), 0, 12)).toBe(false)
  })

  it('falls back to pitch-class match when the target octave is unreachable', () => {
    // C6 is far above a 4-string bass; any C on the board counts.
    const c6 = nameToMidi('C6')
    expect(pitchOnBoard(bass4, c6, 0, 12)).toBe(false)
    expect(checkFretboardAnswer(bass4, nameToMidi('C2'), c6, 0, 12)).toBe(true)
    expect(checkFretboardAnswer(bass4, nameToMidi('D2'), c6, 0, 12)).toBe(false)
  })
})

describe('checkNoteReadingAnswer', () => {
  const bass4 = getTuning('bass-4')
  const ctx = { tuning: bass4, fromFret: 0, toFret: 12 }
  const question: NoteReadingQuestion = { midi: nameToMidi('C2'), clef: 'bass' }

  it('grades a name answer by pitch class', () => {
    expect(checkNoteReadingAnswer(question, { kind: 'name', pc: 0 }, ctx)).toBe(true)
    expect(checkNoteReadingAnswer(question, { kind: 'name', pc: 2 }, ctx)).toBe(false)
  })

  it('grades a keyboard answer by exact pitch', () => {
    expect(checkNoteReadingAnswer(question, { kind: 'keyboard', midi: nameToMidi('C2') }, ctx)).toBe(true)
    expect(checkNoteReadingAnswer(question, { kind: 'keyboard', midi: nameToMidi('C3') }, ctx)).toBe(false)
  })

  it('grades a fretboard answer using checkFretboardAnswer', () => {
    expect(checkNoteReadingAnswer(question, { kind: 'fretboard', midi: nameToMidi('C2') }, ctx)).toBe(true)
    expect(checkNoteReadingAnswer(question, { kind: 'fretboard', midi: nameToMidi('D2') }, ctx)).toBe(false)
  })
})

describe('updateCustomRange', () => {
  it('clamps to the absolute bounds', () => {
    expect(updateCustomRange({ low: 40, high: 50 }, 'low', CUSTOM_RANGE_MIN - 12)).toEqual({
      low: CUSTOM_RANGE_MIN,
      high: 50,
    })
    expect(updateCustomRange({ low: 40, high: 50 }, 'high', CUSTOM_RANGE_MAX + 12)).toEqual({
      low: 40,
      high: CUSTOM_RANGE_MAX,
    })
  })

  it('pushes the other bound to keep low <= high', () => {
    expect(updateCustomRange({ low: 40, high: 50 }, 'low', 55)).toEqual({ low: 55, high: 55 })
    expect(updateCustomRange({ low: 40, high: 50 }, 'high', 30)).toEqual({ low: 30, high: 30 })
  })

  it('leaves the range alone for a no-op edit', () => {
    expect(updateCustomRange({ low: 40, high: 50 }, 'low', 40)).toEqual({ low: 40, high: 50 })
  })
})

describe('RANGE_NOTE_OPTIONS', () => {
  it('spans the custom-range bounds inclusive, ascending', () => {
    expect(RANGE_NOTE_OPTIONS[0]).toEqual({ midi: CUSTOM_RANGE_MIN, label: expect.any(String) })
    expect(RANGE_NOTE_OPTIONS[RANGE_NOTE_OPTIONS.length - 1]).toEqual({
      midi: CUSTOM_RANGE_MAX,
      label: expect.any(String),
    })
    expect(RANGE_NOTE_OPTIONS.length).toBe(CUSTOM_RANGE_MAX - CUSTOM_RANGE_MIN + 1)
  })
})

describe('countdown', () => {
  it('reports the full duration at the start', () => {
    const cd = startCountdown(1000, 30)
    expect(remainingMs(cd, 1000)).toBe(30_000)
    expect(remainingSeconds(cd, 1000)).toBe(30)
    expect(isCountdownOver(cd, 1000)).toBe(false)
  })

  it('counts down as the mock clock advances', () => {
    const cd = startCountdown(0, 60)
    expect(remainingMs(cd, 45_000)).toBe(15_000)
    expect(remainingSeconds(cd, 45_000)).toBe(15)
    expect(isCountdownOver(cd, 45_000)).toBe(false)
  })

  it('rounds partial seconds up so it never shows 0 early', () => {
    const cd = startCountdown(0, 30)
    expect(remainingSeconds(cd, 29_100)).toBe(1)
  })

  it('floors at zero and reports over once elapsed', () => {
    const cd = startCountdown(0, 30)
    expect(remainingMs(cd, 45_000)).toBe(0)
    expect(remainingSeconds(cd, 45_000)).toBe(0)
    expect(isCountdownOver(cd, 30_000)).toBe(true)
    expect(isCountdownOver(cd, 45_000)).toBe(true)
  })
})

describe('summarizeTimedResults', () => {
  it('computes accuracy from correct/answered', () => {
    expect(summarizeTimedResults({ correct: 7, answered: 10, bestStreak: 4 })).toEqual({
      correct: 7,
      answered: 10,
      accuracy: 0.7,
      bestStreak: 4,
    })
  })

  it('reports zero accuracy when nothing was answered', () => {
    expect(summarizeTimedResults({ correct: 0, answered: 0, bestStreak: 0 })).toEqual({
      correct: 0,
      answered: 0,
      accuracy: 0,
      bestStreak: 0,
    })
  })
})

describe('normalizeNoteReadingSettings', () => {
  it('returns defaults for junk', () => {
    expect(normalizeNoteReadingSettings(null)).toEqual(DEFAULT_NOTE_READING_SETTINGS)
    expect(normalizeNoteReadingSettings({ clef: 'x', inputMode: 9 })).toEqual(
      DEFAULT_NOTE_READING_SETTINGS,
    )
  })

  it('keeps valid fields, including the new "both" clef setting', () => {
    expect(
      normalizeNoteReadingSettings({
        clef: 'both',
        inputMode: 'keyboard',
        rangePreset: 'staff',
        mode: 'timed',
        timedSeconds: 120,
      }),
    ).toEqual({
      clef: 'both',
      inputMode: 'keyboard',
      rangePreset: 'staff',
      customRange: DEFAULT_CUSTOM_RANGE,
      mode: 'timed',
      timedSeconds: 120,
    })
  })

  it('defaults to bass clef, the ledger preset and practice mode', () => {
    expect(DEFAULT_NOTE_READING_SETTINGS.clef).toBe('bass')
    expect(DEFAULT_NOTE_READING_SETTINGS.rangePreset).toBe('ledger')
    expect(DEFAULT_NOTE_READING_SETTINGS.mode).toBe('practice')
  })

  it('rejects an invalid timed duration', () => {
    expect(normalizeNoteReadingSettings({ timedSeconds: 45 }).timedSeconds).toBe(60)
  })

  it('clamps and orders a malformed custom range', () => {
    const settings = normalizeNoteReadingSettings({
      customRange: { bass: { low: 999, high: -999 }, treble: { low: 'nope', high: 70 } },
    })
    expect(settings.customRange.bass.low).toBeLessThanOrEqual(settings.customRange.bass.high)
    expect(settings.customRange.bass.high).toBeLessThanOrEqual(CUSTOM_RANGE_MAX)
    expect(settings.customRange.treble).toEqual({ low: DEFAULT_CUSTOM_RANGE.treble.low, high: 70 })
  })
})

describe('note-reading settings store', () => {
  it('round-trips through a memory backend', () => {
    const store = createNoteReadingSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_NOTE_READING_SETTINGS)
    store.set({ ...DEFAULT_NOTE_READING_SETTINGS, clef: 'treble', inputMode: 'fretboard' })
    expect(store.get()).toEqual({ ...DEFAULT_NOTE_READING_SETTINGS, clef: 'treble', inputMode: 'fretboard' })
  })

  it('migrates v1 data (clef/inputMode only) by filling in the new fields', () => {
    const backend = memoryBackend()
    backend.setItem(
      'mt:settings:note-reading',
      JSON.stringify({ v: 1, data: { clef: 'treble', inputMode: 'keyboard' } }),
    )
    const store = createNoteReadingSettingsStore(backend)
    expect(store.get()).toEqual({
      ...DEFAULT_NOTE_READING_SETTINGS,
      clef: 'treble',
      inputMode: 'keyboard',
    })
    // The migration also persists the upgraded shape at the new version.
    const raw = JSON.parse(backend.getItem('mt:settings:note-reading')!) as { v: number }
    expect(raw.v).toBe(2)
  })
})
