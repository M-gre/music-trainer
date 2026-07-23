/**
 * Pure logic for the tempo trainer: given a small config and a completed-bar
 * count, work out the BPM the current bar should play at. The tempo starts at
 * `startBpm` and steps up by `stepBpm` every `everyNBars` bars, clamped at
 * `maxBpm`, so a player can drill a passage while it speeds up automatically.
 *
 * Framework-free and node-safe (no `window`, no Web Audio, no React) so the
 * whole ramp is unit-testable. The Play-Along page feeds `bpmForBar` the bar
 * index it already tracks for the chord display (count-in removed) and applies
 * the result with `Scheduler.setTempo`, which changes only the spacing of
 * future steps — the beat math stays continuous, nothing desyncs.
 */

// --- Ranges & constants -------------------------------------------------------

/** Hard tempo bounds (match the scheduler's clamp), instrument-agnostic. */
export const MIN_TRAINER_BPM = 20
export const MAX_TRAINER_BPM = 400
/** Smallest / largest per-step increment offered. */
export const MIN_TRAINER_STEP = 1
export const MAX_TRAINER_STEP = 20
/** Smallest / largest bar interval between increments. */
export const MIN_TRAINER_EVERY_N = 1
export const MAX_TRAINER_EVERY_N = 16
/** Quick-pick increments the UI exposes as buttons. */
export const TRAINER_STEP_OPTIONS = [1, 2, 5] as const
/** Quick-pick bar intervals the UI exposes as buttons. */
export const TRAINER_EVERY_N_OPTIONS = [1, 2, 4, 8] as const

// --- Config -------------------------------------------------------------------

export interface TempoTrainerConfig {
  /** When false the ramp is inert: every bar reports `startBpm`. */
  enabled: boolean
  /** Tempo of the first bar (in practice the Play-Along tempo slider). */
  startBpm: number
  /** BPM added at each increment. */
  stepBpm: number
  /** Bars between increments (>= 1). */
  everyNBars: number
  /** Ceiling the tempo is clamped to (never rises past it). */
  maxBpm: number
}

export const DEFAULT_TEMPO_TRAINER: TempoTrainerConfig = {
  enabled: false,
  startBpm: 100,
  stepBpm: 5,
  everyNBars: 4,
  maxBpm: 160,
}

// --- Clamps -------------------------------------------------------------------

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Clamp a BPM into the supported range; non-finite falls back to the default start. */
export function clampTrainerBpm(bpm: number): number {
  return clampInt(bpm, MIN_TRAINER_BPM, MAX_TRAINER_BPM, DEFAULT_TEMPO_TRAINER.startBpm)
}

/** Clamp a per-step increment into range. */
export function clampTrainerStep(step: number): number {
  return clampInt(step, MIN_TRAINER_STEP, MAX_TRAINER_STEP, DEFAULT_TEMPO_TRAINER.stepBpm)
}

/** Clamp a bar interval into range. */
export function clampTrainerEveryN(n: number): number {
  return clampInt(n, MIN_TRAINER_EVERY_N, MAX_TRAINER_EVERY_N, DEFAULT_TEMPO_TRAINER.everyNBars)
}

/**
 * Coerce arbitrary (persisted, hand-edited) data into a valid config, filling
 * each field from the defaults when missing/out of range. The ceiling is
 * raised to at least the start tempo so a misconfigured `maxBpm < startBpm`
 * never produces a ramp that steps *down*.
 */
export function normalizeTempoTrainerConfig(value: unknown): TempoTrainerConfig {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof TempoTrainerConfig, unknown>
  >
  const d = DEFAULT_TEMPO_TRAINER
  const startBpm = typeof v.startBpm === 'number' ? clampTrainerBpm(v.startBpm) : d.startBpm
  const maxBpm = typeof v.maxBpm === 'number' ? clampTrainerBpm(v.maxBpm) : d.maxBpm
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    startBpm,
    stepBpm: typeof v.stepBpm === 'number' ? clampTrainerStep(v.stepBpm) : d.stepBpm,
    everyNBars: typeof v.everyNBars === 'number' ? clampTrainerEveryN(v.everyNBars) : d.everyNBars,
    maxBpm: Math.max(startBpm, maxBpm),
  }
}

// --- Ramp ---------------------------------------------------------------------

/**
 * The BPM for `barIndex` (0-based bars since the progression started, count-in
 * already removed). Disabled configs report `startBpm` for every bar. Otherwise
 * the tempo rises by `stepBpm` once per `everyNBars` bars — so bars
 * `0..everyNBars-1` play at the start tempo, the next block one step faster,
 * and so on — clamped so it never exceeds `maxBpm` (nor drops below the start).
 * Inputs are clamped internally, so the function is safe on raw configs.
 */
export function bpmForBar(config: TempoTrainerConfig, barIndex: number): number {
  const start = clampTrainerBpm(config.startBpm)
  const step = clampTrainerStep(config.stepBpm)
  const everyN = clampTrainerEveryN(config.everyNBars)
  const ceiling = Math.max(start, clampTrainerBpm(config.maxBpm))
  if (!config.enabled) return start
  const bar = Number.isFinite(barIndex) ? Math.max(0, Math.floor(barIndex)) : 0
  const increments = Math.floor(bar / everyN)
  const raw = start + increments * step
  return Math.min(raw, ceiling)
}

/**
 * The first bar index at which the ramp reaches `maxBpm` (and stays there), or
 * `null` when disabled or already at the ceiling on bar 0. Handy for a "reaches
 * target in N bars" hint in the UI.
 */
export function barsToReachMax(config: TempoTrainerConfig): number | null {
  const start = clampTrainerBpm(config.startBpm)
  const step = clampTrainerStep(config.stepBpm)
  const everyN = clampTrainerEveryN(config.everyNBars)
  const ceiling = Math.max(start, clampTrainerBpm(config.maxBpm))
  if (!config.enabled || ceiling <= start) return null
  const incrementsNeeded = Math.ceil((ceiling - start) / step)
  return incrementsNeeded * everyN
}
