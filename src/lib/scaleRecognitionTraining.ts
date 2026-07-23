/**
 * Pure logic for the scale/mode-recognition ear-training quiz — the third quiz
 * mode alongside interval recognition and chord-quality recognition (see the
 * notes atop `src/pages/EarTraining.tsx`, `src/lib/earTraining.ts` and
 * `src/lib/chordQualityTraining.ts`, which this file mirrors). Framework-free
 * and fully unit-testable (no `window`/`document`, all randomness injected via
 * `Rng`):
 *  - question generation (random root in a comfortable register, scale chosen
 *    from the enabled set, avoiding immediate repeats),
 *  - answer checking (the scale id only),
 *  - the concrete ascending note sequence to play for a question, plus a
 *    descending variant for the "replay descending" option, both built on top
 *    of `theory/scales.ts`'s `SCALES`/`getScale`,
 *  - per-scale stats accumulation, and
 *  - persisted settings/stats stores, following the same shape as
 *    `earTraining.ts`'s and `chordQualityTraining.ts`'s stores.
 */

import { pickAvoiding, type Rng } from './quiz.ts'
import { Store, type StorageBackend } from './storage.ts'
import { recordPractice } from './practiceLog.ts'
import { getScale, MODE_IDS, SCALES, type Scale } from './theory/scales.ts'
import { type Midi } from './theory/notes.ts'

// --- Scales, labels & grouping ------------------------------------------------

/**
 * Selectable scale ids, in canonical display order. The chromatic scale is
 * excluded: hearing "every semitone in order" isn't a meaningful ear-training
 * target the way a diatonic/pentatonic/blues identity is.
 */
export const ALL_SCALE_IDS: readonly string[] = SCALES.filter((s) => s.id !== 'chromatic').map(
  (s) => s.id,
)

const MAJOR_MINOR_IDS: readonly string[] = ['major', 'minor']
const MODES_SET_IDS: readonly string[] = [...MODE_IDS]
const PENTATONIC_BLUES_IDS: readonly string[] = ['major-pentatonic', 'minor-pentatonic', 'blues']

/** Short answer-button/chip tag for a scale, e.g. "Mixo.", "Harm min", "Blues". */
const SCALE_SHORT_LABELS: Record<string, string> = {
  major: 'Major',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixo.',
  minor: 'Minor',
  locrian: 'Locrian',
  'harmonic-minor': 'Harm min',
  'melodic-minor': 'Mel min',
  'major-pentatonic': 'Maj pent',
  'minor-pentatonic': 'Min pent',
  blues: 'Blues',
}

/** Full answer-button label, e.g. "Natural Minor (Aeolian)". */
export function scaleLabel(scale: Scale): string {
  return scale.name
}

/** Short answer-button/chip tag for a scale (falls back to the full name). */
export function scaleShort(scale: Scale): string {
  return SCALE_SHORT_LABELS[scale.id] ?? scale.name
}

/** Sort scale ids into their canonical `SCALES` display order. */
export function sortScaleIds(ids: readonly string[]): string[] {
  const order = new Map(ALL_SCALE_IDS.map((id, i) => [id, i]))
  return [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
}

// --- Presets ------------------------------------------------------------------

export interface ScalePreset {
  id: string
  label: string
  scaleIds: string[]
}

/** Selectable scale-set presets, in display order. */
export const SCALE_PRESETS: readonly ScalePreset[] = [
  { id: 'major-minor', label: 'Major vs Minor', scaleIds: [...MAJOR_MINOR_IDS] },
  { id: 'modes', label: 'Modes', scaleIds: [...MODES_SET_IDS] },
  { id: 'pentatonic-blues', label: 'Pentatonic & Blues', scaleIds: [...PENTATONIC_BLUES_IDS] },
  { id: 'all', label: 'All', scaleIds: [...ALL_SCALE_IDS] },
]

/** Minimum number of scales that must stay enabled at all times. */
export const MIN_ENABLED = 2

// --- Question model -------------------------------------------------------------

export interface ScaleQuestion {
  /** Lower pitch the scale is built on (randomized every question), a midi number. */
  rootMidi: Midi
  scaleId: string
}

/** Inputs the generator reads; supplied live by the page each question. */
export interface ScaleQuestionContext {
  /** Enabled scale ids (must contain ≥1; ≥2 in practice). */
  enabled: readonly string[]
  /** Root register bounds (inclusive). Default C3..C4. */
  rootMin?: Midi
  rootMax?: Midi
}

/**
 * Comfortable root register: C3 (midi 48) .. C4 (midi 60). Every selectable
 * scale spans at most an octave (max interval 11 semitones) plus the octave
 * top note, so the highest note ever played is root+12, at most C5 (72) —
 * still a pleasant listening range for the default synth voice.
 */
export const ROOT_MIN: Midi = 48
export const ROOT_MAX: Midi = 60

/**
 * Pick a root midi uniformly in `[min, max]` (inclusive) using `rng`. Clamps a
 * degenerate range (min > max) to `min`.
 */
export function pickScaleRoot(rng: Rng, min: Midi = ROOT_MIN, max: Midi = ROOT_MAX): Midi {
  if (max <= min) return min
  const span = max - min + 1
  return min + Math.min(span - 1, Math.floor(rng() * span))
}

/**
 * Generate the next scale question. The scale is chosen from `ctx.enabled`,
 * avoiding an immediate repeat when more than one is enabled; the root is
 * randomized in the register. Pure given `rng`.
 */
export function generateScaleQuestion(
  ctx: ScaleQuestionContext,
  previous: ScaleQuestion | null,
  rng: Rng,
): ScaleQuestion {
  if (ctx.enabled.length === 0) {
    throw new Error('generateScaleQuestion: no enabled scales')
  }
  const scaleId = pickAvoiding(ctx.enabled, previous?.scaleId ?? null, rng)
  const rootMidi = pickScaleRoot(rng, ctx.rootMin ?? ROOT_MIN, ctx.rootMax ?? ROOT_MAX)
  return { rootMidi, scaleId }
}

/** Grade an answer: is the picked scale id the question's scale? */
export function checkScaleAnswer(question: ScaleQuestion, answer: string): boolean {
  return answer === question.scaleId
}

// --- Playback -------------------------------------------------------------------

/** The concrete midi notes (low to high), root through the octave above it. */
export function questionScaleMidis(question: ScaleQuestion): Midi[] {
  const scale = getScale(question.scaleId)
  const midis = scale.intervals.map((semitones) => question.rootMidi + semitones)
  midis.push(question.rootMidi + 12)
  return midis
}

/** A single scheduled note: which pitch, and its start offset in seconds. */
export interface ScaleStep {
  midi: Midi
  when: number
}

/**
 * Default gap between notes: eighth notes at a moderate ~107 BPM
 * (60 / 107 / 2 ≈ 0.28s), fast enough to hear the scale as a phrase rather
 * than isolated notes, slow enough to pick out each degree.
 */
export const DEFAULT_SCALE_STEP_SECONDS = 0.28

/**
 * Timed sequence for a question's scale: ascending (root to the octave above)
 * by default, or descending (top to root) when `descend` is set — the
 * "replay descending" option. Each step is spaced by `stepSeconds`, all
 * offsets relative to `startTime`.
 */
export function questionScaleSteps(
  question: ScaleQuestion,
  stepSeconds: number = DEFAULT_SCALE_STEP_SECONDS,
  startTime = 0,
  descend = false,
): ScaleStep[] {
  const ascending = questionScaleMidis(question)
  const sequence = descend ? [...ascending].reverse() : ascending
  return sequence.map((midi, i) => ({ midi, when: startTime + i * stepSeconds }))
}

// --- Per-scale stats ------------------------------------------------------------

export interface ScaleStat {
  attempts: number
  correct: number
}

/** Per-scale tallies keyed by scale id. Missing key ⇒ no attempts. */
export type ScaleStats = Record<string, ScaleStat>

/** Accuracy in `[0, 1]` for a stat, or `null` when there are no attempts. */
export function accuracy(stat: ScaleStat | undefined): number | null {
  if (!stat || stat.attempts === 0) return null
  return stat.correct / stat.attempts
}

/**
 * Return a new `ScaleStats` with one attempt (and, if `correct`, one hit)
 * folded into the tally for `scaleId`. Never mutates its input.
 */
export function accumulateStat(stats: ScaleStats, scaleId: string, correct: boolean): ScaleStats {
  recordPractice()
  const prev = stats[scaleId] ?? { attempts: 0, correct: 0 }
  return {
    ...stats,
    [scaleId]: {
      attempts: prev.attempts + 1,
      correct: prev.correct + (correct ? 1 : 0),
    },
  }
}

/** Coerce arbitrary persisted/typed data into valid `ScaleStats`. */
export function normalizeScaleStats(value: unknown): ScaleStats {
  if (typeof value !== 'object' || value === null) return {}
  const validIds = new Set(ALL_SCALE_IDS)
  const out: ScaleStats = {}
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

// --- Settings --------------------------------------------------------------------

export interface ScaleTrainingSettings {
  /** Enabled scale ids (≥ MIN_ENABLED, canonical order, deduped). */
  enabled: string[]
}

export const DEFAULT_SCALE_TRAINING_SETTINGS: ScaleTrainingSettings = {
  enabled: [...MAJOR_MINOR_IDS],
}

/**
 * Coerce enabled scales to a valid set: keep only known ids, dedupe, sort
 * canonically, and fall back to the default set if fewer than `MIN_ENABLED`
 * remain.
 */
export function normalizeEnabledScales(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : []
  const valid = new Set(ALL_SCALE_IDS)
  const set = new Set<string>()
  for (const raw of arr) {
    if (typeof raw !== 'string' || !valid.has(raw)) continue
    set.add(raw)
  }
  if (set.size < MIN_ENABLED) return [...DEFAULT_SCALE_TRAINING_SETTINGS.enabled]
  return sortScaleIds([...set])
}

/** Coerce arbitrary data into valid `ScaleTrainingSettings`. */
export function normalizeScaleTrainingSettings(value: unknown): ScaleTrainingSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof ScaleTrainingSettings, unknown>
  >
  return { enabled: normalizeEnabledScales(v.enabled) }
}

/**
 * Toggle one scale in/out of the enabled set without ever dropping below
 * `MIN_ENABLED` enabled scales. Returns a fresh, canonically-ordered array.
 */
export function toggleScale(enabled: readonly string[], scaleId: string): string[] {
  const on = enabled.includes(scaleId)
  if (on && enabled.length <= MIN_ENABLED) return [...enabled]
  const set = new Set(enabled)
  if (on) set.delete(scaleId)
  else set.add(scaleId)
  return sortScaleIds([...set])
}

/** Build a scale-training settings store (tests pass `memoryBackend()`). */
export function createScaleSettingsStore(backend?: StorageBackend): Store<ScaleTrainingSettings> {
  return new Store<ScaleTrainingSettings>(
    {
      key: 'settings:ear-training:scales',
      version: 1,
      defaultValue: DEFAULT_SCALE_TRAINING_SETTINGS,
    },
    backend,
  )
}

/** Build a lifetime per-scale stats store (tests pass `memoryBackend()`). */
export function createScaleStatsStore(backend?: StorageBackend): Store<ScaleStats> {
  return new Store<ScaleStats>(
    {
      key: 'stats:ear-training:scales',
      version: 1,
      defaultValue: {},
    },
    backend,
  )
}

/** App-wide localStorage-backed stores. */
export const scaleSettingsStore = createScaleSettingsStore()
export const scaleStatsStore = createScaleStatsStore()
