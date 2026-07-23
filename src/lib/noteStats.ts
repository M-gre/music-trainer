/**
 * Per-note progress statistics and weakest-notes-first question picking.
 *
 * Every quiz tool (fretboard + keyboard note trainers today, ear training
 * later) can record how the player does on each pitch class and bias future
 * questions toward the notes they struggle with. This module is pure and
 * framework-free — all impurity (randomness, the clock) is injected — so it
 * runs in the `node` test environment and never touches `window`/`document`.
 *
 * The model tracks, per pitch class (0–11):
 *  - lifetime `attempts` / `correct` counts (for display),
 *  - an exponentially-weighted `accuracy` in [0, 1] and `responseMs`, so
 *    recent performance dominates the older history (see `ACCURACY_ALPHA` /
 *    `RESPONSE_ALPHA`), and
 *  - a `lastSeen` wall-clock timestamp, so notes that haven't come up recently
 *    can be surfaced again.
 *
 * The picker (`pickWeightedByPc`) turns those stats into a weight per pitch
 * class — low accuracy, slow responses and staleness all raise the weight —
 * and draws from them with injected randomness, so it's biased but never
 * deterministic and degrades to a uniform draw when every note is equal.
 */

import type { PitchClass } from './theory/notes.ts'
import { mod12 } from './theory/notes.ts'
import type { Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'

/** Rolling stats for a single pitch class. */
export interface NoteStat {
  /** Lifetime graded attempts on this note. */
  attempts: number
  /** Lifetime correct attempts on this note. */
  correct: number
  /**
   * Exponentially-weighted accuracy in [0, 1] (recent answers weigh more), or
   * `null` before the first attempt.
   */
  accuracy: number | null
  /**
   * Exponentially-weighted average response time in milliseconds, or `null`
   * when no attempt has carried timing (e.g. find-all rounds).
   */
  responseMs: number | null
  /** Wall-clock timestamp (ms) of the most recent attempt, or `null`. */
  lastSeen: number | null
}

/** Stats keyed by pitch class. Missing keys mean "never attempted". */
export type NoteStatsData = Record<PitchClass, NoteStat>

// --- Tuning constants -------------------------------------------------------

/** EWMA smoothing for accuracy: higher = recent answers matter more. */
export const ACCURACY_ALPHA = 0.3
/** EWMA smoothing for response time. */
export const RESPONSE_ALPHA = 0.3

/** Weight given to a note that has never been attempted (top priority). */
export const UNSEEN_WEIGHT = 10
/** Baseline weight so a perfectly-known, freshly-seen note is still pickable. */
const WEIGHT_FLOOR = 1
/** How strongly low accuracy raises a note's weight. */
const ACCURACY_WEIGHT = 4
/** How strongly slow responses raise a note's weight. */
const SPEED_WEIGHT = 1.5
/** How strongly staleness (time since last seen) raises a note's weight. */
const RECENCY_WEIGHT = 1.5
/** Response time (ms) treated as "fully slow" for weighting. */
const SLOW_MS = 4000
/** Time since last seen (ms) treated as "fully stale" for weighting. */
const STALE_MS = 45_000

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** A fresh, empty stats map. */
export function emptyNoteStats(): NoteStatsData {
  return {}
}

function isPitchClass(n: unknown): n is PitchClass {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 11
}

function normalizeStat(value: unknown): NoteStat | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Partial<Record<keyof NoteStat, unknown>>
  const attempts = typeof v.attempts === 'number' && v.attempts >= 0 ? Math.floor(v.attempts) : 0
  const correct =
    typeof v.correct === 'number' && v.correct >= 0 ? Math.min(attempts, Math.floor(v.correct)) : 0
  const accuracy =
    typeof v.accuracy === 'number' && v.accuracy >= 0 && v.accuracy <= 1 ? v.accuracy : null
  const responseMs = typeof v.responseMs === 'number' && v.responseMs >= 0 ? v.responseMs : null
  const lastSeen = typeof v.lastSeen === 'number' && v.lastSeen >= 0 ? v.lastSeen : null
  return { attempts, correct, accuracy, responseMs, lastSeen }
}

/** Coerce arbitrary persisted data into a valid stats map (drops junk). */
export function normalizeNoteStats(value: unknown): NoteStatsData {
  if (typeof value !== 'object' || value === null) return {}
  const out: NoteStatsData = {}
  for (const [rawKey, rawStat] of Object.entries(value as Record<string, unknown>)) {
    const pc = Number(rawKey)
    if (!isPitchClass(pc)) continue
    const stat = normalizeStat(rawStat)
    if (stat) out[pc] = stat
  }
  return out
}

function ewma(previous: number | null, sample: number, alpha: number): number {
  return previous === null ? sample : alpha * sample + (1 - alpha) * previous
}

/**
 * Fold one graded answer into the stats, returning a new map (the input is
 * left untouched). `responseMs` is `null` when the attempt wasn't timed.
 */
export function recordOutcome(
  data: NoteStatsData,
  pc: PitchClass,
  correct: boolean,
  responseMs: number | null,
  now: number,
): NoteStatsData {
  const key = mod12(pc)
  const prev = data[key]
  const sample = correct ? 1 : 0
  const next: NoteStat = {
    attempts: (prev?.attempts ?? 0) + 1,
    correct: (prev?.correct ?? 0) + (correct ? 1 : 0),
    accuracy: ewma(prev?.accuracy ?? null, sample, ACCURACY_ALPHA),
    responseMs:
      responseMs === null
        ? (prev?.responseMs ?? null)
        : ewma(prev?.responseMs ?? null, responseMs, RESPONSE_ALPHA),
    lastSeen: now,
  }
  return { ...data, [key]: next }
}

/**
 * Fold a completed find-all round into the stats. Every distinct note that was
 * found is counted once as correct; each wrong tap is counted as an incorrect
 * attempt on the prompted note. Returns a new map.
 */
export function recordFindAllRound(
  data: NoteStatsData,
  foundPcs: Iterable<PitchClass>,
  promptedPc: PitchClass,
  mistakes: number,
  now: number,
): NoteStatsData {
  let next = data
  for (const pc of new Set([...foundPcs].map(mod12))) {
    next = recordOutcome(next, pc, true, null, now)
  }
  for (let i = 0; i < mistakes; i++) {
    next = recordOutcome(next, promptedPc, false, null, now)
  }
  return next
}

/**
 * Picking weight for one pitch class: higher means more likely to be quizzed.
 * Unseen notes get the top weight; otherwise low accuracy, slow responses and
 * staleness each push the weight up. A perfectly-known, freshly-seen note
 * falls back to `WEIGHT_FLOOR` so all-equal stats draw uniformly.
 */
export function noteWeight(stat: NoteStat | undefined, now: number): number {
  if (!stat || stat.attempts === 0 || stat.accuracy === null) return UNSEEN_WEIGHT
  const accuracyComponent = 1 - clamp01(stat.accuracy)
  const speedComponent = stat.responseMs === null ? 0 : clamp01(stat.responseMs / SLOW_MS)
  const recencyComponent =
    stat.lastSeen === null ? 1 : clamp01((now - stat.lastSeen) / STALE_MS)
  return (
    WEIGHT_FLOOR +
    ACCURACY_WEIGHT * accuracyComponent +
    SPEED_WEIGHT * speedComponent +
    RECENCY_WEIGHT * recencyComponent
  )
}

/**
 * Weighted random pick over `items` using `weightOf`. Pure given `rng`.
 * Non-positive total weight falls back to a uniform draw; throws on empty.
 */
export function pickWeighted<T>(
  items: readonly T[],
  weightOf: (item: T) => number,
  rng: Rng,
): T {
  if (items.length === 0) throw new Error('pickWeighted: empty list')
  const weights = items.map((item) => Math.max(0, weightOf(item)))
  const total = weights.reduce((a, b) => a + b, 0)
  if (total <= 0) {
    const index = Math.min(items.length - 1, Math.floor(rng() * items.length))
    return items[index]!
  }
  let threshold = rng() * total
  for (let i = 0; i < items.length; i++) {
    threshold -= weights[i]!
    if (threshold < 0) return items[i]!
  }
  return items[items.length - 1]!
}

/**
 * Pick an item biased toward the weakest pitch class. Items are grouped by
 * their pitch class; a class is chosen with probability proportional to its
 * `noteWeight`, then one of that class's items is chosen uniformly. Grouping
 * first means a class with many candidate items (e.g. many board positions of
 * the same note) isn't over-weighted just for having more positions.
 *
 * Pure given `rng`; throws on an empty list.
 */
export function pickWeightedByPc<T>(
  items: readonly T[],
  pcOf: (item: T) => PitchClass,
  stats: NoteStatsData,
  rng: Rng,
  now: number,
): T {
  if (items.length === 0) throw new Error('pickWeightedByPc: empty list')
  const byPc = new Map<PitchClass, T[]>()
  for (const item of items) {
    const pc = mod12(pcOf(item))
    const list = byPc.get(pc)
    if (list) list.push(item)
    else byPc.set(pc, [item])
  }
  const pcs = [...byPc.keys()]
  const chosenPc = pickWeighted(pcs, (pc) => noteWeight(stats[pc], now), rng)
  const group = byPc.get(chosenPc)!
  const index = Math.min(group.length - 1, Math.floor(rng() * group.length))
  return group[index]!
}

// --- Persistence ------------------------------------------------------------

/**
 * Build a per-tool stats store. The stored key becomes `mt:stats:<toolKey>`
 * (e.g. `mt:stats:fretboard-trainer`). Tests pass `memoryBackend()`.
 */
export function createNoteStatsStore(toolKey: string, backend?: StorageBackend): Store<NoteStatsData> {
  return new Store<NoteStatsData>(
    {
      key: `stats:${toolKey}`,
      version: 1,
      defaultValue: {},
      migrate: (oldData) => normalizeNoteStats(oldData),
    },
    backend,
  )
}

/** App-wide stats stores (localStorage-backed). */
export const fretboardStatsStore = createNoteStatsStore('fretboard-trainer')
export const keyboardStatsStore = createNoteStatsStore('keyboard-trainer')
