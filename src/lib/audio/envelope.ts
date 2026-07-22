/**
 * Pure ADSR envelope + timing math for the audio engine.
 *
 * This file contains NO Web Audio calls and never touches `window` — it only
 * computes the gain-automation *plan* (a list of scheduling points) for a note.
 * The engine then replays that plan onto a real `AudioParam`. Keeping the math
 * here means it is fully unit-testable under the `node` test environment.
 *
 * All times are absolute AudioContext timestamps (seconds); levels are linear
 * gain in the range 0..1.
 */

/** Attack/decay/release in seconds; sustain as a 0..1 fraction of the peak. */
export interface AdsrParams {
  /** Time from note-on to peak, seconds. */
  attack: number
  /** Time from peak down to the sustain level, seconds. */
  decay: number
  /** Held level as a fraction of the peak, 0..1. */
  sustain: number
  /** Time from note-off (gate end) down to silence, seconds. */
  release: number
}

/** Musical defaults: a quick pluck-ish attack with a short tail. */
export const DEFAULT_ADSR: AdsrParams = {
  attack: 0.005,
  decay: 0.09,
  sustain: 0.7,
  release: 0.15,
}

/** A single gain-automation instruction at an absolute time. */
export interface EnvelopePoint {
  /** Absolute AudioContext time in seconds. */
  time: number
  /** Target linear gain. */
  value: number
  /**
   * `set` snaps the value at `time`; `linear` ramps to it from the previous
   * point. The first point is always a `set` so there is a defined anchor.
   */
  ramp: 'set' | 'linear'
}

/** The full plan for one note: ordered points plus when the source may stop. */
export interface EnvelopeAutomation {
  points: EnvelopePoint[]
  /** Absolute time at which the oscillator(s) can be stopped/disconnected. */
  stopTime: number
}

export interface EnvelopeInput {
  /** Note-on time (absolute). */
  startTime: number
  /** Gate length: how long the note is held before release begins. */
  duration: number
  /** Peak linear gain (velocity already applied). */
  peak: number
  params: AdsrParams
}

/** Clamp a number into the inclusive 0..1 range. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Map a 0..1 velocity to a linear gain. A mild curve makes low velocities
 * quieter in a way that reads as more natural than a straight line.
 */
export function velocityToGain(velocity: number): number {
  const v = clamp01(velocity)
  return v * v
}

/** Merge a partial ADSR onto the defaults, clamping to sane, non-negative values. */
export function resolveAdsr(partial: Partial<AdsrParams> = {}): AdsrParams {
  return {
    attack: Math.max(0, partial.attack ?? DEFAULT_ADSR.attack),
    decay: Math.max(0, partial.decay ?? DEFAULT_ADSR.decay),
    sustain: clamp01(partial.sustain ?? DEFAULT_ADSR.sustain),
    release: Math.max(0, partial.release ?? DEFAULT_ADSR.release),
  }
}

/**
 * The envelope's linear gain at an absolute time `t`, assuming the note is
 * still gated (no release). Used to find the level at which release begins so
 * the release ramp starts from wherever the envelope actually is — even if the
 * gate ended mid-attack or mid-decay — which keeps it click-free.
 */
export function envelopeValueAt(t: number, startTime: number, peak: number, params: AdsrParams): number {
  if (t <= startTime) return 0
  const { attack, decay, sustain } = params
  const sustainLevel = peak * sustain
  const attackEnd = startTime + attack
  if (t < attackEnd) {
    return attack === 0 ? peak : (peak * (t - startTime)) / attack
  }
  const decayEnd = attackEnd + decay
  if (t < decayEnd) {
    return decay === 0 ? sustainLevel : peak + ((sustainLevel - peak) * (t - attackEnd)) / decay
  }
  return sustainLevel
}

/**
 * Build the gain-automation plan for one note. The returned points always
 * start and end at 0 (silence in, silence out) so no clicks are produced, and
 * `stopTime` is exactly when the tail reaches silence.
 */
export function computeEnvelope(input: EnvelopeInput): EnvelopeAutomation {
  const { startTime, peak } = input
  const params = input.params
  const duration = Math.max(0, input.duration)
  const gateEnd = startTime + duration
  const attackEnd = startTime + params.attack
  const decayEnd = attackEnd + params.decay
  const sustainLevel = peak * params.sustain

  const points: EnvelopePoint[] = []
  const push = (point: EnvelopePoint): void => {
    const last = points[points.length - 1]
    if (last && point.time <= last.time) {
      // Collapse points that land on the same instant onto a single anchor so
      // we never schedule a zero-length ramp.
      last.value = point.value
      return
    }
    points.push(point)
  }

  // Anchor at silence, then walk whichever gate-phase boundaries fall before
  // the gate ends.
  push({ time: startTime, value: 0, ramp: 'set' })
  if (attackEnd < gateEnd) {
    push({ time: attackEnd, value: peak, ramp: 'linear' })
    if (decayEnd < gateEnd) {
      push({ time: decayEnd, value: sustainLevel, ramp: 'linear' })
    }
  }

  // Release: ramp from the actual level at gate end down to silence.
  const releaseLevel = envelopeValueAt(gateEnd, startTime, peak, params)
  push({ time: gateEnd, value: releaseLevel, ramp: 'linear' })
  const stopTime = gateEnd + params.release
  push({ time: stopTime, value: 0, ramp: 'linear' })

  return { points, stopTime }
}
