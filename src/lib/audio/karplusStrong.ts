/**
 * Karplus-Strong plucked-string synthesis, rendered to a mono sample buffer.
 *
 * PURE: no Web Audio, no `window`. The engine fills an `AudioBuffer` with the
 * `Float32Array` this returns and plays it through an `AudioBufferSourceNode`,
 * so all of the timbral DSP is unit-testable under the `node` env.
 *
 * The model is a feedback delay line excited by a short noise burst. The
 * earlier version sounded clangy/metallic; this one is built to sound like a
 * real plucked string:
 *
 *  - EXCITATION is not raw white noise (whose flat, harsh spectrum is what
 *    reads as "metal zing"). The seed is passed through TWO cascaded one-pole
 *    low-passes (a pink-ish 12 dB/oct roll-off, darker in the bass) and then a
 *    PICK-POSITION comb filter — subtracting a copy delayed by `p·period`
 *    (p ≈ 0.15) notches out the harmonics the string cannot excite at the pick
 *    point, exactly as on a real instrument. Together these tame the harsh
 *    even-spectrum attack.
 *  - The LOOP is a fractional (linearly interpolated) delay for accurate tuning,
 *    a fixed TWO-POINT AVERAGER (extra gentle high roll-off that kills the
 *    Nyquist-region ring), and a TUNABLE ONE-POLE DAMPING low-pass whose cutoff
 *    DECAYS over the note (dynamic damping): the brightness dies faster than the
 *    amplitude, like a real string, instead of a static metallic buzz. The
 *    filters' group delay is compensated in the read distance so damping does
 *    not detune the note.
 *  - A feedback gain `R < 1` sets the fundamental decay time. Bass notes get a
 *    dark, warm, long sustain; guitar notes are brighter but never clangy.
 *  - A subtle BODY resonance (one low-mid resonant band, mixed low) adds a
 *    little woodiness without muddying the fundamental.
 *  - A short raised-cosine ATTACK fade rounds the very first samples so the
 *    pluck has no click while keeping its percussive transient.
 */

import { midiToFreq, type Midi } from '../theory/notes.ts'
import { fadeInAttack, fadeOutTail, normalizePercentile, removeDc, softClip } from './voices.ts'

export interface KarplusStrongOptions {
  /**
   * 0..1 loop low-pass openness. Lower = darker, faster high-frequency decay
   * (bass); higher = brighter, more sustained overtones (guitar). Even at the
   * top of the range the tone is kept well short of a metallic buzz.
   */
  brightness: number
  /** Approximate fundamental decay time to -60 dB, seconds. */
  decaySeconds: number
  /** Seed for the excitation noise, so renders are deterministic (tests). */
  seed: number
  /**
   * Pick position as a fraction of the string length, 0.08..0.3. Sets the
   * comb-filter notch spacing; ~0.13–0.25 is a natural plucked-string range.
   * Default 0.15.
   */
  pickPosition?: number
  /**
   * Fundamental reinforcement, 0..1 (0 disables it). Blends a decaying sine at
   * f0 into the string signal — the "body/soundboard" contribution that makes an
   * acoustic tone fundamental-forward and warm, and keeps low bass notes from
   * being dominated by their 2nd/3rd harmonic. Default 0.5.
   */
  bodyMix?: number
  /** Pick-position comb depth, 0..1 (0 disables the comb). Default 0.55. */
  combDepth?: number
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
 * Register-dependent defaults. A low bass note is dark, warm and long-ringing
 * (fundamental-dominant, minimal high-frequency energy); a high guitar note is
 * brighter but with a brightness that still decays quickly. `midi` 28 ≈ E1,
 * 40 ≈ E2 (bass low E), 64 ≈ E4 (guitar high open E area), 76 ≈ E5.
 */
export function pluckOptionsForMidi(midi: Midi): KarplusStrongOptions {
  // Map roughly E1 (28) .. E5 (76) onto 0..1.
  const t = Math.min(1, Math.max(0, (midi - 28) / (76 - 28)))
  return {
    // Kept low overall so nothing gets metallic; guitar tops out well short of
    // a fully open loop.
    brightness: 0.16 + 0.34 * t, // 0.16 (dark bass) .. 0.50 (bright guitar)
    // Bass rings LONG and warm; guitar sustains a bit less. Both feel natural.
    decaySeconds: 3.4 - 1.0 * t, // 3.4 s (bass) .. 2.4 s (guitar)
    // A near-central pluck low down keeps the fundamental dominant (warm, round
    // bass); moving toward the bridge up high adds a little harmonic definition
    // without ever getting thin/clangy. Larger p ⇒ more fundamental-forward.
    pickPosition: 0.44 - 0.12 * t, // 0.44 (bass) .. 0.32 (guitar)
    // Reinforce the fundamental more in the bass (warm, round) than in the
    // guitar register (let the string's own harmonics speak).
    bodyMix: 2.2 - 1.4 * t, // 2.2 (bass) .. 0.8 (guitar)
    seed: 0x51ed + midi,
  }
}

/** One-pole low-pass coefficient (0..1) from the brightness control. */
function dampingCoeff(brightness: number): number {
  const b = Math.min(1, Math.max(0, brightness))
  // 0.22 (heavy low-pass, dark) .. 0.62 (brighter). Deliberately never fully
  // open — an open loop is what rings metallically.
  return 0.22 + 0.4 * b
}

/**
 * Render a Karplus-Strong pluck of `midi` for `seconds` at `sampleRate`.
 * The returned buffer is DC-free, peak-normalized (99th percentile + soft knee)
 * and tail-faded so it never clicks when the source stops.
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
  const b = Math.min(1, Math.max(0, opts.brightness))

  // One-pole damping low-pass: y += damp*(x - y). Its cutoff decays over the
  // note (dynamic damping): brightness dies faster than amplitude. Read-distance
  // compensation uses the INITIAL damping (the loud attack sets perceived
  // pitch); the small pitch flattening as it darkens is musically natural and
  // well within tuning tolerance.
  const damp0 = dampingCoeff(opts.brightness)
  const dampEnd = damp0 * 0.6 // darken toward the tail
  const dampSpan = damp0 - dampEnd
  const dampTau = 0.25 * sampleRate // ~250 ms brightness decay
  // Loop group delay = one-pole ((1-d)/d) + two-point averager (0.5 sample).
  const lpGroupDelay = (1 - damp0) / damp0
  const readDelay = Math.max(1, period - lpGroupDelay - 0.5)

  const bufLen = Math.max(4, Math.ceil(readDelay) + 2)
  const buf = new Float32Array(bufLen)

  // --- Excitation: pink-ish (two cascaded one-poles) low-passed noise, darker
  // in the bass, then a pick-position comb filter. Fill the whole delay line.
  const rng = mulberry32(opts.seed)
  const exCoef = 0.12 + 0.45 * b // darker excitation low down
  let s1 = 0
  let s2 = 0
  const noise = new Float32Array(bufLen)
  for (let i = 0; i < bufLen; i += 1) {
    const white = rng() * 2 - 1
    s1 += exCoef * (white - s1)
    s2 += exCoef * (s1 - s2)
    noise[i] = s2
  }
  // Pick-position comb: subtract a copy delayed by p·period samples. Notches
  // the harmonics near n/p, killing the harsh full-spectrum attack.
  const pickP = Math.min(0.5, Math.max(0.08, opts.pickPosition ?? 0.35))
  const pickDelay = Math.max(1, Math.min(bufLen - 1, Math.round(period * pickP)))
  // Partial-depth comb: notches the pick-point harmonics without fully nulling
  // any, so the fundamental is never gouged out. Kept shallow so it removes the
  // harsh even-spectrum attack without boosting a mid harmonic over the
  // fundamental.
  const combDepth = Math.min(1, Math.max(0, opts.combDepth ?? 0.55))
  for (let i = 0; i < bufLen; i += 1) {
    buf[i] = (noise[i] ?? 0) - combDepth * (i >= pickDelay ? (noise[i - pickDelay] ?? 0) : 0)
  }
  removeDc(buf)

  // Feedback gain for the target fundamental decay: A[n] = R·A[n-period], so
  // over `decaySeconds·f0` periods R^(decaySeconds·f0) = 1e-3 (≈ -60 dB).
  const R = Math.exp(Math.log(0.001) / Math.max(1, opts.decaySeconds * f0))

  let writePos = 0
  let lpState = 0
  let prevDelayed = 0
  for (let n = 0; n < total; n += 1) {
    // Fractional (linearly interpolated) read `readDelay` samples behind write.
    let readPos = writePos - readDelay
    while (readPos < 0) readPos += bufLen
    const i0 = Math.floor(readPos)
    const i1 = (i0 + 1) % bufLen
    const g = readPos - i0
    const delayed = (buf[i0] ?? 0) * (1 - g) + (buf[i1] ?? 0) * g

    // Two-point averager (fixed gentle roll-off) feeding the dynamic one-pole.
    const avg = 0.5 * (delayed + prevDelayed)
    prevDelayed = delayed
    const damp = dampEnd + dampSpan * Math.exp(-n / dampTau)
    lpState += damp * (avg - lpState)

    out[n] = lpState
    buf[writePos] = R * lpState
    writePos = (writePos + 1) % bufLen
  }

  // --- Fundamental reinforcement: boost the fundamental region with a
  // resonant band (RBJ 0-dB-peak bandpass) centered at f0, added at `bodyMix`.
  // Because it filters the ACTUAL signal it tracks the string's true (slightly
  // dynamically-detuned) fundamental — so it reinforces in phase instead of
  // beating against a fixed sine — and, being a filter, it does not add its own
  // sustain, preserving the pluck's natural decay. This keeps low bass notes
  // fundamental-forward (warm, round) rather than dominated by a 2nd/3rd
  // harmonic, and adds body across the range.
  const bodyMix = Math.min(4, Math.max(0, opts.bodyMix ?? 0))
  if (bodyMix > 0) {
    const w0 = (2 * Math.PI * f0) / sampleRate
    const cw = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * 3) // Q ≈ 3
    const a0 = 1 + alpha
    const bp0 = alpha / a0
    const bp2 = -alpha / a0
    const a1 = (-2 * cw) / a0
    const a2 = (1 - alpha) / a0
    let x1 = 0
    let x2 = 0
    let y1 = 0
    let y2 = 0
    for (let n = 0; n < total; n += 1) {
      const x0 = out[n] ?? 0
      const y0 = bp0 * x0 + bp2 * x2 - a1 * y1 - a2 * y2
      x2 = x1
      x1 = x0
      y2 = y1
      y1 = y0
      out[n] = x0 + bodyMix * y0
    }
  }

  removeDc(out)
  // Round the very first samples so the pluck transient has no click, keeping
  // it percussive (~2.5 ms).
  fadeInAttack(out, sampleRate, 0.0025)
  // The attack is a lone transient above the sustained tone: normalize to the
  // 99th percentile so the body of the note is loud, and soft-clip the tip
  // below full scale — no crushing, no hard clip. Same basis as the piano voice
  // so the two rendered voices sit at a consistent level.
  normalizePercentile(out, 0.99, 0.62)
  softClip(out, 0.62)
  fadeOutTail(out, sampleRate)
  return out
}
