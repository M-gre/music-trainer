import { describe, expect, it } from 'vitest'
import {
  ACCENT_LEVELS,
  CLICK_VOICES,
  CLICK_VOICE_IDS,
  cycleAccent,
  DEFAULT_CLICK_VOICE_ID,
  getClickVoice,
  isAccentLevel,
  isClickVoiceId,
  resolveClickParams,
  SUBDIVISION_GAIN_SCALE,
  type AccentLevel,
  type ClickVoiceId,
} from './clickVoices.ts'

describe('cycleAccent', () => {
  it('cycles off -> low -> mid -> high -> off', () => {
    expect(cycleAccent('off')).toBe('low')
    expect(cycleAccent('low')).toBe('mid')
    expect(cycleAccent('mid')).toBe('high')
    expect(cycleAccent('high')).toBe('off')
  })

  it('cycling through the full ring returns to the start', () => {
    let level: AccentLevel = ACCENT_LEVELS[0]
    for (let i = 0; i < ACCENT_LEVELS.length; i += 1) level = cycleAccent(level)
    expect(level).toBe(ACCENT_LEVELS[0])
  })
})

describe('isAccentLevel / isClickVoiceId', () => {
  it('recognizes valid values and rejects junk', () => {
    expect(isAccentLevel('mid')).toBe(true)
    expect(isAccentLevel('loud')).toBe(false)
    expect(isAccentLevel(2)).toBe(false)
    expect(isClickVoiceId('woodblock')).toBe(true)
    expect(isClickVoiceId('kazoo')).toBe(false)
    expect(isClickVoiceId(null)).toBe(false)
  })
})

describe('voice catalogue', () => {
  it('exposes at least four voices, matching the id list', () => {
    expect(CLICK_VOICES.length).toBeGreaterThanOrEqual(4)
    expect(CLICK_VOICES.map((v) => v.id)).toEqual([...CLICK_VOICE_IDS])
  })

  it('has the default voice in the catalogue', () => {
    expect(CLICK_VOICE_IDS).toContain(DEFAULT_CLICK_VOICE_ID)
  })

  it('getClickVoice returns the matching definition', () => {
    for (const id of CLICK_VOICE_IDS) expect(getClickVoice(id).id).toBe(id)
  })
})

describe('resolveClickParams', () => {
  it('returns null (silent) for the off level', () => {
    for (const id of CLICK_VOICE_IDS) {
      expect(resolveClickParams(id, 'off', false)).toBeNull()
    }
  })

  it('produces a spec for every audible level of every voice', () => {
    for (const id of CLICK_VOICE_IDS) {
      for (const level of ['low', 'mid', 'high'] as const) {
        const spec = resolveClickParams(id, level, false)
        expect(spec).not.toBeNull()
        expect(spec!.gain).toBeGreaterThan(0)
        expect(spec!.gain).toBeLessThanOrEqual(1)
        expect(spec!.duration).toBeGreaterThan(0)
      }
    }
  })

  it('increases gain and pitch as the accent rises (per voice)', () => {
    for (const id of CLICK_VOICE_IDS) {
      const low = resolveClickParams(id, 'low', false)!
      const mid = resolveClickParams(id, 'mid', false)!
      const high = resolveClickParams(id, 'high', false)!
      expect(low.gain).toBeLessThan(mid.gain)
      expect(mid.gain).toBeLessThan(high.gain)
      expect(freqOf(low)).toBeLessThan(freqOf(mid))
      expect(freqOf(mid)).toBeLessThan(freqOf(high))
    }
  })

  it('scales subdivision clicks quieter than the equivalent beat click', () => {
    for (const id of CLICK_VOICE_IDS) {
      const beat = resolveClickParams(id, 'mid', false)!
      const sub = resolveClickParams(id, 'mid', true)!
      expect(sub.gain).toBeCloseTo(beat.gain * SUBDIVISION_GAIN_SCALE)
    }
  })

  it('gives the woodblock a downward pitch drop', () => {
    const spec = resolveClickParams('woodblock', 'mid', false)!
    expect(spec.source.kind).toBe('osc')
    if (spec.source.kind === 'osc') {
      expect(spec.source.endFrequency).toBeLessThan(spec.source.frequency)
    }
  })

  it('gives the tick a bandpassed noise source', () => {
    const spec = resolveClickParams('tick', 'mid', false)!
    expect(spec.source.kind).toBe('noise')
    expect(spec.filter?.type).toBe('bandpass')
  })

  it('uses a soft (non-square) waveform for the beep voice', () => {
    const spec = resolveClickParams('beep', 'mid', false)!
    if (spec.source.kind === 'osc') expect(spec.source.type).not.toBe('square')
  })

  it('keeps every voice within a comparable loudness band at mid accent', () => {
    const gains = CLICK_VOICE_IDS.map((id) => resolveClickParams(id, 'mid', false)!.gain)
    const max = Math.max(...gains)
    const min = Math.min(...gains)
    // Perceived-loudness calibration should keep voices within ~2x of each other.
    expect(max / min).toBeLessThan(2)
  })

  it('falls back to the default voice for an unknown id', () => {
    const spec = resolveClickParams('nope' as ClickVoiceId, 'mid', false)
    expect(spec).not.toBeNull()
  })
})

/** The starting frequency of a spec (0 for noise sources, which are unpitched). */
function freqOf(spec: NonNullable<ReturnType<typeof resolveClickParams>>): number {
  return spec.source.kind === 'osc' ? spec.source.frequency : spec.filter?.frequency ?? 0
}
