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

export interface DynamicsCompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike
  readonly knee: AudioParamLike
  readonly ratio: AudioParamLike
  readonly attack: AudioParamLike
  readonly release: AudioParamLike
}

export interface MinimalAudioContext {
  readonly currentTime: number
  readonly state: AudioContextState
  readonly destination: AudioNodeLike
  createGain(): GainNodeLike
  createOscillator(): OscillatorNodeLike
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

// --- Engine -----------------------------------------------------------------

export class AudioEngine {
  private ctx: MinimalAudioContext | null = null
  private master: GainNodeLike | null = null
  private volume = DEFAULT_MASTER_VOLUME

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

  /** Play several notes at once with shared options. */
  playChord(midis: readonly Midi[], duration: number, opts: PlayNoteOptions = {}): void {
    for (const midi of midis) this.playNote(midi, duration, opts)
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
