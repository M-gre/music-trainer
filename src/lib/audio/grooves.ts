/**
 * Groove engine — drum patterns as data, plus the glue that drives a `DrumKit`
 * from a `Scheduler`.
 *
 * Mirrors the split used throughout `src/lib/audio/`:
 *  - The PURE half — the pattern format (`Groove`, `Step`), the groove data
 *    tables (`GROOVES`), the step-index math (`planEvent`, `grooveStepIndex`,
 *    `grooveGrid`) and the mute filter — contains no Web Audio calls and never
 *    touches `window`, so every rhythmic decision is unit-testable under the
 *    `node` environment and the patterns can be inspected / rendered by a future
 *    step-grid editor.
 *  - `GroovePlayer` is the thin wiring layer: it maps each scheduler event to a
 *    step in the current groove (handling multi-bar patterns, the groove's
 *    subdivision resolution, per-voice mute, master enable and a count-in
 *    pre-roll) and triggers `playDrum` at the event's `when`.
 *
 * Pattern format
 * --------------
 * A groove is a set of per-voice step grids. Each track is an array of `Step`s
 * where `0` is a rest and a value in `(0, 1]` is a hit at that velocity —
 * accents are simply higher velocities, ghost notes lower ones. A track's
 * length is always `stepsPerBar * bars`. `subdivision` fixes how many steps
 * fall in one beat ('8th' = 2, '16th' = 4, 'triplet' = 3), so `stepsPerBar`
 * divided by that count gives the beats per bar. Multi-bar patterns (e.g. the
 * two-bar bossa clave) simply use longer tracks and `bars > 1`.
 *
 * NOTE: `tracks` is a *partial* map — a groove only lists the voices it uses.
 * (A full `Record<DrumVoice, Step[]>` would force every groove to carry
 * all-rest lanes for voices it never plays, which the "kick + snare + a cymbal,
 * except where musically intentional" design explicitly allows to be omitted.)
 */

import { DRUM_VOICES, type DrumVoice, type PlayDrumOptions } from './drums.ts'
import type { SchedulerEventCallback, GridPosition } from './scheduler.ts'

// --- Pattern format ----------------------------------------------------------

/** One grid cell: `0` = rest, otherwise a hit velocity in `(0, 1]`. */
export type Step = number

/** Rhythmic resolution of a groove's grid (steps per beat). */
export type Subdivision = '8th' | '16th' | 'triplet'

/** How many grid steps each subdivision type packs into one beat. */
export const SUBDIVISION_STEPS: Record<Subdivision, number> = {
  '8th': 2,
  '16th': 4,
  triplet: 3,
}

/** A named drum pattern: per-voice step grids plus its grid geometry. */
export interface Groove {
  /** Stable id (used for persistence / selection). */
  id: string
  /** Human-readable name for the picker. */
  name: string
  /** One-line description of the feel, for UI. */
  description: string
  /** Grid steps in a single bar; equals `beatsPerBar * SUBDIVISION_STEPS`. */
  stepsPerBar: number
  /** Grid resolution — fixes steps-per-beat. */
  subdivision: Subdivision
  /**
   * Optional swing amount (0..1) handed to the scheduler. Grooves written on a
   * 'triplet' grid already carry their shuffle feel in the note placement and
   * leave this at 0; straight grids can set it to shuffle the off-steps.
   */
  swing?: number
  /** Number of bars the pattern spans before repeating (default 1). */
  bars?: number
  /** Per-voice step grids. Each present track has length `stepsPerBar * bars`. */
  tracks: Partial<Record<DrumVoice, Step[]>>
}

// --- Grid geometry (PURE) ----------------------------------------------------

/** Steps per beat for a subdivision. */
export function subdivisionsPerBeat(subdivision: Subdivision): number {
  return SUBDIVISION_STEPS[subdivision]
}

/** Bars the pattern spans (at least 1). */
export function grooveBars(groove: Groove): number {
  return Math.max(1, Math.floor(groove.bars ?? 1))
}

/** Beats per bar implied by `stepsPerBar` and the subdivision (at least 1). */
export function grooveBeatsPerBar(groove: Groove): number {
  return Math.max(1, Math.round(groove.stepsPerBar / subdivisionsPerBeat(groove.subdivision)))
}

/** Total steps across the whole (possibly multi-bar) pattern. */
export function grooveStepCount(groove: Groove): number {
  return groove.stepsPerBar * grooveBars(groove)
}

/** The scheduler grid a groove wants: meter, resolution and swing. */
export interface GrooveGrid {
  beatsPerBar: number
  subdivisionsPerBeat: number
  swing: number
}

/** Derive the scheduler grid config from a groove. */
export function grooveGrid(groove: Groove): GrooveGrid {
  return {
    beatsPerBar: grooveBeatsPerBar(groove),
    subdivisionsPerBeat: subdivisionsPerBeat(groove.subdivision),
    swing: groove.swing ?? 0,
  }
}

/**
 * Map a scheduler grid position to an index into the groove's step arrays,
 * wrapping multi-bar patterns. `bar` is the *pattern* bar (count-in already
 * removed by the caller) and may exceed the pattern length — it is taken modulo
 * the pattern's bar count so playback loops seamlessly.
 */
export function grooveStepIndex(groove: Groove, position: GridPosition): number {
  const totalBars = grooveBars(groove)
  const subs = subdivisionsPerBeat(groove.subdivision)
  const patternBar = ((position.bar % totalBars) + totalBars) % totalBars
  const inBarStep = position.beat * subs + position.subdivision
  return patternBar * groove.stepsPerBar + inBarStep
}

// --- Count-in ----------------------------------------------------------------

/** Options for the pre-roll click that precedes groove playback. */
export interface CountInConfig {
  /** Bars of count-in before the groove starts. 0 disables it. Default 1. */
  bars?: number
  /** Which voice ticks the count-in. Default `hat-closed`. */
  voice?: DrumVoice
  /** Velocity of the regular count-in ticks. Default 0.55. */
  velocity?: number
  /** Velocity of the tick on beat 1 of each count-in bar. Default 0.85. */
  accentVelocity?: number
}

/** A fully-resolved count-in spec. */
export interface ResolvedCountIn {
  bars: number
  voice: DrumVoice
  velocity: number
  accentVelocity: number
}

/** Default count-in: one bar of accented closed-hat ticks. */
export const DEFAULT_COUNT_IN: ResolvedCountIn = {
  bars: 1,
  voice: 'hat-closed',
  velocity: 0.55,
  accentVelocity: 0.85,
}

/** Merge a partial count-in config onto the defaults, clamping to sane values. */
export function resolveCountIn(config: CountInConfig = {}): ResolvedCountIn {
  return {
    bars: Math.max(0, Math.floor(config.bars ?? DEFAULT_COUNT_IN.bars)),
    voice: config.voice ?? DEFAULT_COUNT_IN.voice,
    velocity: clampVelocity(config.velocity ?? DEFAULT_COUNT_IN.velocity),
    accentVelocity: clampVelocity(config.accentVelocity ?? DEFAULT_COUNT_IN.accentVelocity),
  }
}

// --- Event planning (PURE) ---------------------------------------------------

/** A single voice to trigger at a scheduler event. */
export interface GrooveHit {
  voice: DrumVoice
  velocity: number
}

/** Whether an event falls in the count-in pre-roll or the groove itself. */
export type EventPhase = 'count-in' | 'groove'

/** What a scheduler event resolves to under a groove + count-in. */
export interface EventPlan {
  phase: EventPhase
  /** Index into the pattern (groove phase only); `null` during count-in. */
  patternStep: number | null
  /** Voices to trigger, in `DRUM_VOICES` order. */
  hits: GrooveHit[]
}

/**
 * Resolve a scheduler grid position to the hits it should produce. During the
 * count-in bars it emits one tick per beat (accented on beat 1); afterwards it
 * looks up every voice's velocity at the mapped step and emits a hit for each
 * non-rest. Pure: no state, no mute filtering (that is applied separately).
 */
export function planEvent(
  groove: Groove,
  position: GridPosition,
  countIn: ResolvedCountIn = DEFAULT_COUNT_IN,
): EventPlan {
  if (position.bar < countIn.bars) {
    const hits: GrooveHit[] =
      position.subdivision === 0
        ? [
            {
              voice: countIn.voice,
              velocity: position.beat === 0 ? countIn.accentVelocity : countIn.velocity,
            },
          ]
        : []
    return { phase: 'count-in', patternStep: null, hits }
  }

  const patternStep = grooveStepIndex(groove, {
    ...position,
    bar: position.bar - countIn.bars,
  })

  const hits: GrooveHit[] = []
  for (const voice of DRUM_VOICES) {
    const track = groove.tracks[voice]
    if (!track) continue
    const velocity = track[patternStep] ?? 0
    if (velocity > 0) hits.push({ voice, velocity })
  }
  return { phase: 'groove', patternStep, hits }
}

/** Drop hits whose voice is muted. Pure. */
export function filterMuted(
  hits: readonly GrooveHit[],
  muted: ReadonlySet<DrumVoice>,
): GrooveHit[] {
  return hits.filter((hit) => !muted.has(hit.voice))
}

// --- GroovePlayer (thin glue) ------------------------------------------------

/** The only thing the player needs from a drum kit. `DrumKit` satisfies it. */
export interface DrumTrigger {
  playDrum(voice: DrumVoice, opts: PlayDrumOptions): void
}

/** The only transport surface the player drives. `Scheduler` satisfies it. */
export interface GrooveTransport {
  onEvent: SchedulerEventCallback | null
  setMeter(meter: { beatsPerBar?: number; subdivisionsPerBeat?: number }): void
  setSwing(swing: number): void
  start(): void
  stop(): void
}

export interface GroovePlayerOptions {
  /** Groove to start with. Defaults to the first shipped groove. */
  groove?: Groove
  /** Count-in pre-roll. Defaults to one accented hat bar. */
  countIn?: CountInConfig
  /** Master enable — when false the player schedules nothing. Default true. */
  enabled?: boolean
  /** Voices muted at construction. */
  muted?: Iterable<DrumVoice>
  /**
   * Drum-bus output level, 0..1 (the Play-Along drum-volume slider). Passed as
   * a `gain` scalar to every `playDrum` so the kit's level is trimmed
   * independently of the engine's master volume and per-hit velocity. Default 1.
   */
  drumVolume?: number
}

/** Clamp a volume scalar into 0..1; NaN -> 1. */
function clampVolume(value: number): number {
  if (Number.isNaN(value)) return 1
  return Math.min(1, Math.max(0, value))
}

/**
 * Connects a `Scheduler` to a `DrumKit`: on every scheduler event it plans the
 * hits (count-in or groove), drops muted voices and triggers `playDrum` at the
 * event's audio time. Owns the mute set, the master enable and the count-in
 * config; all rhythmic math lives in the pure functions above.
 */
export class GroovePlayer {
  private groove: Groove
  private countIn: ResolvedCountIn
  private enabled: boolean
  private readonly muted: Set<DrumVoice>
  private drumVolume: number

  constructor(
    private readonly transport: GrooveTransport,
    private readonly kit: DrumTrigger,
    options: GroovePlayerOptions = {},
  ) {
    this.groove = options.groove ?? DEFAULT_GROOVE
    this.countIn = resolveCountIn(options.countIn)
    this.enabled = options.enabled ?? true
    this.muted = new Set(options.muted ?? [])
    this.drumVolume = clampVolume(options.drumVolume ?? 1)
  }

  /** Current drum-bus level, 0..1. */
  get volume(): number {
    return this.drumVolume
  }

  /** Set the drum-bus level, 0..1 — applied to every hit from the next event on. */
  setVolume(volume: number): void {
    this.drumVolume = clampVolume(volume)
  }

  /** The groove currently loaded. */
  get currentGroove(): Groove {
    return this.groove
  }

  /** Swap the groove and re-apply its grid to the transport. */
  setGroove(groove: Groove): void {
    this.groove = groove
    this.applyGridToTransport()
  }

  /** Bars of count-in currently configured. */
  get countInBars(): number {
    return this.countIn.bars
  }

  /** Reconfigure the count-in pre-roll. */
  setCountIn(config: CountInConfig): void {
    this.countIn = resolveCountIn(config)
  }

  /** Whether the player is currently producing sound. */
  get isEnabled(): boolean {
    return this.enabled
  }

  /** Master enable/disable — silences all output without stopping the transport. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  isMuted(voice: DrumVoice): boolean {
    return this.muted.has(voice)
  }

  /** Voices currently muted, in `DRUM_VOICES` order. */
  get mutedVoices(): DrumVoice[] {
    return DRUM_VOICES.filter((voice) => this.muted.has(voice))
  }

  mute(voice: DrumVoice): void {
    this.muted.add(voice)
  }

  unmute(voice: DrumVoice): void {
    this.muted.delete(voice)
  }

  /** Flip a voice's mute state; returns the new muted state. */
  toggleMute(voice: DrumVoice): boolean {
    if (this.muted.has(voice)) {
      this.muted.delete(voice)
      return false
    }
    this.muted.add(voice)
    return true
  }

  setMuted(voice: DrumVoice, muted: boolean): void {
    if (muted) this.muted.add(voice)
    else this.muted.delete(voice)
  }

  /** Apply the groove's meter/resolution/swing to the transport. */
  private applyGridToTransport(): void {
    const grid = grooveGrid(this.groove)
    this.transport.setMeter({
      beatsPerBar: grid.beatsPerBar,
      subdivisionsPerBeat: grid.subdivisionsPerBeat,
    })
    this.transport.setSwing(grid.swing)
  }

  /** Configure the transport for the current groove, wire events and start. */
  start(): void {
    this.applyGridToTransport()
    this.transport.onEvent = (event, when) => this.handleEvent(event, when)
    this.transport.start()
  }

  /** Stop the transport and detach the event handler. */
  stop(): void {
    this.transport.stop()
    this.transport.onEvent = null
  }

  /**
   * Handle one scheduler event: plan its hits, drop muted voices (groove phase
   * only — the count-in click always sounds) and trigger each at `when`. Public
   * so it can be unit-tested directly with a mock kit.
   */
  handleEvent(event: GridPosition, when: number): void {
    if (!this.enabled) return
    const plan = planEvent(this.groove, event, this.countIn)
    const hits = plan.phase === 'groove' ? filterMuted(plan.hits, this.muted) : plan.hits
    for (const hit of hits) {
      this.kit.playDrum(hit.voice, { when, velocity: hit.velocity, gain: this.drumVolume })
    }
  }
}

// --- Groove data (PURE) ------------------------------------------------------

function clampVelocity(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Build a step lane of `length` cells (all rests) with the given `[index,
 * velocity]` hits filled in. Out-of-range / non-integer indices are ignored and
 * velocities are clamped to 0..1.
 */
export function makeSteps(length: number, hits: Iterable<readonly [number, number]>): Step[] {
  const size = Math.max(0, Math.floor(length))
  const lane: Step[] = new Array<Step>(size).fill(0)
  for (const [index, velocity] of hits) {
    if (Number.isInteger(index) && index >= 0 && index < size) {
      lane[index] = clampVelocity(velocity)
    }
  }
  return lane
}

/**
 * A steady hi-hat/ride lane over every grid step, accenting the beat heads. For
 * a '16th' grid the "&" (mid-beat 8th) sits between the head and the quieter
 * "e/a" sixteenths; for an '8th' grid every off-step uses `off`.
 */
function drivingLane(
  bars: number,
  subsPerBeat: number,
  beatsPerBar: number,
  levels: { head: number; off: number; sixteenth?: number },
): Step[] {
  const length = bars * beatsPerBar * subsPerBeat
  const lane: Step[] = new Array<Step>(length).fill(0)
  const sixteenth = levels.sixteenth ?? levels.off
  for (let i = 0; i < length; i += 1) {
    const posInBeat = i % subsPerBeat
    if (posInBeat === 0) lane[i] = levels.head
    else if (subsPerBeat === 4 && posInBeat === 2) lane[i] = levels.off
    else lane[i] = subsPerBeat === 4 ? sixteenth : levels.off
  }
  return lane
}

/**
 * An eighth-note hi-hat lane on a 16-step (sixteenth) bar: hits on every 8th
 * position (even steps) only, beat heads accented over the off-beats.
 */
function eighthLaneOn16(bars: number, head: number, off: number): Step[] {
  const length = bars * 16
  const lane: Step[] = new Array<Step>(length).fill(0)
  for (let i = 0; i < length; i += 2) {
    lane[i] = i % 4 === 0 ? head : off
  }
  return lane
}

// Rock 8ths — the quintessential straight-eighths beat. Kick on 1 & 3, snare
// backbeat on 2 & 4, driving eighth-note hats with accented beat heads.
const ROCK_8THS: Groove = {
  id: 'rock-8ths',
  name: 'Rock (8ths)',
  description: 'Straight eighths — kick on 1 & 3, backbeat on 2 & 4',
  stepsPerBar: 8,
  subdivision: '8th',
  tracks: {
    kick: makeSteps(8, [
      [0, 0.9],
      [4, 0.9],
    ]),
    snare: makeSteps(8, [
      [2, 0.85],
      [6, 0.85],
    ]),
    'hat-closed': drivingLane(1, 2, 4, { head: 0.62, off: 0.46 }),
  },
}

// Rock 16ths — driving sixteenth-note hats with a syncopated kick.
const ROCK_16THS: Groove = {
  id: 'rock-16ths',
  name: 'Rock (16ths)',
  description: 'Sixteenth-note hats, syncopated kick, backbeat on 2 & 4',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.9],
      [6, 0.82],
      [8, 0.88],
      [14, 0.78],
    ]),
    snare: makeSteps(16, [
      [4, 0.85],
      [12, 0.85],
    ]),
    'hat-closed': drivingLane(1, 4, 4, { head: 0.7, off: 0.5, sixteenth: 0.4 }),
  },
}

// Funk — syncopated sixteenth kick, backbeat plus quiet ghost-note snares that
// fill the pocket between the accents.
const FUNK: Groove = {
  id: 'funk',
  name: 'Funk',
  description: 'Syncopated 16th kick with ghost-note snares',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.9],
      [3, 0.6],
      [6, 0.85],
      [10, 0.7],
    ]),
    snare: makeSteps(16, [
      [2, 0.2], // ghost
      [4, 0.9], // backbeat
      [7, 0.22], // ghost
      [11, 0.2], // ghost
      [12, 0.9], // backbeat
      [14, 0.25], // ghost
    ]),
    'hat-closed': drivingLane(1, 4, 4, { head: 0.64, off: 0.48, sixteenth: 0.36 }),
  },
}

// Swing / shuffle — jazz ride-driven triplet feel. Classic "spang-a-lang" ride,
// foot hats on 2 & 4, feathered kick on 1 & 3, light snare comping. The triplet
// grid carries the shuffle so no swing offset is needed.
const SWING: Groove = {
  id: 'swing',
  name: 'Swing / Shuffle',
  description: 'Jazz ride pattern over a triplet feel — ride-driven',
  stepsPerBar: 12,
  subdivision: 'triplet',
  tracks: {
    ride: makeSteps(12, [
      [0, 0.7],
      [3, 0.7],
      [5, 0.55],
      [6, 0.7],
      [9, 0.7],
      [11, 0.55],
    ]),
    'hat-closed': makeSteps(12, [
      [3, 0.5],
      [9, 0.5],
    ]),
    kick: makeSteps(12, [
      [0, 0.3], // feathered
      [6, 0.3],
    ]),
    snare: makeSteps(12, [[9, 0.4]]),
  },
}

// Bossa nova — a two-bar cross-stick clave (played on the snare as a side
// stick), two-feel kick and gentle eighth-note hats.
const BOSSA: Groove = {
  id: 'bossa',
  name: 'Bossa Nova',
  description: 'Two-bar cross-stick clave with a two-feel kick',
  stepsPerBar: 16,
  subdivision: '16th',
  bars: 2,
  tracks: {
    kick: makeSteps(32, [
      [0, 0.7],
      [8, 0.7],
      [14, 0.55],
      [16, 0.7],
      [24, 0.7],
      [30, 0.55],
    ]),
    // 3-2 clave-ish cross stick across the two bars.
    snare: makeSteps(32, [
      [0, 0.5],
      [6, 0.5],
      [10, 0.5],
      [20, 0.5],
      [26, 0.5],
    ]),
    'hat-closed': eighthLaneOn16(2, 0.5, 0.4),
  },
}

// 12/8 blues shuffle — the long-short triplet cymbal shuffle over a 12/8 pulse,
// kick on 1 & 3, snare backbeat on 2 & 4.
const BLUES_12_8: Groove = {
  id: 'blues-12-8',
  name: '12/8 Blues Shuffle',
  description: 'Triplet cymbal shuffle over a 12/8 pulse',
  stepsPerBar: 12,
  subdivision: 'triplet',
  tracks: {
    ride: makeSteps(12, [
      [0, 0.7],
      [2, 0.5],
      [3, 0.7],
      [5, 0.5],
      [6, 0.7],
      [8, 0.5],
      [9, 0.7],
      [11, 0.5],
    ]),
    kick: makeSteps(12, [
      [0, 0.85],
      [6, 0.8],
    ]),
    snare: makeSteps(12, [
      [3, 0.85],
      [9, 0.85],
    ]),
  },
}

// Half-time — the backbeat lands only on beat 3, halving the perceived pulse.
const HALF_TIME: Groove = {
  id: 'half-time',
  name: 'Half-Time',
  description: 'Single backbeat on beat 3 for a slowed, spacious feel',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.9],
      [10, 0.75],
    ]),
    snare: makeSteps(16, [[8, 0.9]]),
    'hat-closed': eighthLaneOn16(1, 0.6, 0.45),
  },
}

// Disco — four-on-the-floor. Kick on every beat, backbeat snare on 2 & 4, and
// the signature open hi-hat on the off-beat eighths. A closed hat lands on each
// beat and, sharing the 'hats' choke group, "pedals" the open hat shut — the
// pumping disco hat action.
const DISCO: Groove = {
  id: 'disco',
  name: 'Disco',
  description: 'Four-on-the-floor kick with open-hat offbeats',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.9],
      [4, 0.9],
      [8, 0.9],
      [12, 0.9],
    ]),
    snare: makeSteps(16, [
      [4, 0.82],
      [12, 0.82],
    ]),
    'hat-open': makeSteps(16, [
      [2, 0.5],
      [6, 0.5],
      [10, 0.5],
      [14, 0.5],
    ]),
    'hat-closed': makeSteps(16, [
      [0, 0.5],
      [4, 0.5],
      [8, 0.5],
      [12, 0.5],
    ]),
  },
}

// Motown / soul — a snappy backbeat on 2 & 4 over steady eighth-note hats, with
// a syncopated kick that pushes the "&" of 2 and 4.
const MOTOWN: Groove = {
  id: 'motown',
  name: 'Motown / Soul',
  description: 'Backbeat on 2 & 4, eighth hats, syncopated kick',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.9],
      [6, 0.6],
      [8, 0.85],
      [14, 0.6],
    ]),
    snare: makeSteps(16, [
      [4, 0.85],
      [12, 0.85],
    ]),
    'hat-closed': eighthLaneOn16(1, 0.6, 0.45),
  },
}

// Reggae one-drop — the defining reggae feel: beat 1 is empty (the "drop"),
// kick and snare land together on beat 3, and the closed hat skanks the
// off-beat eighths.
const REGGAE_ONE_DROP: Groove = {
  id: 'reggae-one-drop',
  name: 'Reggae One-Drop',
  description: 'Empty downbeat; kick + snare together on beat 3',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [[8, 0.9]]),
    snare: makeSteps(16, [[8, 0.85]]),
    'hat-closed': makeSteps(16, [
      [2, 0.5],
      [6, 0.5],
      [10, 0.5],
      [14, 0.5],
    ]),
  },
}

// Train beat — the driving "boom-chick" locomotive shuffle: a constant stream
// of sixteenth-note snares, accented hard on the 2 & 4 backbeat and ghosted in
// between, with a simple 1-&-3 kick and a light quarter-note hat.
const TRAIN_BEAT: Groove = {
  id: 'train-beat',
  name: 'Train Beat',
  description: 'Driving sixteenth-note snare with a 2 & 4 backbeat',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.85],
      [8, 0.85],
    ]),
    snare: makeSteps(16, [
      [0, 0.45],
      [1, 0.28],
      [2, 0.28],
      [3, 0.28],
      [4, 0.85],
      [5, 0.28],
      [6, 0.28],
      [7, 0.28],
      [8, 0.45],
      [9, 0.28],
      [10, 0.28],
      [11, 0.28],
      [12, 0.85],
      [13, 0.28],
      [14, 0.28],
      [15, 0.28],
    ]),
    'hat-closed': makeSteps(16, [
      [0, 0.4],
      [4, 0.4],
      [8, 0.4],
      [12, 0.4],
    ]),
  },
}

// Half-time shuffle — the Purdie/Bonham feel: a triplet-grid shuffle with a
// single half-time backbeat on beat 3 and quiet ghost-note snares on the
// triplet "let" of the other beats. The long-short hat rides the first and last
// partial of each beat. Written on the triplet grid so the shuffle lives in the
// note placement (no swing offset needed).
//
// GRID LIMIT: a true half-time shuffle layers ghost sixteenths *between* the
// shuffled triplets — a feel that needs both a triplet and a straight-16th grid
// at once, which the single-resolution step format can't express. This captures
// the essential triplet-ghost shuffle; the interleaved 16ths are omitted.
const HALF_TIME_SHUFFLE: Groove = {
  id: 'half-time-shuffle',
  name: 'Half-Time Shuffle',
  description: 'Triplet shuffle with a half-time backbeat and ghost snares',
  stepsPerBar: 12,
  subdivision: 'triplet',
  tracks: {
    'hat-closed': makeSteps(12, [
      [0, 0.55],
      [2, 0.42],
      [3, 0.55],
      [5, 0.42],
      [6, 0.55],
      [8, 0.42],
      [9, 0.55],
      [11, 0.42],
    ]),
    kick: makeSteps(12, [
      [0, 0.85],
      [8, 0.5],
    ]),
    snare: makeSteps(12, [
      [2, 0.2], // ghost
      [5, 0.2], // ghost
      [6, 0.9], // half-time backbeat on beat 3
      [11, 0.2], // ghost
    ]),
  },
}

// 16th-note funk — a busier cousin of the Funk groove: a densely syncopated
// sixteenth kick, a hard 2 & 4 backbeat threaded with ghost snares, and
// driving sixteenth-note hats.
const FUNK_16: Groove = {
  id: 'funk-16',
  name: 'Funk (16ths)',
  description: 'Busy syncopated 16th kick with ghost snares and 16th hats',
  stepsPerBar: 16,
  subdivision: '16th',
  tracks: {
    kick: makeSteps(16, [
      [0, 0.9],
      [3, 0.6],
      [6, 0.8],
      [8, 0.85],
      [11, 0.6],
      [14, 0.7],
    ]),
    snare: makeSteps(16, [
      [2, 0.22], // ghost
      [4, 0.9], // backbeat
      [7, 0.22], // ghost
      [10, 0.22], // ghost
      [12, 0.9], // backbeat
      [15, 0.24], // ghost
    ]),
    'hat-closed': drivingLane(1, 4, 4, { head: 0.62, off: 0.46, sixteenth: 0.34 }),
  },
}

/** All shipped grooves, in picker order. */
export const GROOVES: readonly Groove[] = [
  ROCK_8THS,
  ROCK_16THS,
  FUNK,
  FUNK_16,
  SWING,
  BOSSA,
  BLUES_12_8,
  HALF_TIME,
  HALF_TIME_SHUFFLE,
  DISCO,
  MOTOWN,
  REGGAE_ONE_DROP,
  TRAIN_BEAT,
]

/** The default groove a fresh player loads. */
export const DEFAULT_GROOVE: Groove = ROCK_8THS

const GROOVES_BY_ID: Record<string, Groove> = Object.fromEntries(
  GROOVES.map((groove) => [groove.id, groove]),
)

/** Whether a string names a shipped groove. */
export function isGrooveId(value: unknown): value is string {
  return typeof value === 'string' && value in GROOVES_BY_ID
}

/** Look up a groove by id, falling back to the default for unknown ids. */
export function getGroove(id: string): Groove {
  return GROOVES_BY_ID[id] ?? DEFAULT_GROOVE
}
