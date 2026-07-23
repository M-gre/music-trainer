/**
 * Instrument voice identity, DSP signal helpers, and perceptual level
 * normalization shared by the synthesized voices.
 *
 * This file is PURE — no Web Audio, no `window` — so it is fully unit-testable
 * under the `node` test environment. The engine imports the render functions
 * (`karplusStrong.ts`, `fmPiano.ts`) and these helpers to build buffers; the
 * per-voice peak-gain trims below keep the three voices at a comparable
 * loudness (validated against measured RMS in `voices.test.ts`).
 */

/**
 * The three synthesized note voices:
 *  - `pluck`  — Karplus-Strong plucked string (bass/guitar).
 *  - `piano`  — additive/FM-style struck-string tone (keyboard).
 *  - `classic`— the original dual detuned-sawtooth synth.
 */
export const VOICE_NAMES = ['pluck', 'piano', 'classic'] as const
export type VoiceName = (typeof VOICE_NAMES)[number]

/** Human-facing label + one-line description for each voice (settings UI). */
export const VOICE_INFO: Record<VoiceName, { label: string; description: string }> = {
  pluck: {
    label: 'Plucked string',
    description: 'Karplus-Strong string synthesis — natural pluck attack and decay.',
  },
  piano: {
    label: 'Piano',
    description: 'Additive struck-string tone — rounded, with fast-decaying overtones.',
  },
  classic: {
    label: 'Classic synth',
    description: 'The original dual detuned-sawtooth synth.',
  },
}

/** Whether an arbitrary value names a known voice. */
export function isVoiceName(value: unknown): value is VoiceName {
  return typeof value === 'string' && (VOICE_NAMES as readonly string[]).includes(value)
}

// --- Signal helpers (pure) --------------------------------------------------

/** Root-mean-square level of a sample buffer (0 for an empty buffer). */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0
    sum += x * x
  }
  return Math.sqrt(sum / samples.length)
}

/** Largest absolute sample value (0 for an empty buffer). */
export function peakAmplitude(samples: Float32Array): number {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const a = Math.abs(samples[i] ?? 0)
    if (a > peak) peak = a
  }
  return peak
}

/** Mean sample value — the DC offset. Should sit near 0 for a clean voice. */
export function dcOffset(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] ?? 0
  return sum / samples.length
}

/** Subtract the mean in place so the buffer has ~zero DC offset. */
export function removeDc(samples: Float32Array): void {
  const mean = dcOffset(samples)
  if (mean === 0) return
  for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) - mean
}

/** Scale in place so the largest absolute value equals `target` (default 1). */
export function normalizePeak(samples: Float32Array, target = 1): void {
  const peak = peakAmplitude(samples)
  if (peak === 0) return
  const scale = target / peak
  for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * scale
}

/** The absolute value at the given percentile (0..1) of `samples`. */
export function amplitudePercentile(samples: Float32Array, percentile: number): number {
  if (samples.length === 0) return 0
  const abs = Array.from(samples, (x) => Math.abs(x)).sort((a, b) => a - b)
  const idx = Math.min(abs.length - 1, Math.max(0, Math.round(percentile * (abs.length - 1))))
  return abs[idx] ?? 0
}

/**
 * Scale in place so the given `percentile` of absolute values maps to `target`.
 * A plucked string's attack is a lone transient spike far above the sustained
 * tone; normalizing to the absolute peak would crush the note, so we normalize
 * to (say) the 99th percentile and let `softClip` fold the transient tip.
 */
export function normalizePercentile(samples: Float32Array, percentile: number, target: number): void {
  const ref = amplitudePercentile(samples, percentile)
  if (ref === 0) return
  const scale = target / ref
  for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * scale
}

/**
 * Soft-knee limiter in place: values with |x| ≤ `threshold` pass through
 * linearly; larger magnitudes are folded smoothly into `[threshold, 1)` with a
 * tanh knee. Keeps a transient's tip below full scale (no hard clip) while
 * leaving the body of the signal untouched.
 */
export function softClip(samples: Float32Array, threshold: number): void {
  const t = Math.min(0.999, Math.max(0, threshold))
  const range = 1 - t
  for (let i = 0; i < samples.length; i += 1) {
    const x = samples[i] ?? 0
    const mag = Math.abs(x)
    if (mag <= t || range === 0) continue
    const folded = t + range * Math.tanh((mag - t) / range)
    samples[i] = Math.sign(x) * folded
  }
}

/**
 * Apply a short raised-cosine fade-in over the first `seconds` in place. Used to
 * tame a synthesis model's initial transient (e.g. the Karplus-Strong noise
 * burst) so it does not dominate the peak — keeping a percussive but un-spiky
 * attack and a usable sustained level after peak-normalization.
 */
export function fadeInAttack(samples: Float32Array, sampleRate: number, seconds: number): void {
  const fade = Math.min(samples.length, Math.max(1, Math.round(seconds * sampleRate)))
  for (let i = 0; i < fade; i += 1) {
    const gain = 0.5 - 0.5 * Math.cos((Math.PI * (i + 1)) / fade)
    samples[i] = (samples[i] ?? 0) * gain
  }
}

/**
 * Apply a short linear fade at the tail (last `seconds`) so a decaying buffer
 * never ends on a non-zero sample — which would click when the source stops.
 */
export function fadeOutTail(samples: Float32Array, sampleRate: number, seconds = 0.006): void {
  const fade = Math.min(samples.length, Math.max(1, Math.round(seconds * sampleRate)))
  const start = samples.length - fade
  for (let i = 0; i < fade; i += 1) {
    const gain = 1 - (i + 1) / fade
    const idx = start + i
    samples[idx] = (samples[idx] ?? 0) * gain
  }
}

/**
 * Estimate the fundamental frequency (Hz) of a buffer via autocorrelation over
 * an early window (where the note is loudest). Searches lags corresponding to
 * `minHz..maxHz`. Returns 0 if no positive-lag peak is found. Used by tests to
 * assert a voice's dominant period ≈ 1/f0.
 */
export function dominantFrequency(
  samples: Float32Array,
  sampleRate: number,
  opts: { minHz?: number; maxHz?: number; windowSize?: number } = {},
): number {
  const minHz = opts.minHz ?? 20
  const maxHz = opts.maxHz ?? 2000
  const window = Math.min(samples.length, opts.windowSize ?? 8192)
  if (window < 4) return 0
  const minLag = Math.max(1, Math.floor(sampleRate / maxHz))
  const maxLag = Math.min(window - 1, Math.ceil(sampleRate / minHz))
  let bestLag = 0
  let bestCorr = -Infinity
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let corr = 0
    for (let i = 0; i + lag < window; i += 1) {
      corr += (samples[i] ?? 0) * (samples[i + lag] ?? 0)
    }
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }
  return bestLag > 0 ? sampleRate / bestLag : 0
}

/**
 * Goertzel power (squared magnitude) of `samples` at a single frequency `freq`.
 * O(N) per frequency — cheaper than a full FFT when only a handful of bins are
 * needed, and implementable in pure TS. Used by the spectral test helpers below.
 */
export function goertzelPower(samples: Float32Array, sampleRate: number, freq: number): number {
  const omega = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(omega)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < samples.length; i += 1) {
    const s0 = (samples[i] ?? 0) + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/** A Hann-windowed copy of `samples` (reduces spectral leakage in the DFT bins). */
function hannWindowed(samples: Float32Array): Float32Array {
  const n = samples.length
  const out = new Float32Array(n)
  if (n < 2) {
    out.set(samples)
    return out
  }
  for (let i = 0; i < n; i += 1) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    out[i] = (samples[i] ?? 0) * w
  }
  return out
}

/** Power at each of `freqs`, on a Hann-windowed copy of `samples`. */
function powerAtFreqs(samples: Float32Array, sampleRate: number, freqs: number[]): number[] {
  const windowed = hannWindowed(samples)
  return freqs.map((f) => goertzelPower(windowed, sampleRate, f))
}

/**
 * Spectral centroid (Hz) of `samples` — the power-weighted mean frequency, a
 * standard proxy for perceived brightness. Estimated over `bins` linearly
 * spaced Goertzel bins up to `maxHz`. Used by tests to cap a voice's brightness
 * per register (a clangy/metallic tone has an abnormally high centroid).
 */
export function spectralCentroid(
  samples: Float32Array,
  sampleRate: number,
  opts: { maxHz?: number; bins?: number } = {},
): number {
  const maxHz = Math.min(sampleRate / 2, opts.maxHz ?? 12000)
  const bins = opts.bins ?? 96
  const freqs: number[] = []
  for (let b = 1; b <= bins; b += 1) freqs.push((b / bins) * maxHz)
  const powers = powerAtFreqs(samples, sampleRate, freqs)
  let num = 0
  let den = 0
  for (let b = 0; b < bins; b += 1) {
    const p = powers[b] ?? 0
    num += (freqs[b] ?? 0) * p
    den += p
  }
  return den > 0 ? num / den : 0
}

/**
 * Fraction (0..1) of spectral power at or above `cutoffHz`. Used to assert that
 * a bass note carries almost no energy in the high treble (the "zing" band).
 */
export function energyFractionAbove(
  samples: Float32Array,
  sampleRate: number,
  cutoffHz: number,
  opts: { maxHz?: number; bins?: number } = {},
): number {
  const maxHz = Math.min(sampleRate / 2, opts.maxHz ?? 15000)
  const bins = opts.bins ?? 160
  const freqs: number[] = []
  for (let b = 1; b <= bins; b += 1) freqs.push((b / bins) * maxHz)
  const powers = powerAtFreqs(samples, sampleRate, freqs)
  let above = 0
  let total = 0
  for (let b = 0; b < bins; b += 1) {
    const p = powers[b] ?? 0
    total += p
    if ((freqs[b] ?? 0) >= cutoffHz) above += p
  }
  return total > 0 ? above / total : 0
}

// --- Perceptual level normalization -----------------------------------------

/**
 * Per-voice peak linear gain applied at the voice's gain node — the RMS-based
 * loudness trim that keeps the three voices consistent with one another (and
 * with the percussive voices, whose peak layer gains sit around 0.3–0.6).
 *
 * The buffer voices (`pluck`, `piano`) are normalized to the same
 * 99th-percentile level in their render, so they already sit close; a plucked
 * string is peakier (higher crest factor) than the dense `classic` saw pair, so
 * `classic` is trimmed well down from its raw level to match. With these trims
 * all three land at ≈0.15 effective RMS — within ±20% of one another, verified
 * in `voices.test.ts` — and every single note peaks below full scale, leaving
 * headroom for chords + the master limiter.
 */
export const VOICE_PEAK: Record<VoiceName, number> = {
  classic: 0.18,
  pluck: 0.95,
  piano: 0.51,
}
