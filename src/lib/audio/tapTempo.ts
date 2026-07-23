/**
 * Pure tap-tempo math. The metronome UI feeds this the timestamps of the
 * user's taps (in milliseconds, e.g. from `performance.now()`); this file owns
 * all the logic — trimming to the most recent taps, resetting after a pause,
 * and averaging the intervals into a BPM. No React, no timers, no `window`, so
 * it runs and is tested under the `node` environment.
 */

/** How many recent taps are averaged. Older taps are dropped. */
export const MAX_TAPS = 5

/**
 * A gap longer than this (ms) between taps starts a fresh measurement, so an
 * old, abandoned tap sequence never drags the tempo estimate.
 */
export const TAP_RESET_GAP_MS = 2000

export interface TapTempoOptions {
  /** Max taps to keep and average. Default `MAX_TAPS` (5). */
  maxTaps?: number
  /** Gap (ms) after which taps reset. Default `TAP_RESET_GAP_MS` (2000). */
  resetGapMs?: number
}

export interface TapTempoResult {
  /** The retained tap timestamps after this tap (newest last). */
  taps: number[]
  /** Averaged tempo in BPM, or `null` until at least two taps are held. */
  bpm: number | null
}

/**
 * Average the intervals between tap timestamps into a BPM. Returns `null` for
 * fewer than two taps or a non-positive average interval (duplicate/out-of-
 * order timestamps).
 */
export function bpmFromTaps(taps: readonly number[]): number | null {
  if (taps.length < 2) return null
  let total = 0
  for (let i = 1; i < taps.length; i += 1) {
    total += taps[i]! - taps[i - 1]!
  }
  const avgInterval = total / (taps.length - 1)
  if (avgInterval <= 0) return null
  return 60000 / avgInterval
}

/**
 * Register a tap at time `now` (ms) given the previously retained taps, and
 * return the new retained taps plus the current BPM estimate. Pure: the input
 * array is never mutated.
 *
 * If more than `resetGapMs` has elapsed since the last tap the sequence resets
 * and this tap becomes the first of a new measurement (so `bpm` is `null`).
 */
export function registerTap(
  previousTaps: readonly number[],
  now: number,
  options: TapTempoOptions = {},
): TapTempoResult {
  const maxTaps = Math.max(2, Math.floor(options.maxTaps ?? MAX_TAPS))
  const resetGapMs = options.resetGapMs ?? TAP_RESET_GAP_MS

  const last = previousTaps[previousTaps.length - 1]
  const continued = last !== undefined && now - last <= resetGapMs ? previousTaps : []
  const taps = [...continued, now].slice(-maxTaps)

  return { taps, bpm: bpmFromTaps(taps) }
}
