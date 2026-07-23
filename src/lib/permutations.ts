/**
 * Permutation generator (M5) — the remaining 24-ordering half of the
 * spider-walk pattern library. `src/lib/exercises.ts` already lets
 * `spiderMotif` build a pattern from *any* finger ordering (used there for 5
 * curated orderings); this sibling module:
 *
 *  - enumerates the full 24 permutations of fingers 1-4 in a fixed, stable
 *    order (`allFingerPermutations`);
 *  - builds an `ExercisePattern` from any ordering (`permutationPattern`),
 *    with a stable id (`perm-1324`) that round-trips through the id string
 *    alone (`parsePermutationId` / `getPermutationPattern`) — needed so a
 *    permutation chosen in the "All permutations" picker survives being
 *    persisted as a plain `patternId` string and reloaded later;
 *  - derives a deterministic "daily set" of `count` (default 4) permutations
 *    from a date string, with **no `Math.random`** — a small seeded PRNG
 *    (mulberry32) fed by a hash of the date, so the same date always
 *    produces the same set (`dailyPermutationOrders` / `dailyPermutationSet`).
 *
 * Daily-set design: the 24 permutations are shuffled (seeded by a "cycle
 * index" — `floor(dayNumber / cycleLength)`, where `dayNumber` counts days
 * since the Unix epoch) and cut into `cycleLength = ceil(24 / count)`
 * non-overlapping windows of `count` items each. Each calendar day picks the
 * window for its position within the current cycle (`dayInCycle`), so with
 * the default `count = 4`, `cycleLength = 6`: every 6 consecutive days
 * (aligned to a cycle boundary) sees every one of the 24 permutations exactly
 * once — no repeats, no omissions — and then the next cycle reshuffles the
 * order so the sequence doesn't feel identical week to week. This coverage
 * guarantee holds exactly when `count` evenly divides 24 (true for the
 * default, and for 1/2/3/6/8/12/24); other counts still produce a
 * deterministic `count`-sized set every day, just via a wrapping window that
 * can repeat a permutation near a cycle boundary.
 */

import { type ExercisePattern, FINGERS, type Finger, spiderMotif } from './exercises.ts'

/** One ordering of all four fingers — what `spiderMotif` turns into a pattern. */
export type FingerOrder = readonly [Finger, Finger, Finger, Finger]

/** All permutations of a small finger list, built by fixing each leading item in turn and recursing on the rest. */
function permute(items: readonly Finger[]): Finger[][] {
  if (items.length <= 1) return [[...items]]
  const result: Finger[][] = []
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i]
    if (head === undefined) continue
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const tail of permute(rest)) {
      result.push([head, ...tail])
    }
  }
  return result
}

/**
 * All 24 orderings of fingers 1-4, in a fixed, stable order — fixing each
 * leading finger in turn (1, then 2, then 3, then 4) and recursing on the
 * rest gives the classic lexicographic ordering: `1234, 1243, 1324, ...,
 * 4321`. Calling this repeatedly always yields the identical 24 arrays in
 * the identical order.
 */
export function allFingerPermutations(): FingerOrder[] {
  return permute(FINGERS).map((order) => order as unknown as FingerOrder)
}

/** Stable id for a permutation ordering, e.g. `[1, 3, 2, 4]` -> `perm-1324`. */
export function permutationId(order: readonly Finger[]): string {
  return `perm-${order.join('')}`
}

/** Human-readable name, e.g. `[1, 3, 2, 4]` -> `Permutation 1-3-2-4`. */
export function permutationName(order: readonly Finger[]): string {
  return `Permutation ${order.join('-')}`
}

/** Build a spider-walk `ExercisePattern` (up & down across every string) from any finger ordering. */
export function permutationPattern(order: readonly Finger[]): ExercisePattern {
  return {
    id: permutationId(order),
    name: permutationName(order),
    description: `Spider walk in the ${order.join('-')} finger order, up then down across every string — one of all 24 possible orderings of fingers 1-4.`,
    motif: spiderMotif(order),
    traversal: 'ascending-descending',
    category: 'spider',
  }
}

/** Every one of the 24 permutation patterns, in `allFingerPermutations` order — the "all permutations" picker list. */
export const ALL_PERMUTATION_PATTERNS: readonly ExercisePattern[] = allFingerPermutations().map(permutationPattern)

const PERMUTATION_ID_RE = /^perm-([1-4]{4})$/

/** Parse a permutation id back into its finger order; `undefined` if malformed or not a genuine permutation (e.g. repeated digits). */
export function parsePermutationId(id: string): FingerOrder | undefined {
  const match = PERMUTATION_ID_RE.exec(id)
  const digits = match?.[1]
  if (!digits) return undefined
  const order = digits.split('').map(Number) as Finger[]
  if (new Set(order).size !== 4) return undefined
  return order as unknown as FingerOrder
}

/** Whether `id` is a well-formed, genuine permutation id (round-trips through `parsePermutationId`). */
export function isPermutationId(id: string): boolean {
  return parsePermutationId(id) !== undefined
}

/** Look up (rebuild) the pattern for a permutation id; `undefined` if `id` isn't one. */
export function getPermutationPattern(id: string): ExercisePattern | undefined {
  const order = parsePermutationId(id)
  return order ? permutationPattern(order) : undefined
}

// --- Deterministic daily set (no Math.random) --------------------------------

/** Default number of permutations in a daily set. */
export const DAILY_SET_SIZE = 4

/** FNV-1a 32-bit string hash, used only to seed the PRNG below (not for security). */
function hashString(input: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * mulberry32: a small, fast, deterministic 32-bit PRNG. This module never
 * calls `Math.random` — every "random" choice below is a pure function of
 * the date string, via this generator and the hash above.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic Fisher-Yates shuffle driven by `rng` (expected to yield values in `[0, 1)`). */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const arr = [...items]
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const a = arr[i]
    const b = arr[j]
    if (a === undefined || b === undefined) continue
    arr[i] = b
    arr[j] = a
  }
  return arr
}

/**
 * Format a `Date` as the `YYYY-MM-DD` key the daily-set functions below
 * expect, using local calendar fields — so "today" on the page means the
 * user's own calendar day. Pure (touches only the `Date` object it's given).
 */
export function dateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Integer day number since the Unix epoch for a `YYYY-MM-DD` string (UTC-anchored, so parsing itself is timezone-independent). */
function dayNumber(dateStr: string): number {
  const match = DATE_KEY_RE.exec(dateStr)
  if (!match) throw new Error(`invalid date string (expected YYYY-MM-DD): ${dateStr}`)
  const [, y, m, d] = match
  const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d))
  return Math.floor(utcMs / 86_400_000)
}

/**
 * The deterministic `count`-sized set of finger orderings for `dateStr`
 * (`YYYY-MM-DD`). Same date in, same set out, always — see the module doc
 * comment for the shuffle/window design and its coverage guarantee.
 */
export function dailyPermutationOrders(dateStr: string, count: number = DAILY_SET_SIZE): FingerOrder[] {
  const all = allFingerPermutations()
  const n = Math.min(Math.max(1, Math.floor(count)), all.length)
  const cycleLength = Math.max(1, Math.ceil(all.length / n))
  const day = dayNumber(dateStr)
  const cycleIndex = Math.floor(day / cycleLength)
  const dayInCycle = day - cycleIndex * cycleLength

  const shuffled = shuffle(all, mulberry32(hashString(`permutation-daily-set:${cycleIndex}`)))
  const start = dayInCycle * n
  const orders: FingerOrder[] = []
  for (let k = 0; k < n; k += 1) {
    const order = shuffled[(start + k) % shuffled.length]
    if (order) orders.push(order)
  }
  return orders
}

/** The deterministic daily set, ready to use as `ExercisePattern`s. */
export function dailyPermutationSet(dateStr: string, count: number = DAILY_SET_SIZE): ExercisePattern[] {
  return dailyPermutationOrders(dateStr, count).map(permutationPattern)
}
