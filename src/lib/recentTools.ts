/**
 * Recently-used tool tracking — the signal behind "show what I just used first"
 * on the home page. We store a small map of tool route → last-visit timestamp
 * (ms since epoch) so the home grid can float recently-opened tools to the top
 * of their section while everything else keeps its stable registry order.
 *
 * The ordering math is pure and framework-free (it takes the route list and
 * reads an injectable store), so it runs in the `node` test environment. The
 * only impure surface is `recordToolVisit`, which stamps "now" into the store;
 * the app calls it from a route-change effect.
 */

import { Store, type StorageBackend } from './storage.ts'

/** How many distinct tool visits to retain (older ones are trimmed). */
export const MAX_RECENT = 24

/** The persisted shape: route → last-visit epoch-ms. */
export interface RecentToolsData {
  visits: Record<string, number>
}

/** A fresh, empty record. */
export function emptyRecentTools(): RecentToolsData {
  return { visits: {} }
}

/** Coerce arbitrary persisted data into a valid `RecentToolsData`. */
export function normalizeRecentTools(value: unknown): RecentToolsData {
  if (typeof value !== 'object' || value === null) return emptyRecentTools()
  const rawVisits = (value as { visits?: unknown }).visits
  if (typeof rawVisits !== 'object' || rawVisits === null) return emptyRecentTools()
  const visits: Record<string, number> = {}
  for (const [route, at] of Object.entries(rawVisits as Record<string, unknown>)) {
    if (typeof route === 'string' && route !== '' && typeof at === 'number' && Number.isFinite(at)) {
      visits[route] = at
    }
  }
  return { visits: pruneVisits(visits) }
}

/** Keep only the `max` most recently visited routes. Never mutates input. */
function pruneVisits(visits: Record<string, number>, max: number = MAX_RECENT): Record<string, number> {
  const entries = Object.entries(visits)
  if (entries.length <= max) return { ...visits }
  const kept = entries.sort((a, b) => b[1] - a[1]).slice(0, max)
  return Object.fromEntries(kept)
}

/** Build a recent-tools store (tests pass `memoryBackend()`). */
export function createRecentToolsStore(backend?: StorageBackend): Store<RecentToolsData> {
  return new Store<RecentToolsData>(
    {
      key: 'recent-tools',
      version: 1,
      defaultValue: emptyRecentTools(),
      migrate: (oldData) => normalizeRecentTools(oldData),
    },
    backend,
  )
}

/** App-wide recent-tools store (localStorage-backed). */
export const recentToolsStore = createRecentToolsStore()

/**
 * Stamp a tool visit into the store. `now` and the store are injectable so this
 * stays testable. Re-visiting the same route just refreshes its timestamp.
 */
export function recordToolVisit(
  route: string,
  now: Date = new Date(),
  store: Store<RecentToolsData> = recentToolsStore,
): void {
  if (route === '') return
  store.update((data) => {
    const visits = { ...data.visits, [route]: now.getTime() }
    return { visits: pruneVisits(visits) }
  })
}

/**
 * Reorder `routes` so recently-visited ones come first (most recent first),
 * with everything else keeping its original relative order. Unknown/unvisited
 * routes are never dropped — they simply trail the visited ones.
 */
export function recentOrder(
  routes: readonly string[],
  store: Store<RecentToolsData> = recentToolsStore,
): string[] {
  const visits = store.get().visits
  const visited: string[] = []
  const rest: string[] = []
  for (const route of routes) {
    if (visits[route] !== undefined) visited.push(route)
    else rest.push(route)
  }
  visited.sort((a, b) => (visits[b] ?? 0) - (visits[a] ?? 0))
  return [...visited, ...rest]
}
