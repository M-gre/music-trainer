import { describe, expect, it } from 'vitest'
import { memoryBackend } from './storage.ts'
import { createNoteStatsStore, type NoteStat } from './noteStats.ts'
import { createIntervalStatsStore } from './earTraining.ts'
import { createChordQualityStatsStore } from './chordQualityTraining.ts'
import { createScaleStatsStore } from './scaleRecognitionTraining.ts'
import { createMelodicEchoStatsStore } from './melodicEchoTraining.ts'
import { createEarTrainingLevelsProgressStore, EAR_TRAINING_LEVELS } from './earTrainingLevels.ts'
import { createPracticeLogStore } from './practiceLog.ts'
import {
  buildDashboard,
  buildRoutine,
  buildStreak,
  summarizeChordQualityStats,
  summarizeEarLevels,
  summarizeIntervalStats,
  summarizeMelodicEchoStats,
  summarizeNoteStats,
  summarizeScaleStats,
  type DashboardStores,
  type ToolStatSummary,
} from './dashboard.ts'

function note(attempts: number, correct: number, accuracy: number): NoteStat {
  return { attempts, correct, accuracy, responseMs: 800, lastSeen: 1 }
}

const NOTE_CFG = { key: 'fretboard', route: '/fretboard-notes', title: 'Fretboard notes', noun: 'notes' }

describe('summarizeNoteStats', () => {
  it('returns null when nothing has been attempted', () => {
    expect(summarizeNoteStats({}, NOTE_CFG)).toBeNull()
  })
  it('names the weakest pitch class and reports average accuracy', () => {
    const data = { 7: note(5, 5, 1), 10: note(5, 1, 0.2) }
    const s = summarizeNoteStats(data, NOTE_CFG)
    expect(s).not.toBeNull()
    expect(s!.detail).toContain('weakest Bb')
    expect(s!.detail).toContain('2 notes practiced')
    expect(s!.headline).toBe('60% accuracy')
    expect(s!.weakness).toBeCloseTo(0.4)
    expect(s!.route).toBe('/fretboard-notes')
  })
  it('falls back to the raw ratio when EWMA accuracy is missing', () => {
    const data = { 0: { attempts: 4, correct: 2, accuracy: null, responseMs: null, lastSeen: null } }
    const s = summarizeNoteStats(data, NOTE_CFG)
    expect(s!.headline).toBe('50% accuracy')
  })
})

describe('summarizeIntervalStats', () => {
  it('returns null with no attempts', () => {
    expect(summarizeIntervalStats({})).toBeNull()
  })
  it('picks the weakest interval by name', () => {
    const s = summarizeIntervalStats({ 7: { attempts: 10, correct: 9 }, 3: { attempts: 10, correct: 2 } })
    expect(s!.detail).toContain('Minor Third')
    expect(s!.title).toBe('Ear · intervals')
    expect(s!.route).toBe('/ear-training')
  })
})

describe('summarizeChordQualityStats', () => {
  it('picks the weakest quality by name', () => {
    const s = summarizeChordQualityStats({ maj: { attempts: 10, correct: 9 }, dim: { attempts: 10, correct: 3 } })
    expect(s!.detail).toContain('Diminished')
  })
})

describe('summarizeScaleStats', () => {
  it('picks the weakest scale by name', () => {
    const s = summarizeScaleStats({ major: { attempts: 10, correct: 9 }, blues: { attempts: 10, correct: 2 } })
    expect(s!.detail).toContain('Blues')
  })
})

describe('summarizeMelodicEchoStats', () => {
  it('returns null with no attempts', () => {
    expect(summarizeMelodicEchoStats({ attempts: 0, clean: 0, bestStreak: 0 })).toBeNull()
  })
  it('reports clean rate and best streak', () => {
    const s = summarizeMelodicEchoStats({ attempts: 4, clean: 3, bestStreak: 2 })
    expect(s!.headline).toBe('75% clean')
    expect(s!.detail).toContain('best streak 2')
  })
})

describe('summarizeEarLevels', () => {
  it('returns null when no level has been touched', () => {
    expect(summarizeEarLevels({})).toBeNull()
  })
  it('counts mastered levels and names the next target', () => {
    const first = EAR_TRAINING_LEVELS[0]!
    const s = summarizeEarLevels({ [first.id]: { recent: [true, false], mastered: false } })
    expect(s!.headline).toBe(`0/${EAR_TRAINING_LEVELS.length} levels mastered`)
    expect(s!.suggestion).toContain(first.title)
    expect(s!.weakness).toBeGreaterThan(0)
  })
})

describe('buildRoutine', () => {
  const mk = (key: string, weakness: number): ToolStatSummary => ({
    key,
    route: '/x',
    title: key,
    headline: '',
    detail: '',
    weakness,
    suggestion: `do ${key}`,
    minutes: 5,
  })
  it('orders weakest-first and caps at three', () => {
    const routine = buildRoutine([mk('a', 0.2), mk('b', 0.9), mk('c', 0.5), mk('d', 0.7)])
    expect(routine.map((r) => r.key)).toEqual(['b', 'd', 'c'])
  })
  it('excludes fully-solid areas (weakness 0)', () => {
    expect(buildRoutine([mk('a', 0), mk('b', 0)])).toEqual([])
  })
})

describe('buildStreak', () => {
  it('derives current/best/total and the last-7 window', () => {
    const streak = buildStreak({ days: ['2026-07-22', '2026-07-23'] }, new Date(2026, 6, 23))
    expect(streak.current).toBe(2)
    expect(streak.best).toBe(2)
    expect(streak.total).toBe(2)
    expect(streak.last7).toHaveLength(7)
    expect(streak.last7[6]).toEqual({ day: '2026-07-23', practiced: true })
  })
})

function makeStores(): DashboardStores {
  return {
    fretboard: createNoteStatsStore('fretboard-trainer', memoryBackend()),
    keyboard: createNoteStatsStore('keyboard-trainer', memoryBackend()),
    intervals: createIntervalStatsStore(memoryBackend()),
    chordQuality: createChordQualityStatsStore(memoryBackend()),
    scale: createScaleStatsStore(memoryBackend()),
    melodicEcho: createMelodicEchoStatsStore(memoryBackend()),
    earLevels: createEarTrainingLevelsProgressStore(memoryBackend()),
    practiceLog: createPracticeLogStore(memoryBackend()),
  }
}

describe('buildDashboard', () => {
  it('omits tools with no data and yields an empty routine', () => {
    const dash = buildDashboard(makeStores(), new Date(2026, 6, 23))
    expect(dash.summaries).toEqual([])
    expect(dash.routine).toEqual([])
    expect(dash.streak.current).toBe(0)
  })
  it('aggregates tracked tools, streak, and a weakest-first routine', () => {
    const stores = makeStores()
    stores.fretboard.set({ 7: note(5, 5, 1), 10: note(5, 1, 0.2) })
    stores.intervals.set({ 7: { attempts: 10, correct: 9 }, 3: { attempts: 10, correct: 2 } })
    stores.practiceLog.set({ days: ['2026-07-22', '2026-07-23'] })

    const dash = buildDashboard(stores, new Date(2026, 6, 23))
    expect(dash.summaries.map((s) => s.key)).toEqual(['fretboard', 'ear-intervals'])
    expect(dash.streak.current).toBe(2)
    // Intervals (avg 55%) are weaker than fretboard notes (avg 60%).
    expect(dash.routine[0]!.key).toBe('ear-intervals')
    expect(dash.routine.length).toBe(2)
  })
})
