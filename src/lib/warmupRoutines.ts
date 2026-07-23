/**
 * Warm-up routine builder (M5) — compose a timed daily practice routine from a
 * sequence of dexterity drills, each with its own duration (a number of minutes
 * or a number of loops), and auto-advance through them. Pure and framework-free
 * like the rest of `src/lib/`; the Dexterity page drives its existing
 * `Scheduler`/`AudioEngine` through these types and switches the playback
 * configuration on each advance.
 *
 * A `RoutineStep` references a drill by exactly the identifiers the Dexterity
 * tool already persists in `dexteritySettings` — a `DrillConfig` is the
 * drill-defining subset of `DexteritySettings` (mode + pattern/scale/arpeggio
 * ids and their params + position/tempo/rhythm/accent/direction), minus the
 * per-loop auto-advance span, which is a single-drill practice mode rather than
 * a routine concept. Reusing those ids means a routine survives round-tripping
 * through `localStorage` and is validated against the same registries.
 *
 * Time estimate — a step's duration in seconds is:
 *   - `minutes` step: `minutes * 60`, exact.
 *   - `loops`   step: `loops * loopSeconds`, where one loop of the exercise
 *     spans `loopBeats = ceil(stepCount / notesPerCycle) * cycleBeats` beats
 *     (the same round-up-to-whole-cycles rule `rhythmizeSteps` uses, so a loop
 *     always ends on a beat line) and `loopSeconds = loopBeats * 60 / bpm`.
 *     `stepCount` is the number of notes in one pass of the exercise (after the
 *     direction transform) — it depends on the tuning, so the routine-level
 *     estimate takes a resolver that expands each step for the live tuning.
 *
 * Validation — a routine loaded from storage may reference a drill id that no
 * longer exists (a pattern removed in a later release). `normalizeRoutine`
 * drops any step whose `DrillConfig` cannot be resolved to a real drill, rather
 * than silently coercing it to a default and playing the wrong exercise.
 */

import {
  applyDirection,
  BUILTIN_PATTERNS,
  type ExerciseStep,
  expandPattern,
  getPattern,
} from './exercises.ts'
import { getPermutationPattern, isPermutationId } from './permutations.ts'
import { expandArpeggio, getArpeggioQuality, isArpeggioQualityId } from './arpeggioDrills.ts'
import {
  expandScaleSequence,
  getSequencePattern,
  isSequencePatternId,
} from './scaleSequences.ts'
import { getRhythm, type Rhythm } from './rhythmVariations.ts'
import {
  clampBpm,
  type DexterityMode,
  type DexteritySettings,
  normalizeDexteritySettings,
} from './dexteritySettings.ts'
import { getScale, SCALES } from './theory/scales.ts'
import { type Tuning } from './theory/instruments.ts'
import { mod12, pcToName } from './theory/notes.ts'
import { Store, type StorageBackend } from './storage.ts'

// --- Drill configuration -----------------------------------------------------

/**
 * The drill-defining subset of `DexteritySettings`: everything needed to
 * reproduce one playable exercise, using the same field names/ids the Dexterity
 * tool persists. Excludes the auto-advance span (`autoAdvance`/`advanceMin`/
 * `advanceMax`), which is a single-drill practice sweep, not a routine step.
 */
export type DrillConfig = Pick<
  DexteritySettings,
  | 'mode'
  | 'patternId'
  | 'scaleRootPc'
  | 'scaleId'
  | 'sequenceId'
  | 'arpRootPc'
  | 'arpQualityId'
  | 'arpInversion'
  | 'position'
  | 'bpm'
  | 'rhythmId'
  | 'accentEveryN'
  | 'direction'
>

/** Project a full `DexteritySettings` down to the drill-defining `DrillConfig`. */
export function drillConfigFromSettings(settings: DexteritySettings): DrillConfig {
  return {
    mode: settings.mode,
    patternId: settings.patternId,
    scaleRootPc: settings.scaleRootPc,
    scaleId: settings.scaleId,
    sequenceId: settings.sequenceId,
    arpRootPc: settings.arpRootPc,
    arpQualityId: settings.arpQualityId,
    arpInversion: settings.arpInversion,
    position: settings.position,
    bpm: settings.bpm,
    rhythmId: settings.rhythmId,
    accentEveryN: settings.accentEveryN,
    direction: settings.direction,
  }
}

/**
 * Whether a value references drill ids that still exist. Checks only the ids
 * that identify the *exercise* for the active mode — pattern id (a built-in or a
 * permutation), scale + sequence ids, or arpeggio quality id. Numeric params
 * (root, position, tempo) and softer fields (inversion, rhythm, accent,
 * direction) are coerced by `normalizeDexteritySettings`, so they never make a
 * config unresolvable; a genuinely removed *drill* does.
 */
export function isResolvableDrillConfig(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Partial<Record<keyof DrillConfig, unknown>>
  const mode: DexterityMode | undefined =
    v.mode === 'pattern' || v.mode === 'scale' || v.mode === 'arpeggio' ? v.mode : undefined
  if (mode === undefined) return false
  if (mode === 'pattern') {
    return (
      typeof v.patternId === 'string' &&
      (BUILTIN_PATTERNS.some((p) => p.id === v.patternId) || isPermutationId(v.patternId))
    )
  }
  if (mode === 'scale') {
    return (
      typeof v.scaleId === 'string' &&
      SCALES.some((s) => s.id === v.scaleId) &&
      typeof v.sequenceId === 'string' &&
      isSequencePatternId(v.sequenceId)
    )
  }
  // arpeggio
  return typeof v.arpQualityId === 'string' && isArpeggioQualityId(v.arpQualityId)
}

/**
 * Coerce arbitrary data into a valid `DrillConfig`, or `null` if it references a
 * drill id that no longer exists (so the caller can drop the step). Numeric and
 * enum fields are normalized by reusing `normalizeDexteritySettings`; the strict
 * `isResolvableDrillConfig` gate runs first so unknown ids are dropped rather
 * than quietly defaulted.
 */
export function normalizeDrillConfig(value: unknown): DrillConfig | null {
  if (!isResolvableDrillConfig(value)) return null
  return drillConfigFromSettings(normalizeDexteritySettings(value))
}

/**
 * A short human label for a drill config, without needing a tuning: the pattern
 * name, or `"C major — Diatonic 3rds"`, or `"Cmaj7 arpeggio"`. Reuses the same
 * registries the page uses so names stay in sync.
 */
export function drillConfigLabel(config: DrillConfig): string {
  if (config.mode === 'scale') {
    return `${pcToName(mod12(config.scaleRootPc))} ${getScale(config.scaleId).name} — ${
      getSequencePattern(config.sequenceId).name
    }`
  }
  if (config.mode === 'arpeggio') {
    return `${pcToName(mod12(config.arpRootPc))}${getArpeggioQuality(config.arpQualityId).symbol} arpeggio`
  }
  return (getPermutationPattern(config.patternId) ?? getPattern(config.patternId)).name
}

/**
 * Expand a drill config to its concrete step sequence for a tuning — the same
 * pipeline the Dexterity page uses for its live board (mode dispatch +
 * `applyDirection`). Used both to render/preview a step and to count its notes
 * for the loops time estimate.
 */
export function expandDrillConfig(config: DrillConfig, tuning: Tuning): ExerciseStep[] {
  let raw: ExerciseStep[]
  if (config.mode === 'scale') {
    raw = expandScaleSequence({
      tuning,
      root: mod12(config.scaleRootPc),
      scale: getScale(config.scaleId),
      patternId: config.sequenceId,
      anchor: config.position,
    })
  } else if (config.mode === 'arpeggio') {
    raw = expandArpeggio({
      tuning,
      root: mod12(config.arpRootPc),
      intervals: getArpeggioQuality(config.arpQualityId).intervals,
      inversion: config.arpInversion,
      anchor: config.position,
    })
  } else {
    const pattern = getPermutationPattern(config.patternId) ?? getPattern(config.patternId)
    raw = expandPattern(pattern, { tuning, position: config.position })
  }
  return applyDirection(raw, config.direction)
}

// --- Routine model -----------------------------------------------------------

/** How long a routine step runs: a wall-clock duration or a count of loops. */
export type StepDuration =
  | { readonly kind: 'minutes'; readonly minutes: number }
  | { readonly kind: 'loops'; readonly loops: number }

/** One step of a routine: a drill configuration plus how long to run it. */
export interface RoutineStep {
  /** The exercise to play (same ids the Dexterity tool persists). */
  readonly config: DrillConfig
  /** How long this step runs before auto-advancing. */
  readonly duration: StepDuration
}

/** A named, ordered sequence of drill steps. */
export interface Routine {
  /** Stable unique id (used for persistence + load/delete). */
  readonly id: string
  /** Human-readable name. */
  readonly name: string
  /** The steps, in play order. */
  readonly steps: readonly RoutineStep[]
}

/** Bounds for a step's minute count. */
export const MIN_STEP_MINUTES = 1
export const MAX_STEP_MINUTES = 30

/** Bounds for a step's loop count. */
export const MIN_STEP_LOOPS = 1
export const MAX_STEP_LOOPS = 64

/** The duration a freshly-added step gets. */
export const DEFAULT_STEP_DURATION: StepDuration = { kind: 'minutes', minutes: 2 }

function clampIntInRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Coerce arbitrary data into a valid `StepDuration`, defaulting on garbage. */
export function normalizeStepDuration(value: unknown): StepDuration {
  if (typeof value === 'object' && value !== null) {
    const v = value as { kind?: unknown; minutes?: unknown; loops?: unknown }
    if (v.kind === 'loops') {
      return { kind: 'loops', loops: clampIntInRange(Number(v.loops), MIN_STEP_LOOPS, MAX_STEP_LOOPS) }
    }
    if (v.kind === 'minutes') {
      return { kind: 'minutes', minutes: clampIntInRange(Number(v.minutes), MIN_STEP_MINUTES, MAX_STEP_MINUTES) }
    }
  }
  return DEFAULT_STEP_DURATION
}

// --- Time estimate -----------------------------------------------------------

/**
 * Beats in one loop of an exercise with `stepCount` notes under `rhythm`: the
 * notes are laid onto whole rhythm cycles (rounding up so a loop ends on a beat
 * line, matching `rhythmizeSteps`), so `ceil(stepCount / notesPerCycle)` cycles
 * of `cycleBeats` beats each. Zero notes → zero beats.
 */
export function loopBeats(stepCount: number, rhythm: Rhythm): number {
  const notesPerCycle = rhythm.offsets.length
  if (stepCount <= 0 || notesPerCycle <= 0) return 0
  return Math.ceil(stepCount / notesPerCycle) * rhythm.cycleBeats
}

/** Duration of one loop in seconds: `loopBeats * 60 / bpm`. */
export function loopSeconds(stepCount: number, rhythm: Rhythm, bpm: number): number {
  return (loopBeats(stepCount, rhythm) * 60) / clampBpm(bpm)
}

/**
 * Estimated seconds a single step occupies. `minutes` steps are exact; `loops`
 * steps multiply their loop count by one loop's duration, derived from
 * `stepCount` (the notes in one pass of the exercise), the step's rhythm, and
 * its tempo. `stepCount` is ignored for `minutes` steps.
 */
export function estimateStepSeconds(step: RoutineStep, stepCount: number): number {
  if (step.duration.kind === 'minutes') return step.duration.minutes * 60
  const rhythm = getRhythm(step.config.rhythmId)
  return step.duration.loops * loopSeconds(stepCount, rhythm, step.config.bpm)
}

/**
 * Estimated total seconds for a routine. `resolveStepCount` returns the number
 * of notes in one pass of a step's exercise (the page supplies
 * `(config) => expandDrillConfig(config, tuning).length`); it is only consulted
 * for `loops` steps.
 */
export function estimateRoutineSeconds(
  routine: Routine,
  resolveStepCount: (config: DrillConfig) => number,
): number {
  return routine.steps.reduce(
    (sum, step) =>
      sum + estimateStepSeconds(step, step.duration.kind === 'loops' ? resolveStepCount(step.config) : 0),
    0,
  )
}

// --- Advance / completion ----------------------------------------------------

/**
 * The step to play after `currentIndex`, or `null` when the routine is complete
 * (the current step is the last, or the index is out of range). Returned with
 * its index so a player can update both at once.
 */
export function nextStep(
  routine: Routine,
  currentIndex: number,
): { index: number; step: RoutineStep } | null {
  const next = Math.floor(currentIndex) + 1
  const step = routine.steps[next]
  if (next < 0 || step === undefined) return null
  return { index: next, step }
}

/** Whether `index` is the last step of the routine. */
export function isLastStep(routine: Routine, index: number): boolean {
  return index >= routine.steps.length - 1
}

/**
 * Whether a running step has met its duration and should advance.
 * `loops` steps compare completed loops (`floor(gridStepsElapsed / loopGridSteps)`)
 * against the target; a non-positive loop length (an empty exercise) is treated
 * as already complete so the player never stalls. `minutes` steps compare
 * elapsed seconds against `minutes * 60`.
 */
export function stepIsComplete(
  step: RoutineStep,
  gridStepsElapsed: number,
  loopGridSteps: number,
  secondsElapsed: number,
): boolean {
  if (step.duration.kind === 'loops') {
    if (loopGridSteps <= 0) return true
    return Math.floor(gridStepsElapsed / loopGridSteps) >= step.duration.loops
  }
  return secondsElapsed >= step.duration.minutes * 60
}

// --- Persistence -------------------------------------------------------------

/** The persisted routines state: the saved list plus the last-played id. */
export interface RoutinesState {
  /** Saved routines, in display order (most recently saved last). */
  readonly routines: readonly Routine[]
  /** Id of the routine last started, or `null`. */
  readonly lastUsedId: string | null
}

export const DEFAULT_ROUTINES_STATE: RoutinesState = { routines: [], lastUsedId: null }

/**
 * Coerce arbitrary data into a valid `Routine`, or `null` if it has no usable
 * id/name or no resolvable steps left after dropping the ones referencing
 * unknown drill ids. Every surviving step's config + duration is normalized.
 */
export function normalizeRoutine(value: unknown): Routine | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as { id?: unknown; name?: unknown; steps?: unknown }
  if (typeof v.id !== 'string' || v.id.length === 0) return null
  const name = typeof v.name === 'string' && v.name.trim().length > 0 ? v.name : 'Routine'
  if (!Array.isArray(v.steps)) return null
  const steps: RoutineStep[] = []
  for (const raw of v.steps) {
    if (typeof raw !== 'object' || raw === null) continue
    const config = normalizeDrillConfig((raw as { config?: unknown }).config)
    if (!config) continue
    steps.push({ config, duration: normalizeStepDuration((raw as { duration?: unknown }).duration) })
  }
  if (steps.length === 0) return null
  return { id: v.id, name, steps }
}

/**
 * Coerce arbitrary data into a valid `RoutinesState`, dropping unusable
 * routines. `lastUsedId` is kept only if it still names a surviving routine.
 */
export function normalizeRoutinesState(value: unknown): RoutinesState {
  if (typeof value !== 'object' || value === null) return DEFAULT_ROUTINES_STATE
  const v = value as { routines?: unknown; lastUsedId?: unknown }
  const routines: Routine[] = []
  if (Array.isArray(v.routines)) {
    for (const raw of v.routines) {
      const routine = normalizeRoutine(raw)
      if (routine) routines.push(routine)
    }
  }
  const lastUsedId =
    typeof v.lastUsedId === 'string' && routines.some((r) => r.id === v.lastUsedId) ? v.lastUsedId : null
  return { routines, lastUsedId }
}

/** Migrate persisted routines from an older schema version (currently just normalizes). */
export function migrateRoutinesState(oldData: unknown): RoutinesState {
  return normalizeRoutinesState(oldData)
}

/** Build a routines store (tests pass `memoryBackend()`). */
export function createRoutinesStore(backend?: StorageBackend): Store<RoutinesState> {
  return new Store<RoutinesState>(
    {
      key: 'routines:dexterity',
      version: 1,
      defaultValue: DEFAULT_ROUTINES_STATE,
      migrate: migrateRoutinesState,
    },
    backend,
  )
}

/** The app-wide routines store (localStorage-backed). */
export const routinesStore = createRoutinesStore()

// --- Small pure editing helpers (used by the builder UI) ---------------------

/** Return a new step list with the item at `index` moved by `delta` (clamped). */
export function moveStep(steps: readonly RoutineStep[], index: number, delta: number): RoutineStep[] {
  const next = [...steps]
  const target = index + delta
  if (index < 0 || index >= next.length || target < 0 || target >= next.length) return next
  const a = next[index]!
  const b = next[target]!
  next[index] = b
  next[target] = a
  return next
}

/** Return a new step list with the item at `index` removed. */
export function removeStep(steps: readonly RoutineStep[], index: number): RoutineStep[] {
  return steps.filter((_, i) => i !== index)
}
