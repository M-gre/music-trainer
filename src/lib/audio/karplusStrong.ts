/**
 * Karplus-Strong plucked-string synthesis, rendered to a mono sample buffer.
 *
 * PURE: no Web Audio, no `window`. The engine fills an `AudioBuffer` with the
 * `Float32Array` this returns and plays it through an `AudioBufferSourceNode`,
 * so all of the timbral DSP is unit-testable under the `node` env.
 *
 * The model is a feedback delay line excited by a short noise burst:
 *  - The delay-line length sets the pitch. A *fractional* (linearly
 *    interpolated) read gives accurate tuning at all pitches — an integer-only
 *    delay would be tens of cents sharp/flat in the guitar register.
 *  - A one-pole low-pass in the feedback loop is the "damping": it rolls off
 *    the high partials over time (the string losing energy), and its cutoff is
 *    the `brightness` control. Its group delay is compensated in the read
 *    distance so damping does not detune the note.
 *  - A feedback gain `R < 1` sets the overall (fundamental) decay time.
 *
 * `pluckOptionsForMidi` picks a darker/shorter voice in the bass register and a
 * brighter/longer one up in the guitar register.
 */

import { midiToFreq, type Midi } from '../theory/notes.ts'
import { fadeInAttack, fadeOutTail, normalizePercentile, removeDc, softClip } from './voices.ts'

export interface KarplusStrongOptions {
  /**
   * 0..1 loop low-pass openness. Lower = darker, faster high-frequency decay
   * (bass); higher = brighter, more sustained overtones (guitar).
   */
  brightness: number
  /** Approximate fundamental decay time to -60 dB, seconds. */
  decaySeconds: number
  /** Seed for the excitation noise, so renders are deterministic (tests). */
  seed: number
}

/** Deterministic 32-bit PRNG (mulberry32) returning floats in [0, 1). */
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

/**
 * Register-dependent defaults: a low bass note gets a dull, quickly-damped
 * pluck; a high guitar note gets a bright, ringing one. `midi` 40 ≈ E2 (bass
 * low E), 64 ≈ E4 (guitar high open E area).
 */
export function pluckOptionsForMidi(midi: Midi): KarplusStrongOptions {
  // Map roughly E1 (28) .. E5 (76) onto 0..1.
  const t = Math.min(1, Math.max(0, (midi - 28) / (76 - 28)))
  return {
    brightness: 0.32 + 0.4 * t, // 0.32 (dark bass) .. 0.72 (bright guitar)
    decaySeconds: 1.4 + 1.4 * t, // 1.4 s (bass) .. 2.8 s (guitar ring)
    seed: 0x51ed + midi,
  }
}

/** One-pole low-pass coefficient (0..1) from the brightness control. */
function dampingCoeff(brightness: number): number {
  const b = Math.min(1, Math.max(0, brightness))
  // 0.30 (heavy low-pass, dark) .. 0.85 (mostly open, bright).
  return 0.3 + 0.55 * b
}

/**
 * Render a Karplus-Strong pluck of `midi` for `seconds` at `sampleRate`.
 * The returned buffer is DC-free, peak-normalized to 1.0, and tail-faded so it
 * never clicks when the source stops.
 */
export function renderKarplusStrong(
  midi: Midi,
  seconds: number,
  sampleRate: number,
  opts: KarplusStrongOptions,
): Float32Array {
  const total = Math.max(1, Math.round(seconds * sampleRate))
  const out = new Float32Array(total)

  const f0 = midiToFreq(midi)
  const period = sampleRate / f0

  // One-pole damping low-pass: y += damp*(x - y). Its DC group delay is
  // (1 - damp)/damp samples; subtract it from the read distance so the loop's
  // total delay stays exactly one period (accurate pitch).
  const damp = dampingCoeff(opts.brightness)
  const lpGroupDelay = (1 - damp) / damp
  const readDelay = Math.max(1, period - lpGroupDelay)

  const bufLen = Math.max(2, Math.ceil(readDelay) + 2)
  const buf = new Float32Array(bufLen)

  // Excitation: a noise burst, pre-low-passed for darker registers so the
  // initial pluck is duller in the bass. Fill the whole delay line.
  const rng = mulberry32(opts.seed)
  const exciteLp = 0.2 + 0.6 * Math.min(1, Math.max(0, opts.brightness))
  let ex = 0
  for (let i = 0; i < bufLen; i += 1) {
    const white = rng() * 2 - 1
    ex += exciteLp * (white - ex)
    buf[i] = ex
  }
  removeDc(buf)

  // Feedback gain for the target fundamental decay. A sample written now
  // recirculates once per period (~`readDelay` samples), so the amplitude
  // envelope obeys A[n] = R·A[n-readDelay] ⇒ A decays by R once per period.
  // Over `decaySeconds` there are `decaySeconds·f0` periods, so choose R for
  // R^(decaySeconds·f0) = 1e-3 (≈ -60 dB).
  const R = Math.exp(Math.log(0.001) / Math.max(1, opts.decaySeconds * f0))

  let writePos = 0
  let lpState = 0
  for (let n = 0; n < total; n += 1) {
    // Fractional (linearly interpolated) read `readDelay` samples behind write.
    let readPos = writePos - readDelay
    while (readPos < 0) readPos += bufLen
    const i0 = Math.floor(readPos)
    const i1 = (i0 + 1) % bufLen
    const g = readPos - i0
    const delayed = (buf[i0] ?? 0) * (1 - g) + (buf[i1] ?? 0) * g

    // Loop low-pass (damping) and feedback.
    lpState += damp * (delayed - lpState)
    out[n] = lpState
    buf[writePos] = R * lpState
    writePos = (writePos + 1) % bufLen
  }

  removeDc(out)
  // Soften the raw excitation spike (a broadband noise burst peaks far above
  // the settled tone). A ~4 ms attack keeps the pluck percussive while lowering
  // the crest factor.
  fadeInAttack(out, sampleRate, 0.004)
  // The attack is a lone transient far above the sustained tone. Normalize to
  // the 99th percentile (so the body of the note is loud) and soft-clip the
  // transient tip below full scale — no crushing, no hard clip.
  normalizePercentile(out, 0.99, 0.62)
  softClip(out, 0.62)
  fadeOutTail(out, sampleRate)
  return out
}
