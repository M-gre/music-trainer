import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import { getTuning } from './theory/instruments.ts'
import { nameToMidi } from './theory/notes.ts'
import {
  checkFretboardAnswer,
  checkKeyboardAnswer,
  checkNameAnswer,
  CLEF_RANGE,
  createNoteReadingSettingsStore,
  DEFAULT_NOTE_READING_SETTINGS,
  normalizeNoteReadingSettings,
  pitchOnBoard,
  randomNote,
} from './noteReading.ts'

describe('randomNote', () => {
  it('stays within the clef range', () => {
    for (let r = 0; r <= 1; r += 0.05) {
      const bass = randomNote('bass', () => r)
      expect(bass).toBeGreaterThanOrEqual(CLEF_RANGE.bass.low)
      expect(bass).toBeLessThanOrEqual(CLEF_RANGE.bass.high)
      const treble = randomNote('treble', () => r)
      expect(treble).toBeGreaterThanOrEqual(CLEF_RANGE.treble.low)
      expect(treble).toBeLessThanOrEqual(CLEF_RANGE.treble.high)
    }
  })

  it('maps rng 0 to the low bound and near-1 to the high bound', () => {
    expect(randomNote('bass', () => 0)).toBe(CLEF_RANGE.bass.low)
    expect(randomNote('bass', () => 0.999999)).toBe(CLEF_RANGE.bass.high)
  })

  it('avoids repeating the previous note when possible', () => {
    // rng cycles so the first pick equals `avoid`, forcing a re-roll.
    const values = [0, 0.5]
    let i = 0
    const rng = (): number => values[i++ % values.length]!
    const first = randomNote('bass', () => 0) // low bound
    const next = randomNote('bass', rng, first)
    expect(next).not.toBe(first)
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

describe('normalizeNoteReadingSettings', () => {
  it('returns defaults for junk', () => {
    expect(normalizeNoteReadingSettings(null)).toEqual(DEFAULT_NOTE_READING_SETTINGS)
    expect(normalizeNoteReadingSettings({ clef: 'x', inputMode: 9 })).toEqual(
      DEFAULT_NOTE_READING_SETTINGS,
    )
  })

  it('keeps valid fields', () => {
    expect(normalizeNoteReadingSettings({ clef: 'treble', inputMode: 'keyboard' })).toEqual({
      clef: 'treble',
      inputMode: 'keyboard',
    })
  })

  it('defaults to bass clef for the bassist', () => {
    expect(DEFAULT_NOTE_READING_SETTINGS.clef).toBe('bass')
  })
})

describe('note-reading settings store', () => {
  it('round-trips through a memory backend', () => {
    const store = createNoteReadingSettingsStore(memoryBackend())
    expect(store.get()).toEqual(DEFAULT_NOTE_READING_SETTINGS)
    store.set({ clef: 'treble', inputMode: 'fretboard' })
    expect(store.get()).toEqual({ clef: 'treble', inputMode: 'fretboard' })
  })
})
