/**
 * Pure logic for the chord-quality-recognition ear-training quiz — the second
 * quiz mode alongside interval recognition (see the notes atop
 * `src/pages/EarTraining.tsx` and `src/lib/earTraining.ts`, which this file
 * mirrors). Framework-free and fully unit-testable (no `window`/`document`,
 * all randomness injected via `Rng`):
 *  - question generation (random root pitch class, enabled-quality
 *    selection avoiding immediate repeats, and — when the "inversions"
 *    difficulty setting is on — a random inversion),
 *  - answer checking (the quality id only; the inversion is never part of
 *    the answer),
 *  - the concrete voicing/arpeggio to play for a question, built on top of
 *    `chordExplorer.ts`'s `voicingMidis`/`arpeggioSteps` so both tools share
 *    one definition of "close voicing per inversion",
 *  - per-quality stats accumulation, and
 *  - persisted settings/stats stores, following the same shape as
 *    `earTraining.ts`'s interval stores.
 */

import { pickAvoiding, type Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'
import { recordPractice } from './practiceLog.ts'
import {
  arpeggioSteps,
  inversionCount,
  voicingMidis,
  VOICING_BASE_MIDI,
  type ArpeggioStep,
} from './chordExplorer.ts'
import { CHORD_QUALITIES, getChordQuality, type ChordQuality } from './theory/chords.ts'
import { type Midi, type PitchClass } from './theory/notes.ts'

// --- Qualities, labels & grouping --------------------------------------------

/** Every chord-quality id the quiz can use, in canonical display order. */
export const ALL_QUALITY_IDS: readonly string[] = CHORD_QUALITIES.map((q) => q.id)

const TRIAD_IDS: readonly string[] = ['maj', 'min', 'dim', 'aug']
const SEVENTH_IDS: readonly string[] = ['maj7', 'min7', 'dom7', 'min7b5', 'dim7']

/** Full answer-button label, e.g. "Minor 7th (m7)"; "Major" has no symbol to show. */
export function qualityLabel(quality: ChordQuality): string {
  return quality.symbol ? `${quality.name} (${quality.symbol})` : quality.name
}

/** Short answer-button tag, e.g. "m7", "dim", "maj" (major has no symbol of its own). */
export function qualityShort(quality: ChordQuality): string {
  return quality.symbol || 'maj'
}

/** Sort quality ids into their canonical `CHORD_QUALITIES` display order. */
export function sortQualityIds(ids: readonly string[]): string[] {
  const order = new Map(ALL_QUALITY_IDS.map((id, i) => [id, i]))
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

// --- Presets ------------------------------------------------------------------

export interface ChordQualityPreset {
  id: string
  label: string
  qualityIds: string[]
}

/** Selectable quality-set presets, in display order. */
export const CHORD_QUALITY_PRESETS: readonly ChordQualityPreset[] = [
  { id: 'triads', label: 'Triads', qualityIds: [...TRIAD_IDS] },
  { id: 'triads-sevenths', label: 'Triads + Sevenths', qualityIds: [...TRIAD_IDS, ...SEVENTH_IDS] },
  { id: 'all', label: 'All', qualityIds: [...ALL_QUALITY_IDS] },
]

/** Minimum number of qualities that must stay enabled at all times. */
export const MIN_ENABLED = 2

// --- Question model -------------------------------------------------------------

export interface ChordQualityQuestion {
  /** Pitch class the chord is built on (randomized every question). */
  root: PitchClass
  qualityId: string
  /** 0 = root position; only nonzero when the "inversions" setting is on. */
  inversion: number
}

/** Inputs the generator reads; supplied live by the page each question. */
export interface ChordQualityContext {
  /** Enabled quality ids (must contain ≥1; ≥2 in practice). */
  enabled: readonly string[]
  /** Harder setting: allow inversions in playback (root position only if off). */
  inversions: boolean
}

/** Pick a uniformly-random pitch class (0..11) using `rng`. */
export function pickChordRoot(rng: Rng): PitchClass {
  return Math.min(11, Math.floor(rng() * 12))
}

/** Pick a uniformly-random inversion index in `[0, count)`. */
export function pickInversion(rng: Rng, count: number): number {
  if (count <= 1) return 0
  return Math.min(count - 1, Math.floor(rng() * count))
}

/**
 * Generate the next chord-quality question. The quality is chosen from
 * `ctx.enabled`, avoiding an immediate repeat when more than one is enabled;
 * the root pitch class is randomized; the inversion stays at root position
 * unless `ctx.inversions` is on, in which case it is randomized across every
 * inversion the quality supports. Pure given `rng`.
 */
export function generateChordQualityQuestion(
  ctx: ChordQualityContext,
  previous: ChordQualityQuestion | null,
  rng: Rng,
): ChordQualityQuestion {
  if (ctx.enabled.length === 0) {
    throw new Error('generateChordQualityQuestion: no enabled qualities')
  }
  const qualityId = pickAvoiding(ctx.enabled, previous?.qualityId ?? null, rng)
  const root = pickChordRoot(rng)
  const quality = getChordQuality(qualityId)
  const inversion = ctx.inversions ? pickInversion(rng, inversionCount(quality)) : 0
  return { root, qualityId, inversion }
}

/** Grade an answer: is the picked quality id the question's quality? */
export function checkChordQualityAnswer(question: ChordQualityQuestion, answer: string): boolean {
  return answer === question.qualityId
}

// --- Voicing / playback -------------------------------------------------------

/** The concrete midi notes (low to high) to play for a question. */
export function questionVoicingMidis(question: ChordQualityQuestion): Midi[] {
  return voicingMidis(
    question.root,
    getChordQuality(question.qualityId),
    question.inversion,
    VOICING_BASE_MIDI,
  )
}

/** Arpeggio timing for a question's voicing (ascending, then descending). */
export function questionArpeggioSteps(
  question: ChordQualityQuestion,
  stepSeconds: number,
  startTime = 0,
  descend = true,
): ArpeggioStep[] {
  return arpeggioSteps(questionVoicingMidis(question), stepSeconds, startTime, descend)
}

/** Human label for an inversion index, e.g. "Root position", "2nd inversion". */
export function inversionLabel(inversion: number): string {
  switch (inversion) {
    case 0:
      return 'Root position'
    case 1:
      return '1st inversion'
    case 2:
      return '2nd inversion'
    case 3:
      return '3rd inversion'
    default:
      return `${inversion}th inversion`
  }
}

// --- Per-quality stats ---------------------------------------------------------

export interface ChordQualityStat {
  attempts: number
  correct: number
}

/** Per-quality tallies keyed by quality id. Missing key ⇒ no attempts. */
export type ChordQualityStats = Record<string, ChordQualityStat>

/** Accuracy in `[0, 1]` for a stat, or `null` when there are no attempts. */
export function accuracy(stat: ChordQualityStat | undefined): number | null {
  if (!stat || stat.attempts === 0) return null
  return stat.correct / stat.attempts
}

/**
 * Return a new `ChordQualityStats` with one attempt (and, if `correct`, one
 * hit) folded into the tally for `qualityId`. Never mutates its input.
 */
export function accumulateStat(
  stats: ChordQualityStats,
  qualityId: string,
  correct: boolean,
): ChordQualityStats {
  recordPractice()
  const prev = stats[qualityId] ?? { attempts: 0, correct: 0 }
  return {
    ...stats,
    [qualityId]: {
      attempts: prev.attempts + 1,
      correct: prev.correct + (correct ? 1 : 0),
    },
  }
}

/** Coerce arbitrary persisted/typed data into valid `ChordQualityStats`. */
export function normalizeChordQualityStats(value: unknown): ChordQualityStats {
  if (typeof value !== 'object' || value === null) return {}
  const validIds = new Set(ALL_QUALITY_IDS)
  const out: ChordQualityStats = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!validIds.has(key)) continue
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const attempts = typeof r.attempts === 'number' && r.attempts >= 0 ? Math.floor(r.attempts) : 0
    const correctRaw = typeof r.correct === 'number' && r.correct >= 0 ? Math.floor(r.correct) : 0
    if (attempts === 0) continue
    out[key] = { attempts, correct: Math.min(attempts, correctRaw) }
  }
  return out
}

// --- Settings ------------------------------------------------------------------

export interface ChordQualityTrainingSettings {
  /** Enabled quality ids (≥ MIN_ENABLED, canonical order, deduped). */
  enabled: string[]
  /** Harder setting: allow inversions in playback. */
  inversions: boolean
}

export const DEFAULT_CHORD_QUALITY_SETTINGS: ChordQualityTrainingSettings = {
  enabled: [...TRIAD_IDS],
  inversions: false,
}

/**
 * Coerce enabled qualities to a valid set: keep only known ids, dedupe, sort
 * canonically, and fall back to the default set if fewer than `MIN_ENABLED`
 * remain.
 */
export function normalizeEnabledQualities(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : []
  const valid = new Set(ALL_QUALITY_IDS)
  const set = new Set<string>()
  for (const raw of arr) {
    if (typeof raw !== 'string' || !valid.has(raw)) continue
    set.add(raw)
  }
  if (set.size < MIN_ENABLED) return [...DEFAULT_CHORD_QUALITY_SETTINGS.enabled]
  return sortQualityIds([...set])
}

/** Coerce arbitrary data into valid `ChordQualityTrainingSettings`. */
export function normalizeChordQualityTrainingSettings(value: unknown): ChordQualityTrainingSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof ChordQualityTrainingSettings, unknown>
  >
  return {
    enabled: normalizeEnabledQualities(v.enabled),
    inversions: typeof v.inversions === 'boolean' ? v.inversions : DEFAULT_CHORD_QUALITY_SETTINGS.inversions,
  }
}

/**
 * Toggle one quality in/out of the enabled set without ever dropping below
 * `MIN_ENABLED` enabled qualities. Returns a fresh, canonically-ordered array.
 */
export function toggleQuality(enabled: readonly string[], qualityId: string): string[] {
  const on = enabled.includes(qualityId)
  if (on && enabled.length <= MIN_ENABLED) return [...enabled]
  const set = new Set(enabled)
  if (on) set.delete(qualityId)
  else set.add(qualityId)
  return sortQualityIds([...set])
}

/** Build a chord-quality-training settings store (tests pass `memoryBackend()`). */
export function createChordQualitySettingsStore(
  backend?: StorageBackend,
): Store<ChordQualityTrainingSettings> {
  return new Store<ChordQualityTrainingSettings>(
    {
      key: 'settings:ear-training:chord-quality',
      version: 1,
      defaultValue: DEFAULT_CHORD_QUALITY_SETTINGS,
    },
    backend,
  )
}

/** Build a lifetime per-quality stats store (tests pass `memoryBackend()`). */
export function createChordQualityStatsStore(backend?: StorageBackend): Store<ChordQualityStats> {
  return new Store<ChordQualityStats>(
    {
      key: 'stats:ear-training:chord-quality',
      version: 1,
      defaultValue: {},
    },
    backend,
  )
}

/** App-wide localStorage-backed stores. */
export const chordQualitySettingsStore = createChordQualitySettingsStore()
export const chordQualityStatsStore = createChordQualityStatsStore()
