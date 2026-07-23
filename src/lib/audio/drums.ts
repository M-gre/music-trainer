/**
 * Synthesized drum kit — kick, snare, hi-hats (closed/open) and ride, built
 * entirely from Web Audio primitives (oscillators + white noise + biquad
 * filters + gain envelopes). No samples, no network.
 *
 * The split mirrors the metronome click design:
 *  - The PURE half — the `DRUM_VOICE_DEFS` parameter tables and `resolveDrumSpec`
 *    — contains every timbral decision (frequencies, envelope times, gains,
 *    filters, choke grouping) as plain data. It has NO Web Audio calls and never
 *    touches `window`, so it is fully unit-testable under the `node` env and the
 *    voices can be balanced against each other by inspection.
 *  - The `DrumKit` class is the thin wiring layer: given a lazily-resolved
 *    context + destination (the engine's master input), it builds the short-lived
 *    node graph a `DrumSpec` describes, schedules everything relative to a `when`
 *    timestamp (so the groove engine can drive it), and tears the nodes down when
 *    they finish. It also owns the small amount of state choke groups need.
 *
 * A drum voice is one or more parallel *layers*. Each layer is either a pitched
 * tone (optionally with a fast pitch drop — the kick's body) or a white-noise
 * burst, run through an optional series of biquad filters and its own percussive
 * gain envelope (linear fade-in, exponential decay to silence).
 *
 * Choke groups model real hi-hat behaviour: closed and open hats share the
 * `'hats'` group, so hitting either one silences an open hat that is still
 * ringing.
 */

import type {
  AudioNodeLike,
  AudioBufferSourceNodeLike,
  BiquadFilterNodeLike,
  GainNodeLike,
  MinimalAudioContext,
  OscillatorNodeLike,
} from './engine.ts'
import { clamp01, velocityToGain } from './envelope.ts'

// --- Voice identity ---------------------------------------------------------

/** The synthesized drum voices. */
export const DRUM_VOICES = ['kick', 'snare', 'hat-closed', 'hat-open', 'ride'] as const
export type DrumVoice = (typeof DRUM_VOICES)[number]

/** Whether a string names a known drum voice. */
export function isDrumVoice(value: unknown): value is DrumVoice {
  return typeof value === 'string' && (DRUM_VOICES as readonly string[]).includes(value)
}

// --- Spec model (pure data the DrumKit renders) -----------------------------

/** One biquad filter in a layer's series filter chain. */
export interface DrumFilter {
  type: BiquadFilterType
  frequency: number
  q: number
}

interface BaseLayer {
  /** Peak linear gain of this layer, 0..1. */
  gain: number
  /** Fade-in time (seconds) — kept tiny so the transient stays punchy. */
  attack: number
  /** Exponential decay time (seconds) from peak to silence. */
  decay: number
  /** Optional filters applied in series between the source and the layer gain. */
  filters?: DrumFilter[]
}

/** A pitched oscillator layer, optionally with a fast downward pitch drop. */
export interface DrumToneLayer extends BaseLayer {
  source: 'tone'
  wave: OscillatorType
  /** Start pitch in Hz. */
  startFreq: number
  /** Pitch-drop target in Hz; the pitch ramps here over `pitchDrop` seconds. */
  endFreq?: number
  /** Time (seconds) over which the pitch falls to `endFreq`. */
  pitchDrop?: number
}

/** A white-noise burst layer (the body of snares, hats and the ride). */
export interface DrumNoiseLayer extends BaseLayer {
  source: 'noise'
}

export type DrumLayer = DrumToneLayer | DrumNoiseLayer

/** A fully-resolved recipe for one drum hit. */
export interface DrumSpec {
  voice: DrumVoice
  layers: DrumLayer[]
  /**
   * Choke-group id. Triggering any voice in a group silences the currently
   * ringing voice(s) of that same group (hi-hat choke).
   */
  chokeGroup?: string
}

// --- Parameter tables (PURE) ------------------------------------------------

interface DrumVoiceDef {
  chokeGroup?: string
  /** Base layers at nominal velocity (1.0). */
  layers: DrumLayer[]
}

/**
 * Per-voice synthesis parameters at velocity 1. Levels are balanced by hand so
 * the drum kit reads as the *backbone* of the play-along mix (louder than the
 * comping pad, which sits at a moderate velocity), while staying internally
 * balanced. The target balance, expressed as each voice's summed layer peak
 * gain at velocity 1:
 *   - kick   ≈ 1.08 — loudest, a solid low-end thump that anchors the groove;
 *   - snare  ≈ 0.74 — present and cracking, clearly above the cymbals;
 *   - open hat ≈ 0.48 / closed hat ≈ 0.42 — crisp but never hissy-loud;
 *   - ride   ≈ 0.36 — an airy wash, quietest in the mix.
 * These are the velocity-1 peaks; actual hits scale by `velocityToGain(v)` (a
 * square law), so a 0.9-velocity backbeat kick peaks near 0.87, leaving the
 * master limiter (threshold -6 dB, 12:1) ample room to tame the rare instant
 * where kick + snare + hat coincide. Voices occupy different frequency bands,
 * so their peaks rarely stack destructively.
 */
export const DRUM_VOICE_DEFS: Record<DrumVoice, DrumVoiceDef> = {
  // Sine body with a fast 150 -> 50 Hz pitch drop (the "thump"), plus a short
  // high-passed noise click for beater attack definition. Loudest voice — the
  // backbone of every groove.
  kick: {
    layers: [
      {
        source: 'tone',
        wave: 'sine',
        startFreq: 150,
        endFreq: 50,
        pitchDrop: 0.08,
        gain: 0.92,
        attack: 0.002,
        decay: 0.4,
      },
      {
        source: 'noise',
        gain: 0.16,
        attack: 0.0005,
        decay: 0.02,
        filters: [{ type: 'highpass', frequency: 1500, q: 0.7 }],
      },
    ],
  },
  // Bright high-passed noise burst plus a short ~185 Hz tonal body. Cracks
  // clearly through above the cymbals.
  snare: {
    layers: [
      {
        source: 'noise',
        gain: 0.44,
        attack: 0.0008,
        decay: 0.18,
        filters: [
          { type: 'highpass', frequency: 1200, q: 0.7 },
          { type: 'bandpass', frequency: 3200, q: 0.6 },
        ],
      },
      {
        source: 'tone',
        wave: 'triangle',
        startFreq: 185,
        endFreq: 150,
        pitchDrop: 0.1,
        gain: 0.3,
        attack: 0.001,
        decay: 0.12,
      },
    ],
  },
  // Metallic high-passed noise, very short — the closed hat "tick". Crisp but
  // deliberately kept below the snare so it never hisses over the groove.
  'hat-closed': {
    chokeGroup: 'hats',
    layers: [
      {
        source: 'noise',
        gain: 0.42,
        attack: 0.0005,
        decay: 0.05,
        filters: [
          { type: 'highpass', frequency: 7000, q: 0.7 },
          { type: 'bandpass', frequency: 10000, q: 0.8 },
        ],
      },
    ],
  },
  // Same metallic character, long decay; choked by any hat hit.
  'hat-open': {
    chokeGroup: 'hats',
    layers: [
      {
        source: 'noise',
        gain: 0.48,
        attack: 0.0006,
        decay: 0.4,
        filters: [
          { type: 'highpass', frequency: 7000, q: 0.7 },
          { type: 'bandpass', frequency: 10000, q: 0.8 },
        ],
      },
    ],
  },
  // High, airy metallic wash — long sustain, quietest in the mix.
  ride: {
    layers: [
      {
        source: 'noise',
        gain: 0.36,
        attack: 0.001,
        decay: 0.8,
        filters: [
          { type: 'highpass', frequency: 8000, q: 0.6 },
          { type: 'bandpass', frequency: 11000, q: 0.7 },
        ],
      },
    ],
  },
}

/**
 * Loudness band the per-voice summed peak gains are calibrated to fall within.
 * Used by the balance test; also documents the intended mix range. Widened when
 * the kit was pushed up to sit as the mix backbone (kick ≈ 1.08, ride ≈ 0.36).
 */
export const DRUM_LOUDNESS_BAND = { min: 0.3, max: 1.15 } as const

/** Sum of a spec's layer peak gains — a rough proxy for its peak loudness. */
export function drumPeakLevel(spec: DrumSpec): number {
  return spec.layers.reduce((sum, layer) => sum + layer.gain, 0)
}

// --- Velocity-aware resolution (PURE) ---------------------------------------

/**
 * Resolve a voice's parameter table into a concrete `DrumSpec`, applying
 * velocity. Velocity scales gain (with the shared mild curve) and, subtly and
 * cheaply, decay length and filter brightness — harder hits ring a touch longer
 * and brighter, softer hits are duller, both centred on the nominal design at
 * velocity 1.
 */
export function resolveDrumSpec(voice: DrumVoice, velocity = 1): DrumSpec {
  const def = DRUM_VOICE_DEFS[voice]
  const v = clamp01(velocity)
  const gainScale = velocityToGain(v)
  // Centred so v = 1 reproduces the nominal table exactly.
  const decayScale = 0.7 + 0.3 * v
  const brightScale = 0.75 + 0.25 * v

  const layers = def.layers.map((layer): DrumLayer => {
    const filters = layer.filters?.map(
      (f): DrumFilter => ({ ...f, frequency: f.frequency * brightScale }),
    )
    const common = {
      gain: clamp01(layer.gain * gainScale),
      attack: layer.attack,
      decay: layer.decay * decayScale,
      ...(filters ? { filters } : {}),
    }
    if (layer.source === 'tone') {
      return {
        source: 'tone',
        wave: layer.wave,
        startFreq: layer.startFreq,
        ...(layer.endFreq !== undefined ? { endFreq: layer.endFreq } : {}),
        ...(layer.pitchDrop !== undefined ? { pitchDrop: layer.pitchDrop } : {}),
        ...common,
      }
    }
    return { source: 'noise', ...common }
  })

  return {
    voice,
    layers,
    ...(def.chokeGroup ? { chokeGroup: def.chokeGroup } : {}),
  }
}

// --- DrumKit (node wiring + choke state) ------------------------------------

/** Options for a single drum hit. */
export interface PlayDrumOptions {
  /** Absolute AudioContext start time. Default: now. */
  when?: number
  /** 0..1, scales gain (and subtly brightness/decay). Default 1. */
  velocity?: number
  /**
   * Linear output-level scalar applied to every layer's peak gain, ≥ 0 (default
   * 1). A clean level trim decoupled from `velocity`: velocity shapes a hit's
   * dynamics and brightness, this just scales the whole kit's bus. The
   * Play-Along drum-volume slider passes it so the drums can sit above/below the
   * comp without touching per-hit dynamics or the engine's master volume.
   */
  gain?: number
}

/**
 * Resolves the live context + destination node the kit renders into. Injected
 * so the DrumKit shares the engine's lazily-created context and master input
 * without owning either.
 */
export type DrumKitTarget = () => {
  context: MinimalAudioContext
  destination: AudioNodeLike
}

/** Floor for exponential ramps to "silence" (can't target 0). */
const DRUM_FLOOR = 0.0001
/** Minimum fade-in, so a hard-step attack never clicks. */
const DRUM_MIN_ATTACK = 0.0005
/** Fast fade applied when a hit chokes a ringing voice in its group. */
const CHOKE_FADE = 0.008
/** Extra tail after a source's envelope reaches silence before stopping it. */
const STOP_TAIL = 0.02

/** A source node with the start/stop + onended surface the kit drives. */
type DrumSourceNode = OscillatorNodeLike | AudioBufferSourceNodeLike

/** A voice currently ringing that a later hit in its group may choke. */
interface ActiveVoice {
  group: string
  gains: GainNodeLike[]
  sources: DrumSourceNode[]
}

export class DrumKit {
  /** Voices still ringing that belong to a choke group, newest last. */
  private active: ActiveVoice[] = []

  constructor(private readonly getTarget: DrumKitTarget) {}

  /**
   * Play one drum voice. All node start/stop and gain/pitch automation is
   * scheduled relative to `when` (default: the context clock), so the groove
   * engine can queue hits ahead of time on the shared audio timeline.
   */
  playDrum(voice: DrumVoice, opts: PlayDrumOptions = {}): void {
    const { context, destination } = this.getTarget()
    const when = opts.when ?? context.currentTime
    const spec = resolveDrumSpec(voice, opts.velocity ?? 1)
    const levelScale = Math.max(0, opts.gain ?? 1)

    if (spec.chokeGroup) this.choke(spec.chokeGroup, when)

    const gains: GainNodeLike[] = []
    const sources: DrumSourceNode[] = []
    // Node teardown once every source in this hit has ended.
    let pending = 0
    let ended = 0
    const disposers: Array<() => void> = []
    const finish = (): void => {
      ended += 1
      if (ended < pending) return
      for (const dispose of disposers) dispose()
    }

    for (const layer of spec.layers) {
      const attack = Math.max(DRUM_MIN_ATTACK, layer.attack)
      const peak = Math.max(DRUM_FLOOR, layer.gain * levelScale)
      const decay = Math.max(0.004, layer.decay)

      const gain = context.createGain()
      gain.gain.value = 0
      gain.connect(destination)
      // Percussive envelope: quick fade-in, exponential fall to silence.
      gain.gain.setValueAtTime(DRUM_FLOOR, when)
      gain.gain.linearRampToValueAtTime(peak, when + attack)
      gain.gain.exponentialRampToValueAtTime(DRUM_FLOOR, when + attack + decay)
      gains.push(gain)

      // Build the series filter chain (source -> f0 -> f1 -> ... -> gain).
      let target: AudioNodeLike = gain
      const filters: BiquadFilterNodeLike[] = []
      for (const f of [...(layer.filters ?? [])].reverse()) {
        const filter = context.createBiquadFilter()
        filter.type = f.type
        filter.frequency.setValueAtTime(f.frequency, when)
        filter.Q.setValueAtTime(f.q, when)
        filter.connect(target)
        filters.push(filter)
        target = filter
      }

      const stopAt = when + attack + decay + STOP_TAIL
      const source = this.createSource(context, layer, when, stopAt)
      source.node.connect(target)
      sources.push(source.node)

      pending += 1
      source.node.onended = finish
      source.node.start(when)
      source.node.stop(stopAt)
      disposers.push(() => {
        source.node.disconnect()
        for (const filter of filters) filter.disconnect()
        gain.disconnect()
      })
    }

    if (spec.chokeGroup) {
      const entry: ActiveVoice = { group: spec.chokeGroup, gains, sources }
      this.active.push(entry)
      // Drop the entry from the choke list once its last source finishes, so we
      // never try to choke an already-dead voice. `finish` already fires the
      // node teardown on the last-ended source; chain removal after it.
      let remaining = pending
      for (const source of sources) {
        const prev = source.onended as (() => void) | null
        source.onended = (): void => {
          prev?.()
          remaining -= 1
          if (remaining === 0) this.active = this.active.filter((a) => a !== entry)
        }
      }
    }
  }

  /** Silence every ringing voice in `group` with a fast fade starting at `when`. */
  private choke(group: string, when: number): void {
    const chokeAt = when
    const stopAt = chokeAt + CHOKE_FADE + 0.01
    for (const voiceEntry of this.active) {
      if (voiceEntry.group !== group) continue
      for (const gain of voiceEntry.gains) {
        gain.gain.cancelScheduledValues(chokeAt)
        gain.gain.setValueAtTime(Math.max(DRUM_FLOOR, gain.gain.value), chokeAt)
        gain.gain.exponentialRampToValueAtTime(DRUM_FLOOR, chokeAt + CHOKE_FADE)
      }
      for (const source of voiceEntry.sources) source.stop(stopAt)
    }
    this.active = this.active.filter((a) => a.group !== group)
  }

  private createSource(
    context: MinimalAudioContext,
    layer: DrumLayer,
    when: number,
    stopAt: number,
  ): { node: OscillatorNodeLike | AudioBufferSourceNodeLike } {
    if (layer.source === 'noise') {
      const duration = Math.max(0.001, stopAt - when)
      return { node: this.makeNoiseSource(context, duration) }
    }
    const osc = context.createOscillator()
    osc.type = layer.wave
    osc.frequency.setValueAtTime(layer.startFreq, when)
    if (layer.endFreq !== undefined) {
      const drop = layer.pitchDrop ?? 0.08
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(DRUM_FLOOR, layer.endFreq),
        when + drop,
      )
    }
    return { node: osc }
  }

  /** Build a one-shot white-noise buffer source covering `duration` seconds. */
  private makeNoiseSource(
    context: MinimalAudioContext,
    duration: number,
  ): AudioBufferSourceNodeLike {
    const length = Math.max(1, Math.ceil(context.sampleRate * duration))
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1
    const source = context.createBufferSource()
    source.buffer = buffer
    return source
  }
}
