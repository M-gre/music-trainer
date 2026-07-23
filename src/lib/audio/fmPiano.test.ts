import { describe, expect, it } from 'vitest'
import { pianoOptionsForMidi, pianoPartials, renderFmPiano } from './fmPiano.ts'
import { dcOffset, dominantFrequency, peakAmplitude, rms } from './voices.ts'

const SR = 44100

function render(midi: number, seconds = 0.8): Float32Array {
  return renderFmPiano(midi, seconds, SR, pianoOptionsForMidi(midi))
}

describe('pianoPartials', () => {
  it('makes the fundamental loudest, ratios increasing, decays decreasing', () => {
    const partials = pianoPartials(pianoOptionsForMidi(60))
    expect(partials.length).toBeGreaterThan(4)
    expect(partials[0]!.ratio).toBeCloseTo(1, 2) // fundamental
    for (let k = 1; k < partials.length; k += 1) {
      // Amplitude rolls off, ratios stretch upward, higher partials decay faster.
      expect(partials[k]!.amp).toBeLessThan(partials[k - 1]!.amp)
      expect(partials[k]!.ratio).toBeGreaterThan(partials[k - 1]!.ratio)
      expect(partials[k]!.decay).toBeLessThan(partials[k - 1]!.decay)
    }
  })

  it('stretches partials slightly sharp (inharmonicity), staying near the harmonic number', () => {
    const partials = pianoPartials(pianoOptionsForMidi(48))
    // Partial k should sit at or just above the integer harmonic k.
    for (let k = 0; k < partials.length; k += 1) {
      const harmonic = k + 1
      expect(partials[k]!.ratio).toBeGreaterThanOrEqual(harmonic - 1e-9)
      expect(partials[k]!.ratio).toBeLessThan(harmonic * 1.06)
    }
  })

  it('low register uses more, steeper partials than the treble', () => {
    const bass = pianoOptionsForMidi(28)
    const treble = pianoOptionsForMidi(88)
    expect(bass.partialCount).toBeGreaterThan(treble.partialCount)
    expect(bass.tilt).toBeGreaterThan(treble.tilt) // darker
  })
})

describe('renderFmPiano', () => {
  it('produces a buffer of the requested length', () => {
    const out = renderFmPiano(60, 0.5, SR, pianoOptionsForMidi(60))
    expect(out.length).toBe(Math.round(0.5 * SR))
  })

  it('stays below full scale and is DC-free', () => {
    const out = render(60)
    const peak = peakAmplitude(out)
    expect(peak).toBeLessThanOrEqual(1)
    expect(peak).toBeGreaterThan(0.4)
    expect(Math.abs(dcOffset(out))).toBeLessThan(0.01)
  })

  it('starts at silence (no attack click) and ends near silence', () => {
    const out = render(60)
    expect(Math.abs(out[0] ?? 1)).toBeLessThan(0.02)
    expect(Math.abs(out[out.length - 1] ?? 1)).toBeLessThan(0.02)
  })

  it('decays over its length', () => {
    const out = render(60)
    const q = Math.floor(out.length / 4)
    const first = rms(out.subarray(0, q))
    const last = rms(out.subarray(out.length - q))
    expect(first).toBeGreaterThan(last)
  })

  it('has a dominant period matching the fundamental', () => {
    for (const midi of [36, 48, 60, 72]) {
      const f0 = 440 * Math.pow(2, (midi - 69) / 12)
      const out = render(midi, 0.5)
      const detected = dominantFrequency(out, SR, {
        minHz: f0 * 0.5,
        maxHz: f0 * 2,
        windowSize: 16384,
      })
      expect(detected).toBeGreaterThan(f0 * 0.97)
      expect(detected).toBeLessThan(f0 * 1.03)
    }
  })

  it('does not synthesize partials above Nyquist (no aliasing blowup)', () => {
    // A high note whose upper partials would exceed Nyquist must stay bounded.
    const out = renderFmPiano(96, 0.3, SR, pianoOptionsForMidi(96))
    expect(peakAmplitude(out)).toBeLessThanOrEqual(1)
    expect(peakAmplitude(out)).toBeGreaterThan(0.3)
    expect(Number.isFinite(rms(out))).toBe(true)
  })
})
