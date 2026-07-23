/**
 * Lookahead scheduler for musical sequencing ("A Tale of Two Clocks" pattern).
 *
 * A coarse JS interval ticks every ~25ms; on each tick we look ~100ms ahead of
 * the audio clock and hand every grid step falling inside that window to a
 * user callback, with the *exact* audio time the step must sound at. Audio
 * precision therefore comes from the audio clock, not from `setInterval`.
 *
 * Structure mirrors the rest of `src/lib/audio/`:
 *  - The beat-time math (which steps fall in a window, step -> bar/beat/
 *    subdivision, swing offsets, tempo changes mid-run) is PURE — plain
 *    functions over a small `TransportState` value, fully unit-testable.
 *  - The impure shell (`Scheduler`) is thin, and both the clock and the timer
 *    are injectable minimal interfaces, so the whole thing runs under the
 *    `node` test environment. Nothing here touches `window`, `document`, or
 *    `AudioContext` at module load; a real `AudioContext` satisfies
 *    `SchedulerClock` structurally (as does `MinimalAudioContext`).
 *
 * Swing: every *second* subdivision of a beat (odd subdivision index) is
 * delayed by `swing * subdivisionDuration / 3`, so `swing = 1` is a full
 * triplet shuffle (2:1 long-short pairs) and `swing = 0` is straight. The
 * swing offset only shifts *when* an event sounds; the underlying grid stays
 * straight, so tempo changes and bar math are unaffected — grooves (M4) can
 * layer on this directly.
 */

// --- Grid & transport types --------------------------------------------------

/** A musical location on the grid. All indices are 0-based. */
export interface GridPosition {
  /** Bar index since start. */
  bar: number
  /** Beat index within the bar, `0..beatsPerBar-1`. */
  beat: number
  /** Subdivision index within the beat, `0..subdivisionsPerBeat-1`. */
  subdivision: number
}

/** One scheduled step: its grid position plus the absolute step counter. */
export interface SchedulerEvent extends GridPosition {
  /** Absolute subdivision index since `start()` (never resets mid-run). */
  step: number
}

/** The full rhythmic configuration of the grid. */
export interface GridConfig {
  /** Tempo in beats per minute. */
  bpm: number
  /** Beats per bar (the time-signature numerator), >= 1. */
  beatsPerBar: number
  /** Grid steps per beat (1 = quarters, 2 = eighths, 4 = sixteenths), >= 1. */
  subdivisionsPerBeat: number
  /** 0 = straight .. 1 = full triplet swing on every second subdivision. */
  swing: number
}

/**
 * The transport's position between scheduling windows: the next step to emit
 * and the straight-grid audio time it lands on. Treated as an immutable value
 * by the pure functions below.
 */
export interface TransportState {
  /** Absolute index of the next step to schedule. */
  step: number
  /** Straight-grid (un-swung) audio time of that step, seconds. */
  nextStepTime: number
}

/** A step paired with the exact audio time (swing applied) it must sound at. */
export interface TimedEvent {
  event: SchedulerEvent
  /** Absolute audio time in seconds. */
  when: number
}

// --- Constants ---------------------------------------------------------------

export const DEFAULT_BPM = 120
export const MIN_BPM = 20
export const MAX_BPM = 400

/** How far ahead of the audio clock each tick schedules, seconds. */
export const DEFAULT_LOOKAHEAD = 0.1
/** How often the scheduling tick runs, milliseconds. */
export const DEFAULT_TICK_INTERVAL_MS = 25

export const DEFAULT_GRID: GridConfig = {
  bpm: DEFAULT_BPM,
  beatsPerBar: 4,
  subdivisionsPerBeat: 1,
  swing: 0,
}

// --- Pure beat-time math ------------------------------------------------------

/** Clamp a tempo into the supported range; NaN falls back to the default. */
export function clampBpm(bpm: number): number {
  if (Number.isNaN(bpm)) return DEFAULT_BPM
  if (bpm < MIN_BPM) return MIN_BPM
  if (bpm > MAX_BPM) return MAX_BPM
  return bpm
}

/** Merge a partial grid onto the defaults, clamping every field to sane values. */
export function resolveGrid(partial: Partial<GridConfig> = {}): GridConfig {
  return {
    bpm: clampBpm(partial.bpm ?? DEFAULT_GRID.bpm),
    beatsPerBar: Math.max(1, Math.floor(partial.beatsPerBar ?? DEFAULT_GRID.beatsPerBar)),
    subdivisionsPerBeat: Math.max(
      1,
      Math.floor(partial.subdivisionsPerBeat ?? DEFAULT_GRID.subdivisionsPerBeat),
    ),
    swing: clampSwing(partial.swing ?? DEFAULT_GRID.swing),
  }
}

/** Clamp a swing amount into 0..1; NaN counts as straight. */
export function clampSwing(swing: number): number {
  if (Number.isNaN(swing)) return 0
  if (swing < 0) return 0
  if (swing > 1) return 1
  return swing
}

/** Duration of one grid step in seconds at the given tempo. */
export function secondsPerSubdivision(bpm: number, subdivisionsPerBeat: number): number {
  return 60 / clampBpm(bpm) / Math.max(1, subdivisionsPerBeat)
}

/** Map an absolute step counter to its bar/beat/subdivision position. */
export function stepToPosition(
  step: number,
  beatsPerBar: number,
  subdivisionsPerBeat: number,
): GridPosition {
  const subs = Math.max(1, subdivisionsPerBeat)
  const beats = Math.max(1, beatsPerBar)
  const beatIndex = Math.floor(step / subs)
  return {
    bar: Math.floor(beatIndex / beats),
    beat: beatIndex % beats,
    subdivision: step % subs,
  }
}

/**
 * Swing delay for a step, seconds. Only every second subdivision within a
 * beat (odd `subdivision` index) is delayed; `swing = 1` delays it by a third
 * of a step (full triplet feel). Beats themselves (subdivision 0) never move.
 */
export function swingDelay(
  subdivision: number,
  bpm: number,
  subdivisionsPerBeat: number,
  swing: number,
): number {
  if (subdivision % 2 === 0) return 0
  return (clampSwing(swing) * secondsPerSubdivision(bpm, subdivisionsPerBeat)) / 3
}

/**
 * Collect every step whose straight-grid time falls before `horizon` (exclusive)
 * and advance the transport past them. Pure: returns the events plus the new
 * state, never mutating the input.
 *
 * Because the state only carries "next step + its time", tempo/swing/meter
 * changes between calls simply change the spacing of *future* steps — no step
 * is ever skipped or emitted twice, and times stay monotonic.
 */
export function collectEvents(
  state: TransportState,
  grid: GridConfig,
  horizon: number,
): { events: TimedEvent[]; state: TransportState } {
  const stepDuration = secondsPerSubdivision(grid.bpm, grid.subdivisionsPerBeat)
  const events: TimedEvent[] = []
  let { step, nextStepTime } = state

  while (nextStepTime < horizon) {
    const position = stepToPosition(step, grid.beatsPerBar, grid.subdivisionsPerBeat)
    const when =
      nextStepTime +
      swingDelay(position.subdivision, grid.bpm, grid.subdivisionsPerBeat, grid.swing)
    events.push({ event: { ...position, step }, when })
    step += 1
    nextStepTime += stepDuration
  }

  return { events, state: { step, nextStepTime } }
}

// --- Injectable shell dependencies --------------------------------------------

/**
 * The only thing the scheduler needs from Web Audio: a monotonic time source.
 * A real `AudioContext` (and the engine's `MinimalAudioContext`) satisfies
 * this structurally; tests pass a mutable fake.
 */
export interface SchedulerClock {
  readonly currentTime: number
}

/** Minimal periodic-timer surface; tests drive ticks by hand through a fake. */
export interface IntervalTimer {
  set(callback: () => void, intervalMs: number): unknown
  clear(handle: unknown): void
}

/** Default timer: plain `setInterval`/`clearInterval` off `globalThis`. */
const defaultTimer: IntervalTimer = {
  set: (callback, intervalMs) => setInterval(callback, intervalMs),
  clear: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

// --- Scheduler ------------------------------------------------------------------

export type SchedulerEventCallback = (event: SchedulerEvent, when: number) => void

export interface SchedulerOptions extends Partial<GridConfig> {
  /** Called once per grid step with the exact audio time to schedule at. */
  onEvent?: SchedulerEventCallback
  /** Scheduling window ahead of the audio clock, seconds. Default 0.1. */
  lookahead?: number
  /** Tick period, milliseconds. Default 25. */
  tickIntervalMs?: number
  /** Periodic timer; injectable for tests. Default `setInterval`. */
  timer?: IntervalTimer
}

/**
 * The impure shell: owns the interval and the transport state, delegates all
 * beat-time math to the pure functions above. `onEvent` fires ahead of real
 * time (up to `lookahead` seconds), so audible work must be scheduled at the
 * `when` it receives; UI should read `currentPosition()` instead, which only
 * reflects events whose audio time has actually been reached.
 */
export class Scheduler {
  /** Per-step callback; assignable at any time, also settable via options. */
  onEvent: SchedulerEventCallback | null

  private grid: GridConfig
  private readonly lookahead: number
  private readonly tickIntervalMs: number
  private readonly timer: IntervalTimer

  private state: TransportState | null = null
  private handle: unknown = null
  /** Events already handed to `onEvent` whose audio time is still in the future. */
  private pending: TimedEvent[] = []
  /** The most recent event whose audio time has passed — what the UI shows. */
  private visible: SchedulerEvent | null = null

  constructor(
    private readonly clock: SchedulerClock,
    options: SchedulerOptions = {},
  ) {
    this.grid = resolveGrid(options)
    this.onEvent = options.onEvent ?? null
    this.lookahead = options.lookahead ?? DEFAULT_LOOKAHEAD
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS
    this.timer = options.timer ?? defaultTimer
  }

  get isRunning(): boolean {
    return this.state !== null
  }

  /** Current tempo in BPM. */
  get tempo(): number {
    return this.grid.bpm
  }

  /** Change tempo; takes effect from the next unscheduled step, no skips. */
  setTempo(bpm: number): void {
    this.grid = { ...this.grid, bpm: clampBpm(bpm) }
  }

  /** Current swing amount, 0..1. */
  get swing(): number {
    return this.grid.swing
  }

  /** Change swing; affects the next unscheduled off-beat. */
  setSwing(swing: number): void {
    this.grid = { ...this.grid, swing: clampSwing(swing) }
  }

  /** Current meter/grid configuration (a copy). */
  get gridConfig(): GridConfig {
    return { ...this.grid }
  }

  /**
   * Change beats-per-bar and/or subdivisions. Positions derive from the
   * absolute step counter, so this is best set before `start()`; mid-run it
   * re-maps upcoming steps onto the new grid without stopping the transport.
   */
  setMeter(meter: { beatsPerBar?: number; subdivisionsPerBeat?: number }): void {
    this.grid = resolveGrid({ ...this.grid, ...meter })
  }

  /**
   * Start (or restart) from bar 0, beat 0. The first step lands at the
   * clock's current time; an immediate tick fills the first lookahead window
   * so nothing waits for the interval to fire.
   */
  start(): void {
    this.stop()
    this.state = { step: 0, nextStepTime: this.clock.currentTime }
    this.tick()
    this.handle = this.timer.set(() => this.tick(), this.tickIntervalMs)
  }

  /** Stop and reset the transport; the next `start()` begins at beat 0. */
  stop(): void {
    if (this.handle !== null) {
      this.timer.clear(this.handle)
      this.handle = null
    }
    this.state = null
    this.pending = []
    this.visible = null
  }

  /**
   * The step the listener is hearing *now* (for UI display): the latest event
   * whose scheduled audio time has been reached — not the ones already handed
   * to `onEvent` but still up to `lookahead` seconds in the future. `null`
   * before the first step sounds or when stopped.
   */
  currentPosition(): SchedulerEvent | null {
    const now = this.clock.currentTime
    while (this.pending.length > 0 && this.pending[0]!.when <= now) {
      this.visible = this.pending.shift()!.event
    }
    return this.visible
  }

  /** One scheduling pass: emit every step inside the lookahead window. */
  private tick(): void {
    if (!this.state) return
    const horizon = this.clock.currentTime + this.lookahead
    const { events, state } = collectEvents(this.state, this.grid, horizon)
    this.state = state
    for (const timed of events) {
      this.pending.push(timed)
      this.onEvent?.(timed.event, timed.when)
    }
  }
}
