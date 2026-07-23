/**
 * Practice activity log — the raw signal behind the dashboard's streaks.
 *
 * A "practice day" is any calendar day on which the player graded at least one
 * answer in a tracked tool. We store those days as a set of ISO `YYYY-MM-DD`
 * strings (sorted ascending, deduped, capped to the most recent `MAX_DAYS`) so
 * streak math is trivial and the payload stays tiny even after years of use.
 *
 * The day math and streak reducers are pure and framework-free (they take the
 * dates and "today" as arguments, never reading the clock or `window`) so they
 * run in the `node` test environment. The only impure surface is
 * `recordPractice`, which stamps the current day into the persisted store; the
 * tracked stats-recording functions (`noteStats.recordOutcome` and each ear
 * trainer's `accumulateStat`) call it so activity is captured at the shared-lib
 * level without every tool page having to wire it up.
 */

import { Store, type StorageBackend } from './storage.ts'

/** Milliseconds in a day. Days are stepped in UTC to dodge DST edge cases. */
const DAY_MS = 86_400_000

/** How many distinct practice days to retain (older days are trimmed). */
export const MAX_DAYS = 400

/** The persisted shape: practice days, sorted ascending, deduped, capped. */
export interface PracticeLogData {
  days: string[]
}

/** A fresh, empty log. */
export function emptyPracticeLog(): PracticeLogData {
  return { days: [] }
}

// --- Pure day helpers --------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/**
 * The local calendar day of `date` as `YYYY-MM-DD`. Uses local components (not
 * UTC) so "today" matches the day the player sees on their own clock.
 */
export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** True for a well-formed `YYYY-MM-DD` string that denotes a real date. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  // Round-trip through UTC to reject impossible dates (e.g. 2024-02-31).
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** UTC midnight (ms) for an ISO day. Assumes a valid `YYYY-MM-DD`. */
function dayToUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d)
}

function utcToDay(ms: number): string {
  const dt = new Date(ms)
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`
}

/** The calendar day immediately before `day` (`YYYY-MM-DD`). */
export function dayBefore(day: string): string {
  return utcToDay(dayToUtc(day) - DAY_MS)
}

// --- Recording (pure fold) ---------------------------------------------------

/**
 * Add `day` to a sorted/deduped set of practice days, keeping only the most
 * recent `maxDays`. Never mutates its input.
 */
export function addPracticeDay(
  days: readonly string[],
  day: string,
  maxDays: number = MAX_DAYS,
): string[] {
  const set = new Set(days.filter(isIsoDay))
  if (isIsoDay(day)) set.add(day)
  const sorted = [...set].sort()
  return sorted.length > maxDays ? sorted.slice(sorted.length - maxDays) : sorted
}

// --- Streak math -------------------------------------------------------------

/**
 * Length of the practice streak ending "now". Counts consecutive days ending
 * on `today` if it was practiced, otherwise on yesterday — so a streak that is
 * merely waiting for today's session still shows its run rather than dropping
 * to zero. Returns 0 when neither today nor yesterday was practiced.
 */
export function currentStreak(days: readonly string[], today: string): number {
  const set = new Set(days.filter(isIsoDay))
  let anchor: string | null = null
  if (set.has(today)) anchor = today
  else {
    const yesterday = dayBefore(today)
    if (set.has(yesterday)) anchor = yesterday
  }
  if (anchor === null) return 0
  let count = 0
  let cursor = anchor
  while (set.has(cursor)) {
    count += 1
    cursor = dayBefore(cursor)
  }
  return count
}

/** Longest run of consecutive practice days ever recorded. */
export function bestStreak(days: readonly string[]): number {
  const sorted = [...new Set(days.filter(isIsoDay))].sort()
  let best = 0
  let run = 0
  let prev: string | null = null
  for (const day of sorted) {
    run = prev !== null && dayBefore(day) === prev ? run + 1 : 1
    if (run > best) best = run
    prev = day
  }
  return best
}

/** One cell in the trailing-days strip: a day and whether it was practiced. */
export interface DayCell {
  day: string
  practiced: boolean
}

/**
 * The last `count` calendar days ending on `today` (oldest first), each tagged
 * with whether it was practiced — for the dashboard's last-7-days dots.
 */
export function recentDays(days: readonly string[], today: string, count = 7): DayCell[] {
  const set = new Set(days.filter(isIsoDay))
  const cells: DayCell[] = []
  let cursor = today
  for (let i = 0; i < count; i += 1) {
    cells.push({ day: cursor, practiced: set.has(cursor) })
    cursor = dayBefore(cursor)
  }
  return cells.reverse()
}

/** Total distinct practice days on record. */
export function totalPracticeDays(days: readonly string[]): number {
  return new Set(days.filter(isIsoDay)).size
}

// --- Persistence -------------------------------------------------------------

/** Coerce arbitrary persisted data into a valid, capped `PracticeLogData`. */
export function normalizePracticeLog(value: unknown): PracticeLogData {
  if (typeof value !== 'object' || value === null) return emptyPracticeLog()
  const raw = (value as { days?: unknown }).days
  const arr = Array.isArray(raw) ? raw : []
  const set = new Set<string>()
  for (const item of arr) if (isIsoDay(item)) set.add(item)
  const sorted = [...set].sort()
  return { days: sorted.length > MAX_DAYS ? sorted.slice(sorted.length - MAX_DAYS) : sorted }
}

/** Build a practice-log store (tests pass `memoryBackend()`). */
export function createPracticeLogStore(backend?: StorageBackend): Store<PracticeLogData> {
  return new Store<PracticeLogData>(
    {
      key: 'progress:practice-log',
      version: 1,
      defaultValue: emptyPracticeLog(),
      migrate: (oldData) => normalizePracticeLog(oldData),
    },
    backend,
  )
}

/** App-wide practice-log store (localStorage-backed). */
export const practiceLogStore = createPracticeLogStore()

/**
 * Stamp a practice day into the log. Called from the tracked stats-recording
 * functions on every graded answer; recording the same day repeatedly is a
 * no-op set-insert, so the cost is negligible. `now` and the store are
 * injectable so this stays testable.
 */
export function recordPractice(
  now: Date = new Date(),
  store: Store<PracticeLogData> = practiceLogStore,
): void {
  const day = isoDay(now)
  store.update((data) => {
    const next = addPracticeDay(data.days, day)
    // Skip the write when nothing changed (already recorded today).
    return next.length === data.days.length && next[next.length - 1] === day
      ? data
      : { days: next }
  })
}
