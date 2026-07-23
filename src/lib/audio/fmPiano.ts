/**
 * Piano-like struck-string tone, rendered to a mono sample buffer.
 *
 * PURE: no Web Audio, no `window`. Like the pluck voice, the engine plays the
 * returned `Float32Array` through an `AudioBufferSourceNode`, so the timbre is
 * fully unit-testable.
 *
 * The model is additive: a stack of slightly *inharmonic* partials (real piano
 * strings are stiff, so overtones stretch sharp), each with its own amplitude
 * and its own exponential decay. The key to a piano-ish result is that higher
 * partials both start quieter AND die faster, so the tone is bright at the
 * attack and rounds off into the fundamental as it rings — the opposite of a
 * static additive organ. The low register uses fewer, steeper partials so bass
 * notes read as dark and round rather than buzzy.
 */

import { midiToFreq, type Midi } from '../theory/notes.ts'
import { fadeOutTail, normalizePercentile, softClip } from './voices.ts'

/** One additive partial, as a ratio of the fundamental. */
export interface Partial {
  /** Frequency as a multiple of f0 (≈ its harmonic number, stretched sharp). */
  ratio: number
  /** Peak linear amplitude relative to the fundamental (which is 1). */
  amp: number
  /** Exponential decay time constant, seconds (larger = rings longer). */
  decay: number
}

export interface FmPianoOptions {
  /** Number of partials to synthesize. */
  partialCount: number
  /** Inharmonicity coefficient B: ratio_k = k·√(1 + B·k²). */
  inharmonicity: number
  /** Amplitude roll-off exponent: amp_k ∝ 1/k^tilt (higher = darker). */
  tilt: number
  /** Fundamental decay time, seconds. */
  baseDecay: number
}

/**
 * Register-dependent defaults. Low notes get fewer partials, a steeper tilt
 * (darker, rounder), more inharmonicity (thick bass strings) and a longer ring;
 * high notes get a brighter, shorter tone.
 */
export function pianoOptionsForMidi(midi: Midi): FmPianoOptions {
  // Map roughly A0 (21) .. C7 (96) onto 0..1.
  const t = Math.min(1, Math.max(0, (midi - 21) / (96 - 21)))
  return {
    partialCount: Math.round(16 - 8 * t), // 16 (bass) .. 8 (treble)
    inharmonicity: 0.0009 - 0.0006 * t, // thicker (more stretch) in the bass
    tilt: 1.55 - 0.35 * t, // 1.55 (dark bass) .. 1.20 (brighter treble)
    baseDecay: 2.6 - 1.4 * t, // 2.6 s (bass ring) .. 1.2 s (treble)
  }
}

/**
 * The partial structure (ratios/amps/decays) for a piano note. Exposed for
 * testing: the fundamental is loudest, ratios increase (stretched sharp), and
 * higher partials decay faster.
 */
export function pianoPartials(opts: FmPianoOptions): Partial[] {
  const partials: Partial[] = []
  for (let k = 1; k <= opts.partialCount; k += 1) {
    const ratio = k * Math.sqrt(1 + opts.inharmonicity * k * k)
    const amp = 1 / Math.pow(k, opts.tilt)
    // Higher partials decay faster: decay_k = baseDecay / (1 + 0.55·(k-1)).
    const decay = opts.baseDecay / (1 + 0.55 * (k - 1))
    partials.push({ ratio, amp, decay })
  }
  return partials
}

/**
 * Render a piano note of `midi` for `seconds` at `sampleRate`. Partials above
 * ~Nyquist are skipped (anti-aliasing). Sines start at phase 0, so the buffer
 * begins at silence (no attack click); it is peak-normalized and tail-faded.
 */
export function renderFmPiano(
  midi: Midi,
  seconds: number,
  sampleRate: number,
  opts: FmPianoOptions,
): Float32Array {
  const total = Math.max(1, Math.round(seconds * sampleRate))
  const out = new Float32Array(total)

  const f0 = midiToFreq(midi)
  const nyquist = sampleRate * 0.45
  const partials = pianoPartials(opts).filter((p) => p.ratio * f0 < nyquist)
  const twoPiOverSr = (2 * Math.PI) / sampleRate

  // A gentle 3 ms attack curve avoids a first-derivative thump when several
  // partials swing up together, without softening the perceived strike.
  const attackSamples = Math.max(1, Math.round(0.003 * sampleRate))

  for (const p of partials) {
    const omega = twoPiOverSr * f0 * p.ratio
    const decayPerSample = 1 / (p.decay * sampleRate)
    for (let n = 0; n < total; n += 1) {
      const env = Math.exp(-n * decayPerSample)
      const attack = n < attackSamples ? (n + 1) / attackSamples : 1
      out[n] = (out[n] ?? 0) + p.amp * env * attack * Math.sin(omega * n)
    }
  }

  // Same normalization basis as the pluck (99th-percentile + soft-knee) so the
  // two rendered voices sit at a consistent level; the piano's lower crest
  // factor means the soft clip barely engages.
  normalizePercentile(out, 0.99, 0.62)
  softClip(out, 0.62)
  fadeOutTail(out, sampleRate)
  return out
}
