import { describe, expect, it } from 'vitest'
import type { GridPosition } from './audio/scheduler.ts'
import {
  barToChordIndex,
  ChordCompPlayer,
  clampBarsPerChord,
  compChordDuration,
  compTriggersAt,
  compVoice,
  CUSTOM_PROGRESSION_ID,
  DEFAULT_ACCOMPANIMENT_SETTINGS,
  keyOptions,
  MAX_CUSTOM_DEGREES,
  normalizeAccompanimentSettings,
  parseDegrees,
  progressionTotalBars,
  PROGRESSION_PRESETS,
  resolveAccompaniment,
  resolveProgressionChords,
  voiceLeadProgression,
  type AccompanimentSettings,
  type ChordCompConfig,
  type ChordVoiceOptions,
} from './accompaniment.ts'

// --- parseDegrees ------------------------------------------------------------

describe('parseDegrees', () => {
  it('parses hyphen-separated degrees', () => {
    expect(parseDegrees('1-5-6-4')).toEqual({ ok: true, degrees: [1, 5, 6, 4] })
  })

  it('accepts spaces and commas as separators, trimming and collapsing runs', () => {
    expect(parseDegrees('  2 , 5 - 1  ')).toEqual({ ok: true, degrees: [2, 5, 1] })
    expect(parseDegrees('1--5')).toEqual({ ok: true, degrees: [1, 5] })
  })

  it('rejects empty input', () => {
    expect(parseDegrees('   ')).toMatchObject({ ok: false })
    expect(parseDegrees('-')).toMatchObject({ ok: false })
  })

  it('rejects out-of-range and non-numeric tokens', () => {
    expect(parseDegrees('1-8-3')).toMatchObject({ ok: false })
    expect(parseDegrees('1-0-3')).toMatchObject({ ok: false })
    expect(parseDegrees('1-x-3')).toMatchObject({ ok: false })
    expect(parseDegrees('12')).toMatchObject({ ok: false })
  })

  it('rejects an over-long progression', () => {
    const tooMany = Array.from({ length: MAX_CUSTOM_DEGREES + 1 }, () => '1').join('-')
    expect(parseDegrees(tooMany)).toMatchObject({ ok: false })
  })
})

// --- resolveProgressionChords ------------------------------------------------

describe('resolveProgressionChords', () => {
  it('spells a I–V–vi–IV in C major', () => {
    const chords = resolveProgressionChords(0, [
      { degree: 1 },
      { degree: 5 },
      { degree: 6 },
      { degree: 4 },
    ])
    expect(chords.map((c) => c.symbol)).toEqual(['C', 'G', 'Am', 'F'])
  })

  it('spells diatonic chords with flats for a flat key (F major ii = Gm)', () => {
    const chords = resolveProgressionChords(5, [{ degree: 2 }])
    expect(chords[0]!.symbol).toBe('Gm')
  })

  it('applies a dominant-7th quality override keeping the diatonic root letter', () => {
    const chords = resolveProgressionChords(0, [
      { degree: 1, qualityId: 'dom7' },
      { degree: 4, qualityId: 'dom7' },
      { degree: 5, qualityId: 'dom7' },
    ])
    expect(chords.map((c) => c.symbol)).toEqual(['C7', 'F7', 'G7'])
    expect(chords.map((c) => c.quality.id)).toEqual(['dom7', 'dom7', 'dom7'])
  })
})

// --- voiceLeadProgression ----------------------------------------------------

describe('voiceLeadProgression', () => {
  it('voices the first chord in root position around C4', () => {
    const chords = resolveProgressionChords(0, [{ degree: 1 }])
    expect(voiceLeadProgression(chords)).toEqual([[60, 64, 67]])
  })

  it('returns one voicing per chord and keeps voices close together', () => {
    const chords = resolveProgressionChords(0, [{ degree: 1 }, { degree: 5 }, { degree: 6 }, { degree: 4 }])
    const voicings = voiceLeadProgression(chords)
    expect(voicings).toHaveLength(4)
    const centre = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length
    // Each successive chord's centre stays within an octave of the previous —
    // i.e. voice leading, not a jump to a fixed root position each time.
    for (let i = 1; i < voicings.length; i++) {
      expect(Math.abs(centre(voicings[i]!) - centre(voicings[i - 1]!))).toBeLessThan(12)
    }
  })
})

// --- bars-per-chord mapping --------------------------------------------------

describe('clampBarsPerChord', () => {
  it('clamps to 1..2 and rounds; NaN -> 1', () => {
    expect(clampBarsPerChord(0)).toBe(1)
    expect(clampBarsPerChord(5)).toBe(2)
    expect(clampBarsPerChord(1.4)).toBe(1)
    expect(clampBarsPerChord(Number.NaN)).toBe(1)
  })
})

describe('progressionTotalBars', () => {
  it('multiplies chord count by bars-per-chord', () => {
    expect(progressionTotalBars(4, 1)).toBe(4)
    expect(progressionTotalBars(4, 2)).toBe(8)
    expect(progressionTotalBars(0, 2)).toBe(0)
  })
})

describe('barToChordIndex', () => {
  it('maps bars 1:1 at one bar per chord, looping', () => {
    expect([0, 1, 2, 3, 4].map((b) => barToChordIndex(b, 4, 1))).toEqual([0, 1, 2, 3, 0])
  })

  it('holds each chord for two bars', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((b) => barToChordIndex(b, 4, 2))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3, 0,
    ])
  })

  it('returns null when there are no chords', () => {
    expect(barToChordIndex(3, 0, 1)).toBeNull()
  })
})

// --- comping voice decisions -------------------------------------------------

function pos(bar: number, beat: number, subdivision = 0): GridPosition {
  return { bar, beat, subdivision }
}

describe('compTriggersAt', () => {
  it('pad fires only on the downbeat of a bar', () => {
    expect(compTriggersAt(pos(0, 0), 'pad')).toBe(true)
    expect(compTriggersAt(pos(0, 1), 'pad')).toBe(false)
    expect(compTriggersAt(pos(0, 0, 1), 'pad')).toBe(false)
  })

  it('stabs fire on every beat head but not off-beats', () => {
    expect(compTriggersAt(pos(0, 0), 'stabs')).toBe(true)
    expect(compTriggersAt(pos(0, 3), 'stabs')).toBe(true)
    expect(compTriggersAt(pos(0, 3, 1), 'stabs')).toBe(false)
  })
})

describe('compChordDuration', () => {
  it('holds a pad for the whole bar', () => {
    expect(compChordDuration('pad', 4, 120)).toBeCloseTo(2)
  })

  it('keeps stabs short', () => {
    expect(compChordDuration('stabs', 4, 120)).toBeCloseTo(0.3)
  })
})

describe('compVoice', () => {
  it('pins the classic synth for both styles (its type/ADSR only apply there)', () => {
    expect(compVoice('pad').voice).toBe('classic')
    expect(compVoice('stabs').voice).toBe('classic')
  })

  it('gives the pad a long sustain and the stab a short one', () => {
    expect(compVoice('pad').sustain).toBeGreaterThan(compVoice('stabs').sustain)
  })
})

// --- ChordCompPlayer ---------------------------------------------------------

interface Call {
  midis: readonly number[]
  duration: number
  opts?: ChordVoiceOptions
}

function mockTrigger(): { calls: Call[]; playChord: (m: readonly number[], d: number, o?: ChordVoiceOptions) => void } {
  const calls: Call[] = []
  return {
    calls,
    playChord: (midis, duration, opts) => void calls.push({ midis, duration, opts }),
  }
}

function config(patch: Partial<ChordCompConfig>): ChordCompConfig {
  return {
    enabled: true,
    style: 'pad',
    voicings: [
      [60, 64, 67],
      [62, 65, 69],
    ],
    barsPerChord: 1,
    beatsPerBar: 4,
    bpm: 120,
    countInBars: 1,
    velocity: 0.5,
    ...patch,
  }
}

describe('ChordCompPlayer', () => {
  it('plays nothing during the count-in bars', () => {
    const trigger = mockTrigger()
    const player = new ChordCompPlayer(trigger, config({}))
    player.handleEvent(pos(0, 0), 1) // count-in bar
    expect(trigger.calls).toHaveLength(0)
  })

  it('plays the mapped voicing at the bar boundary, at the event time', () => {
    const trigger = mockTrigger()
    const player = new ChordCompPlayer(trigger, config({}))
    player.handleEvent(pos(1, 0), 2.5) // first groove bar
    expect(trigger.calls).toHaveLength(1)
    expect(trigger.calls[0]!.midis).toEqual([60, 64, 67])
    expect(trigger.calls[0]!.opts?.when).toBe(2.5)
    player.handleEvent(pos(2, 0), 4.5) // second groove bar -> second voicing
    expect(trigger.calls[1]!.midis).toEqual([62, 65, 69])
  })

  it('does not retrigger a pad on non-downbeats', () => {
    const trigger = mockTrigger()
    const player = new ChordCompPlayer(trigger, config({}))
    player.handleEvent(pos(1, 1), 3)
    player.handleEvent(pos(1, 2), 3.5)
    expect(trigger.calls).toHaveLength(0)
  })

  it('stabs on every beat with the current bar voicing', () => {
    const trigger = mockTrigger()
    const player = new ChordCompPlayer(trigger, config({ style: 'stabs' }))
    player.handleEvent(pos(1, 0), 2)
    player.handleEvent(pos(1, 1), 2.5)
    player.handleEvent(pos(1, 2), 3)
    expect(trigger.calls).toHaveLength(3)
    for (const call of trigger.calls) expect(call.midis).toEqual([60, 64, 67])
  })

  it('is silent when disabled or with no voicings', () => {
    const off = mockTrigger()
    new ChordCompPlayer(off, config({ enabled: false })).handleEvent(pos(1, 0), 1)
    expect(off.calls).toHaveLength(0)

    const empty = mockTrigger()
    new ChordCompPlayer(empty, config({ voicings: [] })).handleEvent(pos(1, 0), 1)
    expect(empty.calls).toHaveLength(0)
  })

  it('reconfigures live via configure()', () => {
    const trigger = mockTrigger()
    const player = new ChordCompPlayer(trigger, config({}))
    player.configure(config({ countInBars: 0 }))
    player.handleEvent(pos(0, 0), 0)
    expect(trigger.calls).toHaveLength(1)
  })
})

// --- resolveAccompaniment ----------------------------------------------------

function settings(patch: Partial<AccompanimentSettings>): AccompanimentSettings {
  return { ...DEFAULT_ACCOMPANIMENT_SETTINGS, ...patch }
}

describe('resolveAccompaniment', () => {
  it('resolves a preset into chords, voicings and total bars', () => {
    const r = resolveAccompaniment(settings({ progressionId: 'I-V-vi-IV', rootPc: 0, barsPerChord: 2 }))
    expect(r.error).toBeNull()
    expect(r.chords.map((c) => c.symbol)).toEqual(['C', 'G', 'Am', 'F'])
    expect(r.voicings).toHaveLength(4)
    expect(r.barsPerChord).toBe(2)
    expect(r.totalBars).toBe(8)
    expect(r.barsPerChordLocked).toBe(false)
  })

  it('locks bars-per-chord to 1 for the 12-bar blues form and uses dom7s', () => {
    const r = resolveAccompaniment(settings({ progressionId: 'blues-12', rootPc: 0, barsPerChord: 2 }))
    expect(r.barsPerChord).toBe(1)
    expect(r.barsPerChordLocked).toBe(true)
    expect(r.chords).toHaveLength(12)
    expect(r.totalBars).toBe(12)
    expect(r.chords.map((c) => c.symbol)).toEqual([
      'C7', 'C7', 'C7', 'C7', 'F7', 'F7', 'C7', 'C7', 'G7', 'F7', 'C7', 'C7',
    ])
  })

  it('resolves a valid custom progression', () => {
    const r = resolveAccompaniment(
      settings({ progressionId: CUSTOM_PROGRESSION_ID, customDegrees: '1-4-5', rootPc: 0 }),
    )
    expect(r.error).toBeNull()
    expect(r.chords.map((c) => c.symbol)).toEqual(['C', 'F', 'G'])
  })

  it('reports an error and no chords for invalid custom input', () => {
    const r = resolveAccompaniment(
      settings({ progressionId: CUSTOM_PROGRESSION_ID, customDegrees: '1-9' }),
    )
    expect(r.error).not.toBeNull()
    expect(r.chords).toHaveLength(0)
    expect(r.voicings).toHaveLength(0)
  })
})

// --- normalizeAccompanimentSettings ------------------------------------------

describe('normalizeAccompanimentSettings', () => {
  it('passes through a valid value', () => {
    const value: AccompanimentSettings = {
      enabled: true,
      rootPc: 7,
      progressionId: 'ii-V-I',
      customDegrees: '2-5-1',
      barsPerChord: 2,
      style: 'stabs',
    }
    expect(normalizeAccompanimentSettings(value)).toEqual(value)
  })

  it('falls back per-field for missing / invalid data', () => {
    expect(normalizeAccompanimentSettings({})).toEqual(DEFAULT_ACCOMPANIMENT_SETTINGS)
    expect(normalizeAccompanimentSettings(null)).toEqual(DEFAULT_ACCOMPANIMENT_SETTINGS)
    expect(
      normalizeAccompanimentSettings({
        rootPc: 15,
        progressionId: 'bogus',
        barsPerChord: 9,
        style: 'weird',
      }),
    ).toEqual({
      ...DEFAULT_ACCOMPANIMENT_SETTINGS,
      rootPc: 3, // 15 mod 12
      barsPerChord: 2,
    })
  })
})

// --- misc --------------------------------------------------------------------

describe('keyOptions', () => {
  it('offers all 12 roots spelled per prefersFlats', () => {
    const opts = keyOptions()
    expect(opts).toHaveLength(12)
    const byPc = Object.fromEntries(opts.map((o) => [o.pc, o.name]))
    expect(byPc[0]).toBe('C')
    expect(byPc[1]).toBe('Db')
    expect(byPc[3]).toBe('Eb')
    expect(byPc[10]).toBe('Bb')
  })
})

describe('PROGRESSION_PRESETS', () => {
  it('every preset resolves to at least one chord in C major', () => {
    for (const preset of PROGRESSION_PRESETS) {
      const chords = resolveProgressionChords(0, preset.specs)
      expect(chords.length).toBeGreaterThan(0)
    }
  })
})
