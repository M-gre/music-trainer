import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import {
  addPracticeDay,
  bestStreak,
  createPracticeLogStore,
  currentStreak,
  dayBefore,
  emptyPracticeLog,
  isIsoDay,
  isoDay,
  MAX_DAYS,
  normalizePracticeLog,
  recentDays,
  recordPractice,
  totalPracticeDays,
} from './practiceLog.ts'

describe('isoDay', () => {
  it('formats local calendar components as YYYY-MM-DD, zero-padded', () => {
    expect(isoDay(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(isoDay(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})

describe('isIsoDay', () => {
  it('accepts well-formed real dates', () => {
    expect(isIsoDay('2026-07-23')).toBe(true)
    expect(isIsoDay('2024-02-29')).toBe(true) // leap day
  })
  it('rejects malformed or impossible dates and non-strings', () => {
    expect(isIsoDay('2026-7-3')).toBe(false)
    expect(isIsoDay('2026-13-01')).toBe(false)
    expect(isIsoDay('2024-02-31')).toBe(false)
    expect(isIsoDay('not-a-date')).toBe(false)
    expect(isIsoDay(20260723)).toBe(false)
    expect(isIsoDay(null)).toBe(false)
  })
})

describe('dayBefore', () => {
  it('steps back one day across month and year boundaries', () => {
    expect(dayBefore('2026-07-23')).toBe('2026-07-22')
    expect(dayBefore('2026-07-01')).toBe('2026-06-30')
    expect(dayBefore('2026-01-01')).toBe('2025-12-31')
    expect(dayBefore('2024-03-01')).toBe('2024-02-29') // leap year
  })
})

describe('addPracticeDay', () => {
  it('inserts, dedupes, and sorts ascending', () => {
    expect(addPracticeDay(['2026-07-20'], '2026-07-19')).toEqual(['2026-07-19', '2026-07-20'])
    expect(addPracticeDay(['2026-07-20'], '2026-07-20')).toEqual(['2026-07-20'])
  })
  it('drops invalid entries and ignores an invalid new day', () => {
    expect(addPracticeDay(['bad', '2026-07-20'], 'nope')).toEqual(['2026-07-20'])
  })
  it('caps to the most recent maxDays', () => {
    const many = Array.from({ length: 10 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`)
    const capped = addPracticeDay(many, '2026-07-11', 5)
    expect(capped).toHaveLength(5)
    expect(capped).toEqual(['2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10', '2026-07-11'])
  })
  it('MAX_DAYS is the default retention window', () => {
    const many = Array.from({ length: MAX_DAYS + 50 }, (_, i) => {
      const base = new Date(Date.UTC(2020, 0, 1))
      base.setUTCDate(base.getUTCDate() + i)
      return isoDay(new Date(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()))
    })
    expect(addPracticeDay(many, isoDay(new Date(2030, 0, 1)))).toHaveLength(MAX_DAYS)
  })
})

describe('currentStreak', () => {
  it('is 0 with no data', () => {
    expect(currentStreak([], '2026-07-23')).toBe(0)
  })
  it('counts consecutive days ending today', () => {
    expect(currentStreak(['2026-07-21', '2026-07-22', '2026-07-23'], '2026-07-23')).toBe(3)
  })
  it('counts up to yesterday when today is not yet practiced', () => {
    expect(currentStreak(['2026-07-21', '2026-07-22'], '2026-07-23')).toBe(2)
  })
  it('is 0 when neither today nor yesterday was practiced (streak broken)', () => {
    expect(currentStreak(['2026-07-20', '2026-07-21'], '2026-07-23')).toBe(0)
  })
  it('stops at the first gap', () => {
    expect(
      currentStreak(['2026-07-18', '2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23'], '2026-07-23'),
    ).toBe(4)
  })
  it('ignores duplicates and unordered input', () => {
    expect(currentStreak(['2026-07-23', '2026-07-22', '2026-07-23'], '2026-07-23')).toBe(2)
  })
})

describe('bestStreak', () => {
  it('is 0 with no data', () => {
    expect(bestStreak([])).toBe(0)
  })
  it('finds the longest consecutive run', () => {
    expect(
      bestStreak(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-10', '2026-07-11']),
    ).toBe(3)
  })
  it('handles a single day and isolated days', () => {
    expect(bestStreak(['2026-07-01'])).toBe(1)
    expect(bestStreak(['2026-07-01', '2026-07-05', '2026-07-09'])).toBe(1)
  })
})

describe('recentDays', () => {
  it('returns the trailing window oldest-first with practiced flags', () => {
    const cells = recentDays(['2026-07-23', '2026-07-21'], '2026-07-23', 3)
    expect(cells).toEqual([
      { day: '2026-07-21', practiced: true },
      { day: '2026-07-22', practiced: false },
      { day: '2026-07-23', practiced: true },
    ])
  })
})

describe('totalPracticeDays', () => {
  it('counts distinct valid days', () => {
    expect(totalPracticeDays(['2026-07-01', '2026-07-01', 'bad', '2026-07-02'])).toBe(2)
  })
})

describe('normalizePracticeLog', () => {
  it('coerces junk to an empty log', () => {
    expect(normalizePracticeLog(null)).toEqual(emptyPracticeLog())
    expect(normalizePracticeLog({ days: 'nope' })).toEqual({ days: [] })
  })
  it('keeps only valid days, sorted and deduped', () => {
    expect(normalizePracticeLog({ days: ['2026-07-02', 'bad', '2026-07-01', '2026-07-02'] })).toEqual({
      days: ['2026-07-01', '2026-07-02'],
    })
  })
})

describe('recordPractice', () => {
  it('stamps the current day into the store', () => {
    const store = createPracticeLogStore(memoryBackend())
    recordPractice(new Date(2026, 6, 23), store)
    expect(store.get().days).toEqual(['2026-07-23'])
  })
  it('is idempotent for the same day but accumulates across days', () => {
    const store = createPracticeLogStore(memoryBackend())
    recordPractice(new Date(2026, 6, 23), store)
    recordPractice(new Date(2026, 6, 23), store)
    recordPractice(new Date(2026, 6, 24), store)
    expect(store.get().days).toEqual(['2026-07-23', '2026-07-24'])
  })
})
