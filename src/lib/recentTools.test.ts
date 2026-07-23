import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  createRecentToolsStore,
  normalizeRecentTools,
  recentOrder,
  recordToolVisit,
  MAX_RECENT,
  type RecentToolsData,
} from './recentTools.ts'

function at(ms: number): Date {
  return new Date(ms)
}

describe('recordToolVisit + recentOrder', () => {
  it('floats visited routes to the front, most recent first', () => {
    const store = createRecentToolsStore(memoryBackend())
    recordToolVisit('/a', at(1000), store)
    recordToolVisit('/b', at(2000), store)
    recordToolVisit('/c', at(3000), store)
    expect(recentOrder(['/a', '/b', '/c'], store)).toEqual(['/c', '/b', '/a'])
  })

  it('keeps unvisited routes in their original order, after visited ones', () => {
    const store = createRecentToolsStore(memoryBackend())
    recordToolVisit('/b', at(5000), store)
    expect(recentOrder(['/a', '/b', '/c', '/d'], store)).toEqual(['/b', '/a', '/c', '/d'])
  })

  it('refreshes the timestamp when a route is revisited', () => {
    const store = createRecentToolsStore(memoryBackend())
    recordToolVisit('/a', at(1000), store)
    recordToolVisit('/b', at(2000), store)
    recordToolVisit('/a', at(3000), store)
    expect(recentOrder(['/a', '/b'], store)).toEqual(['/a', '/b'])
  })

  it('leaves the list untouched when nothing has been visited', () => {
    const store = createRecentToolsStore(memoryBackend())
    expect(recentOrder(['/a', '/b', '/c'], store)).toEqual(['/a', '/b', '/c'])
  })

  it('does not include routes absent from the input (unknown routes ignored on read)', () => {
    const store = createRecentToolsStore(memoryBackend())
    recordToolVisit('/gone', at(1000), store)
    recordToolVisit('/a', at(2000), store)
    expect(recentOrder(['/a', '/b'], store)).toEqual(['/a', '/b'])
  })

  it('ignores empty route strings', () => {
    const store = createRecentToolsStore(memoryBackend())
    recordToolVisit('', at(1000), store)
    expect(store.get().visits).toEqual({})
  })
})

describe('cap', () => {
  it('retains only the MAX_RECENT most recent visits', () => {
    const store = createRecentToolsStore(memoryBackend())
    for (let i = 0; i < MAX_RECENT + 5; i += 1) {
      recordToolVisit(`/tool-${i}`, at(1000 + i), store)
    }
    const visits = store.get().visits
    expect(Object.keys(visits).length).toBe(MAX_RECENT)
    // The oldest ones were trimmed; the newest survive.
    expect(visits['/tool-0']).toBeUndefined()
    expect(visits[`/tool-${MAX_RECENT + 4}`]).toBeDefined()
  })
})

describe('normalizeRecentTools', () => {
  it('returns empty for non-objects and missing/invalid visits', () => {
    expect(normalizeRecentTools(null)).toEqual({ visits: {} })
    expect(normalizeRecentTools(42)).toEqual({ visits: {} })
    expect(normalizeRecentTools({})).toEqual({ visits: {} })
    expect(normalizeRecentTools({ visits: 'nope' })).toEqual({ visits: {} })
  })

  it('drops entries with non-finite or non-numeric timestamps', () => {
    const raw = { visits: { '/a': 100, '/b': 'x', '/c': NaN, '/d': Infinity } }
    const norm: RecentToolsData = normalizeRecentTools(raw)
    expect(norm.visits).toEqual({ '/a': 100 })
  })

  it('caps to MAX_RECENT on load', () => {
    const visits: Record<string, number> = {}
    for (let i = 0; i < MAX_RECENT + 3; i += 1) visits[`/t-${i}`] = 1000 + i
    const norm = normalizeRecentTools({ visits })
    expect(Object.keys(norm.visits).length).toBe(MAX_RECENT)
  })
})
