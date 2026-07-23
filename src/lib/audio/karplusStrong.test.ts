import { describe, expect, it } from 'vitest'
import { renderKarplusStrong, pluckOptionsForMidi } from './karplusStrong.ts'
import {
  dcOffset,
  dominantFrequency,
  energyFractionAbove,
  goertzelPower,
  peakAmplitude,
  rms,
  spectralCentroid,
} from './voices.ts'

const SR = 44100
const f0 = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12)

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

  it('rounds the attack so the first sample is not a hard click', () => {
    const out = render(40)
    // The raised-cosine attack fade keeps the very first sample tiny.
    expect(Math.abs(out[0] ?? 1)).toBeLessThan(0.05)
  })

  it('has a dominant period matching the fundamental across the range', () => {
    for (const midi of [28, 40, 52, 64, 76]) {
      const out = render(midi, 0.5)
      const detected = dominantFrequency(out, SR, {
        minHz: f0(midi) * 0.5,
        maxHz: f0(midi) * 2,
        windowSize: 16384,
      })
      // Within ~3% (≈ half a semitone) — accurate tuning from fractional delay.
      expect(detected).toBeGreaterThan(f0(midi) * 0.97)
      expect(detected).toBeLessThan(f0(midi) * 1.03)
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

  it('pluckOptionsForMidi makes the bass darker and longer-ringing than the guitar range', () => {
    const bass = pluckOptionsForMidi(31) // low B on a 5-string
    const guitar = pluckOptionsForMidi(64) // E4
    expect(bass.brightness).toBeLessThan(guitar.brightness)
    // Warm, sustained bass: rings LONGER than the guitar register.
    expect(bass.decaySeconds).toBeGreaterThan(guitar.decaySeconds)
    // More fundamental reinforcement + a more central pluck low down.
    expect(bass.bodyMix ?? 0).toBeGreaterThan(guitar.bodyMix ?? 0)
    expect(bass.pickPosition ?? 0).toBeGreaterThan(guitar.pickPosition ?? 0)
  })
})

// --- Quantitative timbre targets (the "not clangy" contract) ----------------
// A clangy/metallic pluck has an abnormally high spectral centroid and audible
// energy in the high treble that never dies. These assert the opposite.

describe('renderKarplusStrong timbre (anti-clang) targets', () => {
  const BASS = [28, 31, 33, 36, 40, 43]
  const GUITAR = [45, 52, 55, 59, 64, 71, 76]

  it('keeps the low bass attack dark (spectral centroid of the first 100 ms)', () => {
    // Low open-bass notes are warm and round.
    for (const midi of [28, 40]) {
      const first100 = render(midi).subarray(0, Math.round(0.1 * SR))
      expect(spectralCentroid(first100, SR, { maxHz: 12000 })).toBeLessThan(900)
    }
    // Nothing in the bass register gets remotely bright/metallic in the attack.
    for (const midi of BASS) {
      const first100 = render(midi).subarray(0, Math.round(0.1 * SR))
      expect(spectralCentroid(first100, SR, { maxHz: 12000 })).toBeLessThan(1300)
    }
  })

  it('keeps the guitar attack below a brighter (but non-clangy) ceiling', () => {
    for (const midi of GUITAR) {
      const first100 = render(midi).subarray(0, Math.round(0.1 * SR))
      expect(spectralCentroid(first100, SR, { maxHz: 12000 })).toBeLessThan(1800)
    }
  })

  it('bass notes have almost no energy above 5 kHz (no high-frequency zing)', () => {
    for (const midi of BASS) {
      const early = render(midi).subarray(0, Math.round(0.3 * SR))
      expect(energyFractionAbove(early, SR, 5000)).toBeLessThan(0.01) // < 1%
    }
  })

  it('the fundamental dominates any single overtone after 300 ms', () => {
    for (const midi of [...BASS, ...GUITAR]) {
      const buf = render(midi, 1.0)
      const win = buf.subarray(Math.round(0.3 * SR), Math.round(0.3 * SR) + 8192)
      const fund = goertzelPower(win, SR, f0(midi))
      let strongestOvertone = 0
      for (let k = 2; k <= 12; k += 1) {
        const p = goertzelPower(win, SR, f0(midi) * k)
        if (p > strongestOvertone) strongestOvertone = p
      }
      expect(fund).toBeGreaterThan(strongestOvertone * 1.3)
    }
  })

  it('decays smoothly (each quarter quieter than the previous — no re-ringing)', () => {
    for (const midi of [28, 36, 40, 52, 64]) {
      const buf = render(midi, 1.0)
      const q = Math.floor(buf.length / 4)
      const quarters = [0, 1, 2, 3].map((i) => rms(buf.subarray(i * q, (i + 1) * q)))
      for (let i = 1; i < 4; i += 1) {
        expect(quarters[i]!).toBeLessThan(quarters[i - 1]!)
      }
    }
  })
})
