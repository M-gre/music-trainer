/**
 * Pure logic for the "Levels" mode of Ear Training — a fixed, ordered
 * curriculum that bundles the four existing trainers (interval, chord
 * quality, scale/mode, melodic echo — see `earTraining.ts`,
 * `chordQualityTraining.ts`, `scaleRecognitionTraining.ts` and
 * `melodicEchoTraining.ts`) into a progression a learner can work through.
 *
 * Framework-free and fully unit-testable (no `window`/`document`):
 *  - `EAR_TRAINING_LEVELS`: an ordered list of level definitions, each
 *    wrapping one existing trainer's question-generation config so
 *    `src/pages/EarTraining.tsx` can hand a level straight to the matching
 *    trainer component instead of the user's freely-editable settings,
 *  - `LevelProgress`/mastery: a capped ring buffer of recent right/wrong
 *    answers per level, plus a `mastered` flag that — once earned — is
 *    sticky (does not un-master on a later bad run; see `recordAnswer`),
 *  - unlock rules: level 1 is always unlocked; level N is unlocked once
 *    every earlier level is mastered,
 *  - a persisted, versioned progress store, following the same
 *    `mt:`-prefixed, `Store<T>`/`memoryBackend`-friendly shape as every
 *    other settings/stats store in this codebase.
 */

import { Store, type StorageBackend } from './storage.ts'
import { ALL_INTERVAL_SEMITONES, type PlaybackSetting } from './earTraining.ts'
import { ALL_SCALE_IDS } from './scaleRecognitionTraining.ts'
import type { EchoScaleType } from './melodicEchoTraining.ts'
import type { PitchClass } from './theory/notes.ts'

// --- Level tasks -------------------------------------------------------------

/** Fixed interval-recognition config for a level (mirrors `QuestionContext`). */
export interface IntervalLevelTask {
  kind: 'interval'
  enabled: number[]
  playback: PlaybackSetting
}

/** Fixed chord-quality-recognition config for a level. */
export interface ChordQualityLevelTask {
  kind: 'chord-quality'
  enabled: string[]
  inversions: boolean
}

/** Fixed scale/mode-recognition config for a level. */
export interface ScaleLevelTask {
  kind: 'scale'
  enabled: string[]
}

/** Fixed melodic-echo config for a level (the input instrument is left to
 * the player's own preference — it's an interaction choice, not a difficulty
 * knob — so it is intentionally not part of the level task). */
export interface MelodicEchoLevelTask {
  kind: 'melodic-echo'
  length: number
  rootPc: PitchClass
  scaleType: EchoScaleType
}

/** The task a level runs, discriminated by `kind`; one variant per trainer. */
export type LevelTask =
  | IntervalLevelTask
  | ChordQualityLevelTask
  | ScaleLevelTask
  | MelodicEchoLevelTask

export interface EarTrainingLevel {
  /** Stable id — used as the progress-store key, never renumbered/reused. */
  id: string
  title: string
  description: string
  task: LevelTask
}

// A handful of chord-quality/scale id groupings mirroring the ids/order
// defined in `theory/chords.ts` / `theory/scales.ts`. Kept local (rather than
// importing the sibling trainers' unexported groupings) since these are the
// specific curated sets this curriculum wants at each step.
const TRIADS_MAJOR_MINOR = ['maj', 'min']
const TRIADS_ALL = ['maj', 'min', 'dim', 'aug', 'sus2', 'sus4']
const SEVENTHS_ALL = ['maj7', 'min7', 'dom7', 'min7b5', 'dim7']
const SCALES_BASIC = ['major', 'minor', 'major-pentatonic', 'minor-pentatonic']

/** Every interval semitone count except unison (0) and the tritone (6) — the
 * "singable" set used once a level moves past perfect intervals/thirds. */
const INTERVALS_EXT: readonly number[] = ALL_INTERVAL_SEMITONES.filter((s) => s !== 0 && s !== 6)

/**
 * The ordered ear-training curriculum. Each level constrains one existing
 * trainer to a specific config; levels only get harder moving down the list.
 * Ids are stable strings so persisted progress survives reordering the
 * display (which this array's order defines) as long as ids aren't reused.
 */
export const EAR_TRAINING_LEVELS: readonly EarTrainingLevel[] = [
  {
    id: 'intervals-perfect',
    title: 'Perfect intervals',
    description: 'Name perfect 4ths, 5ths, and octaves, played melodically ascending.',
    task: { kind: 'interval', enabled: [5, 7, 12], playback: 'melodic-asc' },
  },
  {
    id: 'intervals-thirds',
    title: 'Add thirds',
    description: 'Major and minor 3rds join the perfect intervals, still ascending.',
    task: { kind: 'interval', enabled: [3, 4, 5, 7, 12], playback: 'melodic-asc' },
  },
  {
    id: 'intervals-full-melodic',
    title: 'All intervals, any direction',
    description:
      'Every interval from a 2nd to an octave (no unison or tritone yet), played ascending, descending, or as a chord — mixed each question.',
    task: { kind: 'interval', enabled: [...INTERVALS_EXT], playback: 'random' },
  },
  {
    id: 'intervals-harmonic',
    title: 'Harmonic intervals',
    description: 'The same interval set, now always played as a chord (both notes at once) — the hardest way to hear an interval.',
    task: { kind: 'interval', enabled: [...INTERVALS_EXT], playback: 'harmonic' },
  },
  {
    id: 'triads-basic',
    title: 'Major vs minor triads',
    description: 'Tell major and minor triads apart in root position.',
    task: { kind: 'chord-quality', enabled: [...TRIADS_MAJOR_MINOR], inversions: false },
  },
  {
    id: 'triads-full',
    title: 'All triads',
    description: 'Major, minor, diminished, augmented, and suspended triads, root position.',
    task: { kind: 'chord-quality', enabled: [...TRIADS_ALL], inversions: false },
  },
  {
    id: 'sevenths',
    title: 'Seventh chords',
    description: 'Major 7th, minor 7th, dominant 7th, half-diminished, and diminished 7th chords.',
    task: { kind: 'chord-quality', enabled: [...SEVENTHS_ALL], inversions: false },
  },
  {
    id: 'scales-basic',
    title: 'Scales: major, minor & pentatonics',
    description: 'Major, natural minor, and the major/minor pentatonic scales.',
    task: { kind: 'scale', enabled: [...SCALES_BASIC] },
  },
  {
    id: 'scales-full',
    title: 'All scales & modes',
    description: 'Every scale and mode in the trainer, including the modes, harmonic/melodic minor, and blues.',
    task: { kind: 'scale', enabled: [...ALL_SCALE_IDS] },
  },
  {
    id: 'melodic-echo',
    title: 'Melodic echo',
    description: 'Listen to a short phrase and echo it back by ear, note for note.',
    task: { kind: 'melodic-echo', length: 3, rootPc: 0, scaleType: 'major' },
  },
]

// --- Mastery & progress -------------------------------------------------------

/** How many of the most recent answers are kept per level. */
export const RING_CAPACITY = 20
/** Fraction of the ring buffer that must be correct to earn mastery. */
export const MASTERY_THRESHOLD = 0.9

export interface LevelProgress {
  /** Recent right/wrong answers, oldest first, capped at `RING_CAPACITY`. */
  recent: boolean[]
  /**
   * Once true, stays true: mastery is a milestone the player earned, not a
   * live "are you currently above 90%" gauge, so a rough patch later doesn't
   * re-lock levels that were unlocked because of it.
   */
  mastered: boolean
}

/** Per-level progress, keyed by `EarTrainingLevel.id`. Missing key ⇒ no attempts. */
export type LevelProgressMap = Record<string, LevelProgress>

/** A fresh, empty progress record for a level with no recorded attempts. */
export function emptyLevelProgress(): LevelProgress {
  return { recent: [], mastered: false }
}

/**
 * Does `recent` alone (interpreted as "the last `RING_CAPACITY` answers")
 * satisfy the mastery bar? Requires a full window — with fewer answers than
 * that there's no "last `RING_CAPACITY`" to judge yet.
 */
export function meetsMasteryBar(recent: readonly boolean[]): boolean {
  if (recent.length < RING_CAPACITY) return false
  const correct = recent.filter(Boolean).length
  return correct / RING_CAPACITY >= MASTERY_THRESHOLD
}

/**
 * Fold one graded answer into a level's progress: push onto the ring buffer
 * (dropping the oldest once over `RING_CAPACITY`), and — if not already
 * mastered — check whether the buffer now meets the mastery bar. Never
 * mutates its input.
 */
export function recordAnswer(progress: LevelProgress, correct: boolean): LevelProgress {
  const recent = [...progress.recent, correct]
  if (recent.length > RING_CAPACITY) recent.shift()
  return {
    recent,
    mastered: progress.mastered || meetsMasteryBar(recent),
  }
}

/** Convenience: fold one answer into a level's entry within a full progress map. */
export function recordLevelAnswer(
  map: LevelProgressMap,
  levelId: string,
  correct: boolean,
): LevelProgressMap {
  const prev = map[levelId] ?? emptyLevelProgress()
  return { ...map, [levelId]: recordAnswer(prev, correct) }
}

// --- Unlock rules & summaries -------------------------------------------------

/**
 * Is `id` unlocked? The first level in `levels` is always unlocked; any
 * later level unlocks only once every level before it is mastered. An
 * unknown id is treated as locked.
 */
export function isLevelUnlocked(
  levels: readonly EarTrainingLevel[],
  progress: LevelProgressMap,
  id: string,
): boolean {
  const index = levels.findIndex((level) => level.id === id)
  if (index === -1) return false
  if (index === 0) return true
  for (let i = 0; i < index; i += 1) {
    const prior = levels[i]!
    if (!(progress[prior.id]?.mastered ?? false)) return false
  }
  return true
}

/** The id of the first unlocked, not-yet-mastered level — the "up next" pick
 * for the UI to highlight. Falls back to the last level once everything is
 * mastered, or the first level if `levels` is otherwise empty of a match. */
export function recommendedLevelId(
  levels: readonly EarTrainingLevel[],
  progress: LevelProgressMap,
): string | null {
  for (const level of levels) {
    if (isLevelUnlocked(levels, progress, level.id) && !(progress[level.id]?.mastered ?? false)) {
      return level.id
    }
  }
  return levels.length > 0 ? levels[levels.length - 1]!.id : null
}

export interface LevelProgressSummary {
  /** Answers in the recent-results window (0..`RING_CAPACITY`). */
  attempts: number
  correct: number
  /** `correct / attempts` in `[0, 1]`, or `null` with no attempts yet. */
  accuracy: number | null
  mastered: boolean
  /** Short human-readable summary, e.g. "17/20 recent, 85%" or "No attempts yet". */
  label: string
}

/** Build a display-ready summary of a level's progress for the UI. */
export function levelProgressSummary(progress: LevelProgress | undefined): LevelProgressSummary {
  const recent = progress?.recent ?? []
  const attempts = recent.length
  const correct = recent.filter(Boolean).length
  const accuracy = attempts === 0 ? null : correct / attempts
  const mastered = progress?.mastered ?? false
  const label = mastered
    ? 'Mastered'
    : attempts === 0
      ? 'No attempts yet'
      : `${correct}/${attempts} recent, ${Math.round((accuracy ?? 0) * 100)}%`
  return { attempts, correct, accuracy, mastered, label }
}

// --- Persistence ---------------------------------------------------------------

/** Coerce arbitrary persisted data into a valid `LevelProgressMap`, dropping
 * unknown level ids and malformed entries rather than throwing. */
export function normalizeLevelProgressMap(
  value: unknown,
  levels: readonly EarTrainingLevel[] = EAR_TRAINING_LEVELS,
): LevelProgressMap {
  if (typeof value !== 'object' || value === null) return {}
  const validIds = new Set(levels.map((level) => level.id))
  const out: LevelProgressMap = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!validIds.has(key)) continue
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const recent = (Array.isArray(r.recent) ? r.recent : [])
      .filter((v): v is boolean => typeof v === 'boolean')
      .slice(-RING_CAPACITY)
    const mastered = typeof r.mastered === 'boolean' ? r.mastered : meetsMasteryBar(recent)
    out[key] = { recent, mastered }
  }
  return out
}

/** Build an ear-training-levels progress store (tests pass `memoryBackend()`). */
export function createEarTrainingLevelsProgressStore(
  backend?: StorageBackend,
): Store<LevelProgressMap> {
  return new Store<LevelProgressMap>(
    {
      key: 'progress:ear-training:levels',
      version: 1,
      defaultValue: {},
    },
    backend,
  )
}

/** App-wide localStorage-backed store. */
export const earTrainingLevelsProgressStore = createEarTrainingLevelsProgressStore()
