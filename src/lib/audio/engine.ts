/**
 * Web Audio engine core.
 *
 * Design goals:
 *  - The AudioContext is created lazily and only from a user gesture (browsers
 *    refuse to start audio otherwise). Nothing here touches `window` or
 *    `AudioContext` at module-load time, so importing this file in the `node`
 *    test environment is safe. `ensureRunning()` is the gesture-time entry
 *    point that creates + resumes the context.
 *  - Every sound source feeds a single master chain
 *    (`voice/source -> master gain -> limiter -> destination`) so a drum synth
 *    (added later) can connect into the same `getMasterInput()` node and share
 *    the master volume + limiting.
 *  - All gain automation comes from the pure `envelope.ts` planner, so the
 *    only untestable part is the thin node wiring below.
 *
 * The engine talks to Web Audio through the minimal structural interfaces
 * below rather than the concrete DOM types. A real `AudioContext` satisfies
 * `MinimalAudioContext` structurally, and tests can pass a fake — no real
 * AudioContext is ever constructed in tests.
 */

import { midiToFreq, type Midi } from '../theory/notes.ts'
import { DrumKit, type DrumVoice, type PlayDrumOptions } from './drums.ts'
import {
  clamp01,
  computeEnvelope,
  resolveAdsr,
  velocityToGain,
  type AdsrParams,
} from './envelope.ts'

// --- Minimal structural Web Audio surface ----------------------------------

export interface AudioParamLike {
  value: number
  setValueAtTime(value: number, startTime: number): unknown
  linearRampToValueAtTime(value: number, endTime: number): unknown
  exponentialRampToValueAtTime(value: number, endTime: number): unknown
  cancelScheduledValues(cancelTime: number): unknown
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown
  disconnect(): void
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike
}

export interface OscillatorNodeLike extends AudioNodeLike {
  type: OscillatorType
  readonly frequency: AudioParamLike
  readonly detune: AudioParamLike
  onended: unknown
  start(when?: number): void
  stop(when?: number): void
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: BiquadFilterType
  readonly frequency: AudioParamLike
  readonly Q: AudioParamLike
}

export interface AudioBufferLike {
  getChannelData(channel: number): Float32Array
}

export interface AudioBufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null
  onended: unknown
  start(when?: number): void
  stop(when?: number): void
}

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike
  readonly knee: AudioParamLike
  readonly ratio: AudioParamLike
  readonly attack: AudioParamLike
  readonly release: AudioParamLike
}

export interface MinimalAudioContext {
  readonly currentTime: number
  readonly sampleRate: number
  readonly state: AudioContextState
  readonly destination: AudioNodeLike
  createGain(): GainNodeLike
  createOscillator(): OscillatorNodeLike
  createBiquadFilter(): BiquadFilterNodeLike
  createBufferSource(): AudioBufferSourceNodeLike
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferLike
  createDynamicsCompressor(): DynamicsCompressorNodeLike
  resume(): Promise<void>
}

/** Factory for the underlying context; injectable so tests can supply a fake. */
export type AudioContextFactory = () => MinimalAudioContext

// --- Constants --------------------------------------------------------------

/** Default master volume (0..1). */
export const DEFAULT_MASTER_VOLUME = 0.8

/**
 * Per-voice headroom. Two detuned oscillators sum, and chords stack several
 * voices, so each voice peaks well below 1 and the master limiter catches the
 * rest without audible pumping.
 */
const VOICE_LEVEL = 0.35

/** Short ramp used when changing the master volume so it never clicks. */
const VOLUME_RAMP = 0.02

/** Shortest fade-in of a click so a hard-step attack transient never clicks. */
const CLICK_ATTACK = 0.0008
/**
 * Floor for exponential ramps to "silence" — `exponentialRampToValueAtTime`
 * cannot target 0. A tiny positive value reads as silent while giving a
 * natural percussive decay curve (unlike a linear ramp, which sounds abrupt).
 */
const CLICK_FLOOR = 0.0001

// --- Options ----------------------------------------------------------------

export interface PlayNoteOptions extends Partial<AdsrParams> {
  /** 0..1, applied (with a mild curve) to the peak gain. Default 1. */
  velocity?: number
  /** Absolute AudioContext start time. Default: now. */
  when?: number
  /** Oscillator waveform. Default `'sawtooth'`. */
  type?: OscillatorType
  /**
   * Chorus spread in cents between the two oscillators (they sit at ±detune/2).
   * Default 8. Pass 0 for a single-pitch, phase-locked pair.
   */
  detune?: number
}

/**
 * The tone generator for a click voice. Either a pitched oscillator (with an
 * optional fast pitch drop for a woodblock-style "tok") or a white-noise burst
 * (shaped by a bandpass `filter` into a rim/tick sound).
 */
export type ClickSource =
  | {
      kind: 'osc'
      type: OscillatorType
      /** Start pitch in Hz. */
      frequency: number
      /** Optional pitch-drop target; the pitch ramps here over the duration. */
      endFrequency?: number
    }
  | { kind: 'noise' }

/**
 * A fully-resolved recipe for one synthesized click, produced by the pure
 * voice/accent tables in `clickVoices.ts`. The engine just wires the nodes;
 * every timbral decision lives in the (testable) parameters here.
 */
export interface ClickSpec {
  /** Peak linear gain, 0..1. */
  gain: number
  /** Total length in seconds. Kept short so a click never rings. */
  duration: number
  /** Fade-in time in seconds — larger reads as a softer, gentler attack. */
  attack: number
  /** The tone generator. */
  source: ClickSource
  /** Optional single biquad filter to warm (lowpass) or shape (bandpass) it. */
  filter?: { type: BiquadFilterType; frequency: number; q: number }
  /** Absolute AudioContext start time. Default: now. */
  when?: number
}

// --- Engine -----------------------------------------------------------------

export class AudioEngine {
  private ctx: MinimalAudioContext | null = null
  private master: GainNodeLike | null = null
  private volume = DEFAULT_MASTER_VOLUME
  private drumKit: DrumKit | null = null

  constructor(private readonly createContext: AudioContextFactory = defaultContextFactory) {}

  /**
   * Lazily create the context and master chain. Safe to call repeatedly; only
   * builds the graph once. Never call from module scope — only from within a
   * method invoked by a user gesture.
   */
  private init(): { ctx: MinimalAudioContext; master: GainNodeLike } {
    if (this.ctx && this.master) return { ctx: this.ctx, master: this.master }

    const ctx = this.createContext()
    const master = ctx.createGain()
    master.gain.value = this.volume

    // Gentle master limiter / soft clip to tame stacked voices.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -6
    limiter.knee.value = 30
    limiter.ratio.value = 12
    limiter.attack.value = 0.003
    limiter.release.value = 0.25

    master.connect(limiter)
    limiter.connect(ctx.destination)

    this.ctx = ctx
    this.master = master
    return { ctx, master }
  }

  /**
   * Create + resume the context. MUST be called from a user gesture (click,
   * key, touch) before any audio will actually play. Resolves once the context
   * is running.
   */
  async ensureRunning(): Promise<void> {
    const { ctx } = this.init()
    if (ctx.state !== 'running') await ctx.resume()
  }

  /** Whether the context has been created yet. */
  get isInitialized(): boolean {
    return this.ctx !== null
  }

  /**
   * The audio clock in seconds (0 before the context exists). Exposed so the
   * engine satisfies the scheduler's `SchedulerClock` interface structurally —
   * `new Scheduler(engine, …)` — keeping scheduled `when` times and the
   * engine's playback on a single, shared time base.
   */
  get currentTime(): number {
    return this.ctx?.currentTime ?? 0
  }

  /** Current master volume (0..1). */
  get masterVolume(): number {
    return this.volume
  }

  /** Set master volume (0..1); ramps briefly to avoid clicks. */
  setMasterVolume(volume: number): void {
    this.volume = clamp01(volume)
    if (this.master && this.ctx) {
      const now = this.ctx.currentTime
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.linearRampToValueAtTime(this.volume, now + VOLUME_RAMP)
    }
  }

  /**
   * The node every sound source should connect into. Ensures the master chain
   * exists so other synths (e.g. a future drum synth) can share it.
   */
  getMasterInput(): GainNodeLike {
    return this.init().master
  }

  /**
   * Play a single note. Builds a short-lived voice (two detuned oscillators
   * into a per-note gain running the ADSR envelope) and tears it down once the
   * release tail has finished, so nothing leaks.
   */
  playNote(midi: Midi, duration: number, opts: PlayNoteOptions = {}): void {
    const { ctx, master } = this.init()
    const when = opts.when ?? ctx.currentTime
    const params = resolveAdsr(opts)
    const peak = VOICE_LEVEL * velocityToGain(opts.velocity ?? 1)
    const env = computeEnvelope({ startTime: when, duration, peak, params })

    const waveform: OscillatorType = opts.type ?? 'sawtooth'
    const spread = (opts.detune ?? 8) / 2
    const freq = midiToFreq(midi)

    const voiceGain = ctx.createGain()
    voiceGain.gain.value = 0
    voiceGain.connect(master)

    // Run the pure envelope plan onto the voice gain.
    const gain = voiceGain.gain
    gain.cancelScheduledValues(when)
    for (const point of env.points) {
      if (point.ramp === 'set') gain.setValueAtTime(point.value, point.time)
      else gain.linearRampToValueAtTime(point.value, point.time)
    }

    const oscillators: OscillatorNodeLike[] = []
    for (const cents of [-spread, spread]) {
      const osc = ctx.createOscillator()
      osc.type = waveform
      osc.frequency.setValueAtTime(freq, when)
      osc.detune.setValueAtTime(cents, when)
      osc.connect(voiceGain)
      oscillators.push(osc)
    }

    // Tear down after the last oscillator ends, avoiding node leaks.
    let ended = 0
    const cleanup = (): void => {
      ended += 1
      if (ended < oscillators.length) return
      for (const osc of oscillators) osc.disconnect()
      voiceGain.disconnect()
    }
    for (const osc of oscillators) {
      osc.onended = cleanup
      osc.start(when)
      osc.stop(env.stopTime)
    }
  }

  /**
   * Play a short percussive click (metronome tick, count-in, etc.) through the
   * shared master chain, following a synthesized `ClickSpec`: a soft-ish fade-in
   * followed by an exponential decay to silence (percussive, no ring), an
   * oscillator or noise source, and an optional biquad filter. The voice/accent
   * design lives in the pure `clickVoices.ts` tables — this just wires nodes.
   */
  playClick(spec: ClickSpec): void {
    const { ctx, master } = this.init()
    const when = spec.when ?? ctx.currentTime
    const peak = Math.max(CLICK_FLOOR, clamp01(spec.gain))
    const attack = Math.max(CLICK_ATTACK, spec.attack)
    const duration = Math.max(attack + 0.004, spec.duration)
    const stopAt = when + duration + 0.01

    // Percussive envelope: quick (or soft) fade-in, exponential fall to silence.
    const clickGain = ctx.createGain()
    clickGain.gain.value = 0
    clickGain.connect(master)
    clickGain.gain.setValueAtTime(CLICK_FLOOR, when)
    clickGain.gain.linearRampToValueAtTime(peak, when + attack)
    clickGain.gain.exponentialRampToValueAtTime(CLICK_FLOOR, when + duration)

    // Optional single filter node sits between the source and the gain.
    let sourceTarget: AudioNodeLike = clickGain
    let filter: BiquadFilterNodeLike | null = null
    if (spec.filter) {
      filter = ctx.createBiquadFilter()
      filter.type = spec.filter.type
      filter.frequency.setValueAtTime(spec.filter.frequency, when)
      filter.Q.setValueAtTime(spec.filter.q, when)
      filter.connect(clickGain)
      sourceTarget = filter
    }

    const teardown = (source: AudioNodeLike): void => {
      source.disconnect()
      filter?.disconnect()
      clickGain.disconnect()
    }

    if (spec.source.kind === 'noise') {
      const noise = this.makeNoiseSource(ctx, duration)
      noise.connect(sourceTarget)
      noise.onended = (): void => teardown(noise)
      noise.start(when)
      noise.stop(stopAt)
      return
    }

    const osc = ctx.createOscillator()
    osc.type = spec.source.type
    osc.frequency.setValueAtTime(spec.source.frequency, when)
    if (spec.source.endFrequency !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(CLICK_FLOOR, spec.source.endFrequency),
        when + duration,
      )
    }
    osc.connect(sourceTarget)
    osc.onended = (): void => teardown(osc)
    osc.start(when)
    osc.stop(stopAt)
  }

  /** Build a one-shot white-noise buffer source long enough to cover `duration`. */
  private makeNoiseSource(
    ctx: MinimalAudioContext,
    duration: number,
  ): AudioBufferSourceNodeLike {
    const length = Math.max(1, Math.ceil(ctx.sampleRate * duration))
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
    const source = ctx.createBufferSource()
    source.buffer = buffer
    return source
  }

  /** Play several notes at once with shared options. */
  playChord(midis: readonly Midi[], duration: number, opts: PlayNoteOptions = {}): void {
    for (const midi of midis) this.playNote(midi, duration, opts)
  }

  /**
   * Play a synthesized drum voice (kick, snare, hats, ride) through the shared
   * master chain. The kit is created lazily on first use and shares the engine's
   * context + master input, so drums pass through the same volume + limiter as
   * every other sound. Scheduling is `when`-relative for the groove engine, and
   * hi-hat choke groups are handled inside the kit.
   */
  playDrum(voice: DrumVoice, opts: PlayDrumOptions = {}): void {
    this.init()
    if (!this.drumKit) {
      this.drumKit = new DrumKit(() => {
        const { ctx, master } = this.init()
        return { context: ctx, destination: master }
      })
    }
    this.drumKit.playDrum(voice, opts)
  }
}

/** Default factory: constructs a real AudioContext. Only invoked at first use. */
function defaultContextFactory(): MinimalAudioContext {
  const Ctor: typeof AudioContext =
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? AudioContext
  return new Ctor()
}

let singleton: AudioEngine | null = null

/** Lazily-created shared engine for the app. */
export function getAudioEngine(): AudioEngine {
  if (!singleton) singleton = new AudioEngine()
  return singleton
}
