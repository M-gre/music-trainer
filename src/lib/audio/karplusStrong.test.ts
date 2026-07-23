import { describe, expect, it } from 'vitest'
import { renderKarplusStrong, pluckOptionsForMidi } from './karplusStrong.ts'
import { dcOffset, dominantFrequency, peakAmplitude, rms } from './voices.ts'

const SR = 44100

function render(midi: number, seconds = 0.8): Float32Array {
  return renderKarplusStrong(midi, seconds, SR, pluckOptionsForMidi(midi))
}

describe('renderKarplusStrong', () => {
  it('produces a buffer of the requested length', () => {
    const out = renderKarplusStrong(45, 0.5, SR, pluckOptionsForMidi(45))
    expect(out.length).toBe(Math.round(0.5 * SR))
  })

  it('stays below full scale (soft-clipped, no hard clip) and is DC-free', () => {
    const out = render(45)
    const peak = peakAmplitude(out)
    expect(peak).toBeLessThanOrEqual(1)
    expect(peak).toBeGreaterThan(0.5) // healthy level, not crushed
    expect(Math.abs(dcOffset(out))).toBeLessThan(0.01)
  })

  it('decays: the first quarter is louder than the last quarter', () => {
    const out = render(45)
    const q = Math.floor(out.length / 4)
    const first = rms(out.subarray(0, q))
    const last = rms(out.subarray(out.length - q))
    expect(first).toBeGreaterThan(last * 2)
  })

  it('ends near silence (tail fade) so the source stop does not click', () => {
    const out = render(45)
    expect(Math.abs(out[out.length - 1] ?? 1)).toBeLessThan(0.02)
  })

  it('has a dominant period matching the fundamental across the range', () => {
    for (const midi of [28, 40, 52, 64, 76]) {
      const f0 = 440 * Math.pow(2, (midi - 69) / 12)
      const out = render(midi, 0.5)
      const detected = dominantFrequency(out, SR, {
        minHz: f0 * 0.5,
        maxHz: f0 * 2,
        windowSize: 16384,
      })
      // Within ~3% (≈ half a semitone) — accurate tuning from fractional delay.
      expect(detected).toBeGreaterThan(f0 * 0.97)
      expect(detected).toBeLessThan(f0 * 1.03)
    }
  })

  it('is deterministic for a given seed', () => {
    const a = renderKarplusStrong(45, 0.3, SR, { brightness: 0.5, decaySeconds: 2, seed: 7 })
    const b = renderKarplusStrong(45, 0.3, SR, { brightness: 0.5, decaySeconds: 2, seed: 7 })
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('a brighter pluck carries more high-frequency energy than a darker one', () => {
    // Compare high-frequency content via mean absolute first difference.
    const roughness = (buf: Float32Array): number => {
      let sum = 0
      for (let i = 1; i < buf.length; i += 1) sum += Math.abs((buf[i] ?? 0) - (buf[i - 1] ?? 0))
      return sum / buf.length
    }
    const dark = renderKarplusStrong(45, 0.5, SR, { brightness: 0.2, decaySeconds: 2, seed: 1 })
    const bright = renderKarplusStrong(45, 0.5, SR, { brightness: 0.9, decaySeconds: 2, seed: 1 })
    expect(roughness(bright)).toBeGreaterThan(roughness(dark))
  })

  it('pluckOptionsForMidi darkens and shortens the bass relative to guitar range', () => {
    const bass = pluckOptionsForMidi(31) // low B on a 5-string
    const guitar = pluckOptionsForMidi(64) // E4
    expect(bass.brightness).toBeLessThan(guitar.brightness)
    expect(bass.decaySeconds).toBeLessThan(guitar.decaySeconds)
  })
})
