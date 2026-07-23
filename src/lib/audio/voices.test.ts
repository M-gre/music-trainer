import { describe, expect, it } from 'vitest'
import { renderFmPiano, pianoOptionsForMidi } from './fmPiano.ts'
import { renderKarplusStrong, pluckOptionsForMidi } from './karplusStrong.ts'
import {
  VOICE_INFO,
  VOICE_NAMES,
  VOICE_PEAK,
  amplitudePercentile,
  dcOffset,
  dominantFrequency,
  fadeInAttack,
  fadeOutTail,
  isVoiceName,
  normalizePeak,
  normalizePercentile,
  peakAmplitude,
  removeDc,
  rms,
  softClip,
} from './voices.ts'

describe('voice identity', () => {
  it('recognizes valid voice names and rejects others', () => {
    for (const name of VOICE_NAMES) expect(isVoiceName(name)).toBe(true)
    expect(isVoiceName('sine')).toBe(false)
    expect(isVoiceName(3)).toBe(false)
    expect(isVoiceName(undefined)).toBe(false)
  })

  it('has UI info for every voice', () => {
    for (const name of VOICE_NAMES) {
      expect(VOICE_INFO[name].label.length).toBeGreaterThan(0)
      expect(VOICE_INFO[name].description.length).toBeGreaterThan(0)
    }
  })
})

describe('signal helpers', () => {
  it('rms of a full-scale sine is ~1/sqrt(2)', () => {
    const n = 4096
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i += 1) buf[i] = Math.sin((2 * Math.PI * 4 * i) / n)
    expect(rms(buf)).toBeCloseTo(Math.SQRT1_2, 2)
  })

  it('peakAmplitude finds the largest magnitude', () => {
    expect(peakAmplitude(new Float32Array([0.1, -0.9, 0.3]))).toBeCloseTo(0.9)
    expect(peakAmplitude(new Float32Array([]))).toBe(0)
  })

  it('dcOffset and removeDc', () => {
    const buf = new Float32Array([1, 1, 1, 1])
    expect(dcOffset(buf)).toBe(1)
    removeDc(buf)
    expect(dcOffset(buf)).toBeCloseTo(0, 6)
  })

  it('normalizePeak scales the largest magnitude to the target', () => {
    const buf = new Float32Array([0.2, -0.4, 0.1])
    normalizePeak(buf, 1)
    expect(peakAmplitude(buf)).toBeCloseTo(1)
    // silent buffer stays silent (no divide-by-zero)
    const zero = new Float32Array([0, 0])
    normalizePeak(zero, 1)
    expect(peakAmplitude(zero)).toBe(0)
  })

  it('fadeOutTail brings the final sample to zero', () => {
    const buf = new Float32Array(1000).fill(1)
    fadeOutTail(buf, 44100, 0.005)
    expect(buf[buf.length - 1]).toBeCloseTo(0, 4)
    expect(buf[0]).toBe(1) // untouched at the head
  })

  it('fadeInAttack ramps up from silence and leaves the body untouched', () => {
    const buf = new Float32Array(1000).fill(1)
    fadeInAttack(buf, 44100, 0.005)
    expect(buf[0]!).toBeLessThan(1)
    expect(buf[0]!).toBeGreaterThanOrEqual(0)
    expect(buf[buf.length - 1]).toBe(1)
  })

  it('amplitudePercentile returns the value at the requested rank', () => {
    const buf = new Float32Array([0, 0.1, 0.2, 0.3, 1])
    expect(amplitudePercentile(buf, 1)).toBeCloseTo(1)
    expect(amplitudePercentile(buf, 0)).toBeCloseTo(0)
    expect(amplitudePercentile(buf, 0.5)).toBeCloseTo(0.2)
  })

  it('normalizePercentile scales so the percentile maps to the target', () => {
    const buf = new Float32Array([0.1, 0.2, 0.4, 2]) // one transient outlier
    // p0.5 of 4 sorted values rounds to index 2 (0.4); map it to 0.5 (scale 1.25).
    normalizePercentile(buf, 0.5, 0.5)
    expect(amplitudePercentile(buf, 0.5)).toBeCloseTo(0.5)
    expect(buf[3]!).toBeCloseTo(2.5) // outlier scaled the same, to be soft-clipped
  })

  it('softClip leaves the body linear and folds peaks below full scale', () => {
    const buf = new Float32Array([0.3, -0.5, 1.5, -8])
    softClip(buf, 0.6)
    expect(buf[0]!).toBeCloseTo(0.3) // below threshold: untouched
    expect(buf[1]!).toBeCloseTo(-0.5)
    expect(Math.abs(buf[2]!)).toBeLessThan(1) // moderate overshoot folded below 1
    expect(Math.abs(buf[2]!)).toBeGreaterThan(0.6)
    expect(buf[3]!).toBeLessThan(0) // sign preserved
    expect(Math.abs(buf[3]!)).toBeLessThanOrEqual(1) // extreme input saturates to ≤ 1
  })

  it('dominantFrequency recovers the pitch of a pure sine', () => {
    const sr = 44100
    const f = 220
    const buf = new Float32Array(sr / 4)
    for (let i = 0; i < buf.length; i += 1) buf[i] = Math.sin((2 * Math.PI * f * i) / sr)
    expect(dominantFrequency(buf, sr, { minHz: 80, maxHz: 800 })).toBeCloseTo(f, -1)
  })
})

/** In-graph RMS of the classic dual-saw voice at its peak gain (reference). */
function classicEffectiveRms(midi: number, seconds: number, sr: number): number {
  const f0 = 440 * Math.pow(2, (midi - 69) / 12)
  const detune = Math.pow(2, 4 / 1200) // +4 cents (the engine's default spread/2)
  const n = Math.round(seconds * sr)
  const buf = new Float32Array(n)
  const saw = (phase: number): number => 2 * (phase - Math.floor(phase + 0.5))
  for (let i = 0; i < n; i += 1) {
    const t = i / sr
    buf[i] = saw(f0 * detune * t) + saw((f0 / detune) * t)
  }
  return VOICE_PEAK.classic * rms(buf)
}

describe('perceptual level normalization', () => {
  const sr = 44100
  const seconds = 0.6
  const midi = 50

  it('keeps the three voices within ±20% RMS of one another', () => {
    const pluck = renderKarplusStrong(midi, seconds, sr, pluckOptionsForMidi(midi))
    const piano = renderFmPiano(midi, seconds, sr, pianoOptionsForMidi(midi))

    const effPluck = VOICE_PEAK.pluck * rms(pluck)
    const effPiano = VOICE_PEAK.piano * rms(piano)
    const effClassic = classicEffectiveRms(midi, seconds, sr)

    const levels = [effPluck, effPiano, effClassic]
    const min = Math.min(...levels)
    const max = Math.max(...levels)
    expect(max / min).toBeLessThanOrEqual(1.2)
  })
})
