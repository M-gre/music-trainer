/**
 * Shared spaced-repetition scheduler for the quiz tools.
 *
 * A lightweight SM-2-style scheduler adapted for high-frequency drills. Each
 * *item* (identified by an opaque string key — a pitch class, an interval
 * semitone count, a quality/scale id, …) carries a small review state:
 *
 *  - `interval` — spacing in abstract "review steps" (not wall-clock units);
 *    grows on success, resets on failure.
 *  - `ease` — the SM-2 easiness factor: how fast the interval grows.
 *  - `due` — the wall-clock timestamp (ms) the item next wants reviewing;
 *    computed as `now + interval * STEP_MS`.
 *  - `lapses` — lifetime count of failed reviews (diagnostic).
 *  - `reps` — consecutive successful reviews since the last lapse.
 *  - `lastSeen` — timestamp of the most recent review, for the "least recently
 *    seen" fallback when nothing is due.
 *
 * Everything here is pure and framework-free: the clock is always injected as
 * a `now` timestamp (never `Date.now()` inside the logic), all randomness via
 * an `Rng`, and it never touches `window`/`document` — so it runs in the
 * `node` test environment. Persistence is a versioned `Store` per tool
 * namespace (`mt:srs:<tool>`), tests pass `memoryBackend()`.
 *
 * The picker complements — never replaces — each tool's existing stats
 * recording: `srsWeight` turns an item's due-ness into a multiplier a tool can
 * fold into its weakest-first weight (see `pickWeightedByPc`'s `boost`
 * parameter), and `pickDue` offers a direct overdue-first ordering with a
 * new/least-recently-seen fallback for tools that want it.
 */

import { Store, type StorageBackend } from './storage.ts'

/** Persisted review state for a single item. */
export interface SrsItem {
  /** Spacing in review steps; grows on success, resets to 0 on a lapse. */
  interval: number
  /** SM-2 easiness factor (clamped to [`EASE_MIN`, `EASE_MAX`]). */
  ease: number
  /** Wall-clock timestamp (ms) the item is next due for review. */
  due: number
  /** Lifetime count of failed reviews. */
  lapses: number
  /** Consecutive successful reviews since the last lapse. */
  reps: number
  /** Timestamp (ms) of the most recent review, or `null` if never reviewed. */
  lastSeen: number | null
}

/** Review states keyed by item key. A missing key means "new / never seen". */
export type SrsData = Record<string, SrsItem>

// --- Tuning constants -------------------------------------------------------

/** Starting easiness for a brand-new item (classic SM-2 default). */
export const EASE_START = 2.5
/** Floor easiness: intervals never shrink below this growth rate. */
export const EASE_MIN = 1.3
/** Ceiling easiness: keeps drill intervals from running away. */
export const EASE_MAX = 3.0

/**
 * Quality (0–1) at or above which a review counts as a pass. Below it the item
 * lapses (interval resets, ease drops). 0.6 maps to SM-2's grade 3.
 */
export const PASS_QUALITY = 0.6

/**
 * Wall-clock milliseconds one review step represents. Tuned short for
 * high-frequency drills, so a freshly-passed item becomes due again within the
 * same practice session rather than days later.
 */
export const STEP_MS = 30_000

/** Interval (steps) granted on the first successful review of an item. */
export const FIRST_INTERVAL = 1
/** Interval (steps) granted on the second consecutive success. */
export const SECOND_INTERVAL = 3
/** Interval (steps) after a lapse: 0 means "due immediately" — comes back fast. */
export const LAPSE_INTERVAL = 0

/** Response time (ms) at or below which a correct answer earns full quality. */
export const FAST_MS = 1200
/** Response time (ms) at or above which a correct answer earns minimum quality. */
export const SLOW_MS = 5000

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

/** A fresh, empty scheduler map. */
export function emptySrsData(): SrsData {
  return {}
}

/** The review state assigned to an item on its very first review. */
function seedItem(now: number): SrsItem {
  return { interval: 0, ease: EASE_START, due: now, lapses: 0, reps: 0, lastSeen: null }
}

/**
 * Derive a review quality in [0, 1] from an answer outcome. Incorrect answers
 * score 0 (a lapse). Correct answers score `0.8` by default, scaled up toward
 * `1.0` for fast responses and down toward `0.6` for slow ones when timing is
 * available — so speed nudges the interval without ever failing a correct
 * answer (all correct scores are ≥ `PASS_QUALITY`).
 */
export function qualityFromOutcome(correct: boolean, responseMs: number | null): number {
  if (!correct) return 0
  if (responseMs === null) return 0.8
  const t = clamp((responseMs - FAST_MS) / (SLOW_MS - FAST_MS), 0, 1)
  // Fast → 1.0, slow → 0.6.
  return 1 - t * 0.4
}

/**
 * Fold one graded review into an item, returning the updated state (the input
 * is never mutated). `quality` is 0–1 (see `qualityFromOutcome`); `now` is the
 * injected wall clock. A pass grows the interval (`FIRST`/`SECOND` for the
 * first two successes, then `round(interval * ease)`); a lapse resets the
 * interval, bumps `lapses`, and lowers the ease. Ease follows SM-2, clamped to
 * [`EASE_MIN`, `EASE_MAX`].
 */
export function reviewItem(prev: SrsItem | undefined, quality: number, now: number): SrsItem {
  const item = prev ?? seedItem(now)
  const q = clamp(quality, 0, 1)
  const q5 = q * 5
  // SM-2 easiness update, then clamp.
  const ease = clamp(item.ease + (0.1 - (5 - q5) * (0.08 + (5 - q5) * 0.02)), EASE_MIN, EASE_MAX)

  const passed = q >= PASS_QUALITY
  let reps: number
  let interval: number
  let lapses: number
  if (passed) {
    reps = item.reps + 1
    if (reps === 1) interval = FIRST_INTERVAL
    else if (reps === 2) interval = SECOND_INTERVAL
    else interval = Math.max(FIRST_INTERVAL, Math.round(item.interval * ease))
    lapses = item.lapses
  } else {
    reps = 0
    interval = LAPSE_INTERVAL
    lapses = item.lapses + 1
  }

  return { interval, ease, due: now + interval * STEP_MS, lapses, reps, lastSeen: now }
}

/**
 * Fold a graded review into a scheduler map under `key`, returning a new map
 * (the input is left untouched, so it is safe as a React reducer).
 */
export function reviewKey(data: SrsData, key: string, quality: number, now: number): SrsData {
  return { ...data, [key]: reviewItem(data[key], quality, now) }
}

/** Whether an item is due for review at `now` (a missing item is always due). */
export function isDue(item: SrsItem | undefined, now: number): boolean {
  if (!item) return true
  return now >= item.due
}

/**
 * How overdue an item is, in review steps (positive = overdue, negative = not
 * yet due). A missing item counts as `Infinity` (maximally due).
 */
export function overdueSteps(item: SrsItem | undefined, now: number): number {
  if (!item) return Infinity
  return (now - item.due) / STEP_MS
}

// --- Weighting (blend into weakest-first pickers) ----------------------------

/** Picking-weight multiplier granted to a never-seen item (top priority). */
export const NEW_WEIGHT = 8
/** Base multiplier for an item exactly at its due time. */
const DUE_BASE = 3
/** Overdue steps beyond which the extra weight (and not-due decay) saturates. */
const OVERDUE_CAP = 5
/** Lowest multiplier, for an item reviewed long before it is due. */
const NOT_DUE_FLOOR = 0.5

/**
 * Turn an item's due-ness into a picking-weight multiplier: new items get the
 * top weight, overdue items scale up with how overdue they are, and not-yet-due
 * items fall toward `NOT_DUE_FLOOR`. Tools multiply this into their existing
 * weakest-first weight so scheduling *blends* with (rather than replaces) the
 * accuracy/recency signal, and — because the final pick stays a weighted random
 * draw — sessions keep some variety instead of grinding one item.
 */
export function srsWeight(item: SrsItem | undefined, now: number): number {
  if (!item) return NEW_WEIGHT
  const overdue = overdueSteps(item, now)
  if (overdue >= 0) return DUE_BASE + Math.min(overdue, OVERDUE_CAP)
  // Not yet due: closer to due ⇒ closer to 1; far from due ⇒ toward the floor.
  const untilDue = Math.min(-overdue, OVERDUE_CAP)
  return Math.max(NOT_DUE_FLOOR, 1 - (untilDue / OVERDUE_CAP) * (1 - NOT_DUE_FLOOR))
}

// --- Direct due picking ------------------------------------------------------

/**
 * Order `keys` for review and return up to `k` of them: due items first
 * (most overdue first), then never-seen items, then the remaining not-yet-due
 * items least-recently-seen first. This is the "which items should I ask?"
 * schedule; a tool that prefers strict SRS ordering (over the weighted blend)
 * can drive its generator from this. Pure and deterministic; ties keep their
 * input order. Never mutates `keys` or `data`.
 */
export function pickDue(keys: readonly string[], data: SrsData, now: number, k: number): string[] {
  const due: string[] = []
  const fresh: string[] = []
  const upcoming: string[] = []
  for (const key of keys) {
    const item = data[key]
    if (!item) fresh.push(key)
    else if (now >= item.due) due.push(key)
    else upcoming.push(key)
  }
  // Most overdue first (smallest `due`); stable for equal due times.
  due.sort((a, b) => data[a]!.due - data[b]!.due)
  // Fallback ordering: least-recently-seen first (nulls first, then oldest).
  upcoming.sort((a, b) => (data[a]!.lastSeen ?? 0) - (data[b]!.lastSeen ?? 0))
  const ordered = [...due, ...fresh, ...upcoming]
  return ordered.slice(0, Math.max(0, k))
}

// --- Persistence -------------------------------------------------------------


function normalizeItem(value: unknown): SrsItem | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<Record<keyof SrsItem, unknown>>
  const interval = typeof v.interval === 'number' && v.interval >= 0 ? v.interval : 0
  const ease =
    typeof v.ease === 'number' && Number.isFinite(v.ease)
      ? clamp(v.ease, EASE_MIN, EASE_MAX)
      : EASE_START
  const due = typeof v.due === 'number' && Number.isFinite(v.due) ? v.due : 0
  const lapses = typeof v.lapses === 'number' && v.lapses >= 0 ? Math.floor(v.lapses) : 0
  const reps = typeof v.reps === 'number' && v.reps >= 0 ? Math.floor(v.reps) : 0
  const lastSeen = typeof v.lastSeen === 'number' && v.lastSeen >= 0 ? v.lastSeen : null
  return { interval, ease, due, lapses, reps, lastSeen }
}

/** Coerce arbitrary persisted data into a valid scheduler map (drops junk). */
export function normalizeSrsData(value: unknown): SrsData {
  if (typeof value !== 'object' || value === null) return {}
  const out: SrsData = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const item = normalizeItem(raw)
    if (item) out[key] = item
  }
  return out
}

/**
 * Build a per-tool scheduler store. The stored key becomes `mt:srs:<toolKey>`
 * (e.g. `mt:srs:fretboard-trainer`). Tests pass `memoryBackend()`.
 */
export function createSrsStore(toolKey: string, backend?: StorageBackend): Store<SrsData> {
  return new Store<SrsData>(
    {
      key: `srs:${toolKey}`,
      version: 1,
      defaultValue: {},
      migrate: (oldData) => normalizeSrsData(oldData),
    },
    backend,
  )
}
