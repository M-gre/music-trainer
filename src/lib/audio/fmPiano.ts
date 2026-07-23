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
import { fadeOutTail, normalizePercentile, removeDc, softClip } from './voices.ts'

/** Deterministic 32-bit PRNG (mulberry32) for the hammer-noise burst. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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
  /**
   * Hammer-strike transient amount, 0..1 (0 disables it). A short low-passed
   * noise "knock" that decays in ~30 ms, mixed at this level relative to the
   * tone's early peak — the percussive thump of the hammer hitting the string.
   */
  hammer: number
  /** Seed for the deterministic hammer-noise burst. */
  seed: number
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
    // A hair steeper so the fundamental sits more forward (rounder, less buzzy)
    // while brightening toward the treble.
    tilt: 1.7 - 0.4 * t, // 1.70 (dark bass) .. 1.30 (brighter treble)
    baseDecay: 3.0 - 1.7 * t, // 3.0 s (bass ring) .. 1.3 s (treble)
    // A touch more hammer knock low down (heavier hammers), less up high.
    hammer: 0.22 - 0.1 * t, // 0.22 (bass) .. 0.12 (treble)
    seed: 0x9e37 + midi,
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

  // --- Hammer-strike transient: a short low-passed noise "knock" decaying in
  // ~30 ms, added over the attack for the percussion of the hammer hitting the
  // string. Scaled to the tone's early peak so it stays proportionate, and its
  // low-pass darkens with the register (brighter knock up high). It rounds in
  // from a fade so it does not add a click, and is band-limited (no DC).
  const hammer = Math.min(1, Math.max(0, opts.hammer))
  if (hammer > 0) {
    const earlyN = Math.min(total, Math.round(0.02 * sampleRate))
    let earlyPeak = 0
    for (let i = 0; i < earlyN; i += 1) {
      const a = Math.abs(out[i] ?? 0)
      if (a > earlyPeak) earlyPeak = a
    }
    const amp = hammer * earlyPeak
    const rng = mulberry32(opts.seed)
    // A mid-band knock: brighter in the treble, warmer (but still present) in
    // the bass. One-pole low-pass keeps mid content so it reads as an attack.
    const lpCoef = 0.4 + 0.4 * Math.min(1, f0 / 900)
    const tau = 0.01 * sampleRate // ~10 ms time constant ⇒ ~30 ms audible
    const hammerN = Math.min(total, Math.round(0.045 * sampleRate))
    const rampN = Math.max(1, Math.round(0.001 * sampleRate))
    let s1 = 0
    for (let n = 0; n < hammerN; n += 1) {
      const white = rng() * 2 - 1
      s1 += lpCoef * (white - s1)
      const ramp = n < rampN ? (n + 1) / rampN : 1
      out[n] = (out[n] ?? 0) + amp * ramp * Math.exp(-n / tau) * s1
    }
    removeDc(out)
  }

  // Same normalization basis as the pluck (99th-percentile + soft-knee) so the
  // two rendered voices sit at a consistent level; the piano's lower crest
  // factor means the soft clip barely engages.
  normalizePercentile(out, 0.99, 0.62)
  softClip(out, 0.62)
  fadeOutTail(out, sampleRate)
  return out
}
