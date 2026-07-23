/**
 * Pure logic for the ear-training quiz tools — the first of which is interval
 * recognition. Everything musical/stateful here is framework-free and fully
 * unit-testable (no `window`/`document`, all randomness injected via `Rng`):
 *  - question generation (root register, enabled-interval selection, playback
 *    mode resolution, no immediate interval repeats),
 *  - answer checking,
 *  - playback scheduling (the ordered list of midi notes + `when` offsets the
 *    audio engine plays for each playback mode), and
 *  - per-interval stats accumulation + a versioned persisted stats store.
 *
 * The React shell (`src/pages/EarTraining.tsx`) is a thin layer over this plus
 * the shared `QuizSession` in `quiz.ts`. Later ear-training quizzes (chord
 * quality, scale/mode recognition) are intended to become sibling modes that
 * reuse the same `QuizSession` wiring and settings/stats-store patterns
 * established here — see the notes in that file.
 */

import { INTERVALS, type Interval } from './theory/intervals.ts'
import { type Midi } from './theory/notes.ts'
import { pickAvoiding, type Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'
import { recordPractice } from './practiceLog.ts'

// --- Intervals & register ---------------------------------------------------

/** Every interval semitone count the quiz can use (P1..P8, i.e. 0..12). */
export const ALL_INTERVAL_SEMITONES: readonly number[] = INTERVALS.map((i) => i.semitones)

/**
 * Comfortable root register: C3 (midi 48) .. C5 (midi 72). The upper note of
 * an ascending octave from C5 is C6 (84), which still sits in a pleasant
 * listening range for the default synth voice.
 */
export const ROOT_MIN: Midi = 48
export const ROOT_MAX: Midi = 72

/** Look up the `Interval` record for a semitone count (throws if unknown). */
export function intervalBySemitones(semitones: number): Interval {
  const found = INTERVALS.find((i) => i.semitones === semitones)
  if (!found) throw new Error(`No interval defined for ${semitones} semitones`)
  return found
}

// --- Playback modes ---------------------------------------------------------

/** How the two notes of an interval are sounded. */
export type PlaybackMode = 'melodic-asc' | 'melodic-desc' | 'harmonic'

/** Settings-level playback choice; `random` picks a fresh mode per question. */
export type PlaybackSetting = PlaybackMode | 'random'

/** The three concrete playback modes, in display order. */
export const PLAYBACK_MODES: readonly PlaybackMode[] = [
  'melodic-asc',
  'melodic-desc',
  'harmonic',
]

/** Human labels for the playback modes (and the `random` setting). */
export const PLAYBACK_LABELS: Record<PlaybackSetting, string> = {
  'melodic-asc': 'Ascending',
  'melodic-desc': 'Descending',
  harmonic: 'Harmonic',
  random: 'Random',
}

// --- Presets ----------------------------------------------------------------

export interface IntervalPreset {
  id: string
  label: string
  /** Enabled interval semitone counts. */
  semitones: number[]
}

/** Selectable interval-set presets, in display order. */
export const INTERVAL_PRESETS: readonly IntervalPreset[] = [
  { id: 'beginner', label: 'Beginner: P4 P5 P8', semitones: [5, 7, 12] },
  { id: 'thirds', label: 'Thirds: m3 M3', semitones: [3, 4] },
  { id: 'all', label: 'All', semitones: [...ALL_INTERVAL_SEMITONES] },
]

/** Minimum number of intervals that must stay enabled at all times. */
export const MIN_ENABLED = 2

// --- Question model ---------------------------------------------------------

export interface IntervalQuestion {
  /** Lower pitch of the interval (the "root"), a midi number. */
  rootMidi: Midi
  /** The interval size in semitones (0..12); this is what the user must name. */
  semitones: number
  /** The concrete playback mode chosen for this question. */
  mode: PlaybackMode
}

/** Inputs the generator reads; supplied live by the page each question. */
export interface QuestionContext {
  /** Enabled interval semitone counts (must contain ≥1; ≥2 in practice). */
  enabled: readonly number[]
  /** Playback setting; `random` resolves to a concrete mode per question. */
  playback: PlaybackSetting
  /** Root register bounds (inclusive). Default C3..C5. */
  rootMin?: Midi
  rootMax?: Midi
}

/**
 * Pick a root midi uniformly in `[min, max]` (inclusive) using `rng`. Clamps a
 * degenerate range (min > max) to `min`.
 */
export function pickRoot(rng: Rng, min: Midi = ROOT_MIN, max: Midi = ROOT_MAX): Midi {
  if (max <= min) return min
  const span = max - min + 1
  return min + Math.min(span - 1, Math.floor(rng() * span))
}

/** Resolve a playback setting to a concrete mode for one question. */
export function resolvePlaybackMode(playback: PlaybackSetting, rng: Rng): PlaybackMode {
  if (playback !== 'random') return playback
  const index = Math.min(PLAYBACK_MODES.length - 1, Math.floor(rng() * PLAYBACK_MODES.length))
  return PLAYBACK_MODES[index]!
}

/**
 * Generate the next interval question. The interval is chosen from
 * `ctx.enabled`, avoiding an immediate repeat when more than one is enabled;
 * the root is randomized in the register; the playback mode follows the
 * setting (resolving `random` per question). Pure given `rng`.
 */
export function generateIntervalQuestion(
  ctx: QuestionContext,
  previous: IntervalQuestion | null,
  rng: Rng,
): IntervalQuestion {
  if (ctx.enabled.length === 0) throw new Error('generateIntervalQuestion: no enabled intervals')
  const semitones = pickAvoiding(ctx.enabled, previous?.semitones ?? null, rng)
  const rootMidi = pickRoot(rng, ctx.rootMin ?? ROOT_MIN, ctx.rootMax ?? ROOT_MAX)
  const mode = resolvePlaybackMode(ctx.playback, rng)
  return { rootMidi, semitones, mode }
}

/** Grade an answer: is the picked semitone count the question's interval? */
export function checkIntervalAnswer(question: IntervalQuestion, answer: number): boolean {
  return answer === question.semitones
}

// --- Playback scheduling ----------------------------------------------------

/** A single scheduled note: which pitch, and its start offset in seconds. */
export interface ScheduledNote {
  midi: Midi
  /** Start time offset in seconds relative to the start of playback. */
  when: number
}

/** Default gap in seconds between the two notes of a melodic interval. */
export const DEFAULT_NOTE_GAP = 0.62

/**
 * The ordered notes + `when` offsets for a question, per playback mode:
 *  - melodic ascending: low then high (high is `gap` later),
 *  - melodic descending: high then low,
 *  - harmonic: both at offset 0.
 *
 * The upper pitch is always `rootMidi + semitones`; a unison (P1) simply
 * repeats the same pitch. The page adds `engine.currentTime` to each `when`
 * and chooses the per-note duration.
 */
export function scheduleQuestion(
  question: IntervalQuestion,
  gap: number = DEFAULT_NOTE_GAP,
): ScheduledNote[] {
  const low = question.rootMidi
  const high = question.rootMidi + question.semitones
  switch (question.mode) {
    case 'harmonic':
      return [
        { midi: low, when: 0 },
        { midi: high, when: 0 },
      ]
    case 'melodic-desc':
      return [
        { midi: high, when: 0 },
        { midi: low, when: gap },
      ]
    case 'melodic-asc':
    default:
      return [
        { midi: low, when: 0 },
        { midi: high, when: gap },
      ]
  }
}

// --- Per-interval stats -----------------------------------------------------

export interface IntervalStat {
  attempts: number
  correct: number
}

/** Per-interval tallies keyed by semitone count. Missing key ⇒ no attempts. */
export type IntervalStats = Record<number, IntervalStat>

/** Accuracy in `[0, 1]` for a stat, or `null` when there are no attempts. */
export function accuracy(stat: IntervalStat | undefined): number | null {
  if (!stat || stat.attempts === 0) return null
  return stat.correct / stat.attempts
}

/**
 * Return a new `IntervalStats` with one attempt (and, if `correct`, one hit)
 * folded into the tally for `semitones`. Never mutates its input, so it is safe
 * to use directly as a React reducer.
 */
export function accumulateStat(
  stats: IntervalStats,
  semitones: number,
  correct: boolean,
): IntervalStats {
  recordPractice()
  const prev = stats[semitones] ?? { attempts: 0, correct: 0 }
  return {
    ...stats,
    [semitones]: {
      attempts: prev.attempts + 1,
      correct: prev.correct + (correct ? 1 : 0),
    },
  }
}

/** Coerce arbitrary persisted/typed data into valid `IntervalStats`. */
export function normalizeStats(value: unknown): IntervalStats {
  if (typeof value !== 'object' || value === null) return {}
  const out: IntervalStats = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const semitones = Number(key)
    if (!Number.isInteger(semitones) || semitones < 0 || semitones > 12) continue
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const attempts = typeof r.attempts === 'number' && r.attempts >= 0 ? Math.floor(r.attempts) : 0
    const correctRaw = typeof r.correct === 'number' && r.correct >= 0 ? Math.floor(r.correct) : 0
    if (attempts === 0) continue
    out[semitones] = { attempts, correct: Math.min(attempts, correctRaw) }
  }
  return out
}

// --- Settings ---------------------------------------------------------------

export interface EarTrainingSettings {
  /** Enabled interval semitone counts (≥ MIN_ENABLED, sorted, deduped). */
  enabled: number[]
  /** Playback setting. */
  playback: PlaybackSetting
}

export const DEFAULT_EAR_TRAINING_SETTINGS: EarTrainingSettings = {
  enabled: [5, 7, 12],
  playback: 'melodic-asc',
}

function isPlaybackSetting(value: unknown): value is PlaybackSetting {
  return (
    value === 'melodic-asc' ||
    value === 'melodic-desc' ||
    value === 'harmonic' ||
    value === 'random'
  )
}

/**
 * Coerce enabled intervals to a valid set: keep only 0..12, dedupe, sort, and
 * fall back to the default set if fewer than `MIN_ENABLED` remain.
 */
export function normalizeEnabled(value: unknown): number[] {
  const arr = Array.isArray(value) ? value : []
  const set = new Set<number>()
  for (const raw of arr) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 12) continue
    set.add(raw)
  }
  if (set.size < MIN_ENABLED) return [...DEFAULT_EAR_TRAINING_SETTINGS.enabled]
  return [...set].sort((a, b) => a - b)
}

/** Coerce arbitrary data into valid `EarTrainingSettings`. */
export function normalizeEarTrainingSettings(value: unknown): EarTrainingSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof EarTrainingSettings, unknown>
  >
  return {
    enabled: normalizeEnabled(v.enabled),
    playback: isPlaybackSetting(v.playback)
      ? v.playback
      : DEFAULT_EAR_TRAINING_SETTINGS.playback,
  }
}

/**
 * Toggle one interval in/out of the enabled set without ever dropping below
 * `MIN_ENABLED` enabled intervals. Returns a fresh sorted array.
 */
export function toggleInterval(enabled: readonly number[], semitones: number): number[] {
  const on = enabled.includes(semitones)
  if (on && enabled.length <= MIN_ENABLED) return [...enabled]
  const set = new Set(enabled)
  if (on) set.delete(semitones)
  else set.add(semitones)
  return [...set].sort((a, b) => a - b)
}

/** Build an ear-training settings store (tests pass `memoryBackend()`). */
export function createEarTrainingSettingsStore(
  backend?: StorageBackend,
): Store<EarTrainingSettings> {
  return new Store<EarTrainingSettings>(
    {
      key: 'settings:ear-training',
      version: 1,
      defaultValue: DEFAULT_EAR_TRAINING_SETTINGS,
    },
    backend,
  )
}

/** Build a lifetime per-interval stats store (tests pass `memoryBackend()`). */
export function createIntervalStatsStore(backend?: StorageBackend): Store<IntervalStats> {
  return new Store<IntervalStats>(
    {
      key: 'stats:ear-training:intervals',
      version: 1,
      defaultValue: {},
    },
    backend,
  )
}

/** App-wide localStorage-backed stores. */
export const earTrainingSettingsStore = createEarTrainingSettingsStore()
export const intervalStatsStore = createIntervalStatsStore()
