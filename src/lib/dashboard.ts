/**
 * Practice-dashboard aggregation — pure readers that turn each tool's persisted
 * stats into a uniform, display-ready summary, plus the "suggested daily
 * routine" derived from the player's weakest areas.
 *
 * Everything here is framework-free and testable in the `node` environment:
 * the per-tool summarizers take already-decoded stats objects (so tests can
 * feed fixtures directly), and `buildDashboard` reads them out of injectable
 * stores (tests pass `memoryBackend()`-backed stores; the app uses the shared
 * singletons via `defaultDashboardStores`).
 *
 * A tool only appears once it has data — no zero-state noise. The routine picks
 * the (up to) three weakest tools and phrases a concrete next action for each,
 * with a hash route the UI links to.
 */

import { pcToName, type PitchClass } from './theory/notes.ts'
import { intervalBySemitones } from './earTraining.ts'
import { getChordQuality } from './theory/chords.ts'
import { getScale } from './theory/scales.ts'
import { normalizeNoteStats, type NoteStatsData, fretboardStatsStore, keyboardStatsStore } from './noteStats.ts'
import { normalizeStats as normalizeIntervalStats, type IntervalStats, intervalStatsStore } from './earTraining.ts'
import {
  normalizeChordQualityStats,
  type ChordQualityStats,
  chordQualityStatsStore,
} from './chordQualityTraining.ts'
import { normalizeScaleStats, type ScaleStats, scaleStatsStore } from './scaleRecognitionTraining.ts'
import {
  normalizeMelodicEchoStats,
  type MelodicEchoStats,
  melodicEchoStatsStore,
} from './melodicEchoTraining.ts'
import {
  EAR_TRAINING_LEVELS,
  normalizeLevelProgressMap,
  recommendedLevelId,
  type LevelProgressMap,
  earTrainingLevelsProgressStore,
} from './earTrainingLevels.ts'
import {
  currentStreak,
  bestStreak,
  recentDays,
  totalPracticeDays,
  normalizePracticeLog,
  practiceLogStore,
  isoDay,
  type DayCell,
  type PracticeLogData,
} from './practiceLog.ts'
import type { Store } from './storage.ts'

/** A uniform per-tool summary card. `weakness` (0..1, higher = weaker) drives
 * the routine ordering; `suggestion`/`minutes` are the routine copy. */
export interface ToolStatSummary {
  /** Stable id for React keys. */
  key: string
  /** Router path (no leading `#`), e.g. `/fretboard-notes`. */
  route: string
  title: string
  /** One-line metric, e.g. "84% accuracy". */
  headline: string
  /** Secondary detail, e.g. "9 notes practiced · weakest Bb". */
  detail: string
  /** How much attention this area needs, 0 (solid) .. 1 (struggling). */
  weakness: number
  /** Full-sentence routine suggestion. */
  suggestion: string
  /** Suggested minutes for the routine. */
  minutes: number
}

/** One entry in the suggested daily routine. */
export interface RoutineItem {
  key: string
  route: string
  title: string
  suggestion: string
  minutes: number
}

/** Streak block for the dashboard header. */
export interface StreakInfo {
  current: number
  best: number
  total: number
  last7: DayCell[]
}

/** The assembled dashboard model the page renders. */
export interface Dashboard {
  streak: StreakInfo
  summaries: ToolStatSummary[]
  routine: RoutineItem[]
}

function round(n: number): number {
  return Math.round(n)
}

function pct(fraction: number): string {
  return `${round(fraction * 100)}%`
}

// --- Note-trainer summaries (per pitch class) --------------------------------

/** Accuracy for a note stat, preferring the EWMA and falling back to the raw
 * lifetime ratio (guards hand-edited data where `accuracy` is missing). */
function noteAccuracy(stat: { attempts: number; correct: number; accuracy: number | null }): number | null {
  if (stat.attempts === 0) return null
  if (stat.accuracy !== null) return stat.accuracy
  return stat.correct / stat.attempts
}

/** Summarize a fretboard/keyboard note-stats map, or `null` if nothing tracked. */
export function summarizeNoteStats(
  raw: unknown,
  cfg: { key: string; route: string; title: string; noun: string },
): ToolStatSummary | null {
  const data: NoteStatsData = normalizeNoteStats(raw)
  const entries: Array<{ pc: PitchClass; acc: number }> = []
  for (const [rawPc, stat] of Object.entries(data)) {
    const acc = noteAccuracy(stat)
    if (acc === null) continue
    entries.push({ pc: Number(rawPc) as PitchClass, acc })
  }
  if (entries.length === 0) return null

  const avg = entries.reduce((sum, e) => sum + e.acc, 0) / entries.length
  const weakest = entries.reduce((a, b) => (b.acc < a.acc ? b : a))
  const weakestName = pcToName(weakest.pc, 'flat')
  const weakness = 1 - avg

  return {
    key: cfg.key,
    route: cfg.route,
    title: cfg.title,
    headline: `${pct(avg)} accuracy`,
    detail: `${entries.length} ${cfg.noun} practiced · weakest ${weakestName}`,
    weakness,
    suggestion: `${cfg.title}: ${weakestName} is your weakest note — a 5-minute find-the-note set.`,
    minutes: 5,
  }
}

// --- Tally-based summaries (intervals / chord qualities / scales) ------------

interface Tally {
  attempts: number
  correct: number
}

/**
 * Generic summarizer for the "attempts/correct keyed by id" ear trainers.
 * `labelOf` renders a key (semitone count or quality/scale id, as the string
 * `Object.entries` yields) to a display name; `noun`/`weakLead` phrase the
 * detail and suggestion.
 */
function summarizeTallies(
  data: Record<string | number, Tally>,
  labelOf: (key: string) => string,
  cfg: { key: string; route: string; title: string; noun: string; weakLead: string },
): ToolStatSummary | null {
  const entries: Array<{ label: string; acc: number }> = []
  for (const [rawKey, tally] of Object.entries(data)) {
    if (!tally || tally.attempts === 0) continue
    entries.push({ label: labelOf(rawKey), acc: tally.correct / tally.attempts })
  }
  if (entries.length === 0) return null

  const avg = entries.reduce((sum, e) => sum + e.acc, 0) / entries.length
  const weakest = entries.reduce((a, b) => (b.acc < a.acc ? b : a))
  const weakness = 1 - avg

  return {
    key: cfg.key,
    route: cfg.route,
    title: cfg.title,
    headline: `${pct(avg)} accuracy`,
    detail: `${entries.length} ${cfg.noun} practiced · weakest ${weakest.label}`,
    weakness,
    suggestion: `${cfg.title}: ${cfg.weakLead} ${weakest.label} — one focused set.`,
    minutes: 5,
  }
}

/** Summarize interval-recognition stats, or `null` if untracked. */
export function summarizeIntervalStats(raw: unknown): ToolStatSummary | null {
  const data: IntervalStats = normalizeIntervalStats(raw)
  return summarizeTallies(
    data,
    (semitones) => {
      try {
        return intervalBySemitones(Number(semitones)).name
      } catch {
        return `${semitones} semitones`
      }
    },
    {
      key: 'ear-intervals',
      route: '/ear-training',
      title: 'Ear · intervals',
      noun: 'intervals',
      weakLead: 'weakest interval is the',
    },
  )
}

/** Summarize chord-quality-recognition stats, or `null` if untracked. */
export function summarizeChordQualityStats(raw: unknown): ToolStatSummary | null {
  const data: ChordQualityStats = normalizeChordQualityStats(raw)
  return summarizeTallies(
    data,
    (id) => {
      try {
        return getChordQuality(String(id)).name
      } catch {
        return String(id)
      }
    },
    {
      key: 'ear-chord-quality',
      route: '/ear-training',
      title: 'Ear · chord quality',
      noun: 'qualities',
      weakLead: 'weakest quality is',
    },
  )
}

/** Summarize scale/mode-recognition stats, or `null` if untracked. */
export function summarizeScaleStats(raw: unknown): ToolStatSummary | null {
  const data: ScaleStats = normalizeScaleStats(raw)
  return summarizeTallies(
    data,
    (id) => {
      try {
        return getScale(String(id)).name
      } catch {
        return String(id)
      }
    },
    {
      key: 'ear-scales',
      route: '/ear-training',
      title: 'Ear · scales',
      noun: 'scales',
      weakLead: 'weakest scale is',
    },
  )
}

/** Summarize melodic-echo stats, or `null` if untracked. */
export function summarizeMelodicEchoStats(raw: unknown): ToolStatSummary | null {
  const data: MelodicEchoStats = normalizeMelodicEchoStats(raw)
  if (data.attempts === 0) return null
  const acc = data.clean / data.attempts
  return {
    key: 'ear-melodic-echo',
    route: '/ear-training',
    title: 'Ear · melodic echo',
    headline: `${pct(acc)} clean`,
    detail: `${data.attempts} phrases · best streak ${data.bestStreak}`,
    weakness: 1 - acc,
    suggestion: `Melodic echo: ${pct(acc)} clean — run a few phrases to sharpen it.`,
    minutes: 5,
  }
}

/** Summarize ear-training level progress, or `null` if untracked. */
export function summarizeEarLevels(raw: unknown): ToolStatSummary | null {
  const data: LevelProgressMap = normalizeLevelProgressMap(raw)
  const total = EAR_TRAINING_LEVELS.length
  let mastered = 0
  let anyAttempt = false
  for (const level of EAR_TRAINING_LEVELS) {
    const p = data[level.id]
    if (!p) continue
    if (p.mastered) mastered += 1
    if (p.mastered || p.recent.length > 0) anyAttempt = true
  }
  if (!anyAttempt) return null

  const nextId = recommendedLevelId(EAR_TRAINING_LEVELS, data)
  const next = EAR_TRAINING_LEVELS.find((l) => l.id === nextId)
  const allMastered = mastered >= total
  const weakness = total === 0 ? 0 : (total - mastered) / total

  return {
    key: 'ear-levels',
    route: '/ear-training',
    title: 'Ear · levels',
    headline: `${mastered}/${total} levels mastered`,
    detail: allMastered || !next ? 'All levels mastered' : `up next: ${next.title}`,
    weakness,
    suggestion:
      allMastered || !next
        ? 'Ear training levels: all mastered — keep them sharp with a mixed session.'
        : `Ear training levels: "${next.title}" not yet mastered — one session.`,
    minutes: 5,
  }
}

// --- Store wiring ------------------------------------------------------------

/** The set of stores the dashboard reads. Injectable for tests. */
export interface DashboardStores {
  fretboard: Store<NoteStatsData>
  keyboard: Store<NoteStatsData>
  intervals: Store<IntervalStats>
  chordQuality: Store<ChordQualityStats>
  scale: Store<ScaleStats>
  melodicEcho: Store<MelodicEchoStats>
  earLevels: Store<LevelProgressMap>
  practiceLog: Store<PracticeLogData>
}

/** The app-wide (localStorage-backed) stores. */
export function defaultDashboardStores(): DashboardStores {
  return {
    fretboard: fretboardStatsStore,
    keyboard: keyboardStatsStore,
    intervals: intervalStatsStore,
    chordQuality: chordQualityStatsStore,
    scale: scaleStatsStore,
    melodicEcho: melodicEchoStatsStore,
    earLevels: earTrainingLevelsProgressStore,
    practiceLog: practiceLogStore,
  }
}

/** Build the streak block from the practice log. */
export function buildStreak(log: PracticeLogData, now: Date): StreakInfo {
  const today = isoDay(now)
  return {
    current: currentStreak(log.days, today),
    best: bestStreak(log.days),
    total: totalPracticeDays(log.days),
    last7: recentDays(log.days, today, 7),
  }
}

/** All per-tool summaries that have data, in a stable display order. */
export function buildSummaries(stores: DashboardStores): ToolStatSummary[] {
  const summaries: Array<ToolStatSummary | null> = [
    summarizeNoteStats(stores.fretboard.get(), {
      key: 'fretboard',
      route: '/fretboard-notes',
      title: 'Fretboard notes',
      noun: 'notes',
    }),
    summarizeNoteStats(stores.keyboard.get(), {
      key: 'keyboard',
      route: '/keyboard-notes',
      title: 'Keyboard notes',
      noun: 'notes',
    }),
    summarizeIntervalStats(stores.intervals.get()),
    summarizeChordQualityStats(stores.chordQuality.get()),
    summarizeScaleStats(stores.scale.get()),
    summarizeMelodicEchoStats(stores.melodicEcho.get()),
    summarizeEarLevels(stores.earLevels.get()),
  ]
  return summaries.filter((s): s is ToolStatSummary => s !== null)
}

/**
 * The suggested daily routine: the up-to-three weakest areas (weakness > 0),
 * weakest first, each phrased as a concrete next action. Returns [] when the
 * player is either untracked or comfortably on top of everything.
 */
export function buildRoutine(summaries: readonly ToolStatSummary[], limit = 3): RoutineItem[] {
  return [...summaries]
    .filter((s) => s.weakness > 0)
    .sort((a, b) => b.weakness - a.weakness)
    .slice(0, limit)
    .map((s) => ({
      key: s.key,
      route: s.route,
      title: s.title,
      suggestion: s.suggestion,
      minutes: s.minutes,
    }))
}

/** Assemble the whole dashboard model from the given stores at time `now`. */
export function buildDashboard(
  stores: DashboardStores = defaultDashboardStores(),
  now: Date = new Date(),
): Dashboard {
  const log = normalizePracticeLog(stores.practiceLog.get())
  const summaries = buildSummaries(stores)
  return {
    streak: buildStreak(log, now),
    summaries,
    routine: buildRoutine(summaries),
  }
}
