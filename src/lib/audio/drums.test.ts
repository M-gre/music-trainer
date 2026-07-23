import { describe, expect, it } from 'vitest'
import {
  DrumKit,
  DRUM_LOUDNESS_BAND,
  DRUM_VOICES,
  DRUM_VOICE_DEFS,
  drumPeakLevel,
  isDrumVoice,
  resolveDrumSpec,
  type DrumKitTarget,
  type DrumVoice,
} from './drums.ts'
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioNodeLike,
  AudioParamLike,
  BiquadFilterNodeLike,
  GainNodeLike,
  MinimalAudioContext,
  OscillatorNodeLike,
} from './engine.ts'

// --- Fakes implementing the minimal structural interfaces ------------------

interface ParamEvent {
  type: 'set' | 'linear' | 'exp' | 'cancel'
  value: number
  time: number
}

class FakeParam implements AudioParamLike {
  value = 0
  events: ParamEvent[] = []
  setValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'set', value, time })
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'linear', value, time })
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    this.events.push({ type: 'exp', value, time })
  }
  cancelScheduledValues(time: number): void {
    this.events.push({ type: 'cancel', value: 0, time })
  }
}

class FakeGain implements GainNodeLike {
  readonly gain = new FakeParam()
  connectedTo: AudioNodeLike[] = []
  disconnected = false
  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination)
  }
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeOscillator implements OscillatorNodeLike {
  type: OscillatorType = 'sine'
  readonly frequency = new FakeParam()
  readonly detune = new FakeParam()
  onended: unknown = null
  connectedTo: AudioNodeLike[] = []
  disconnected = false
  started: number | undefined
  stopped: number | undefined
  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination)
  }
  disconnect(): void {
    this.disconnected = true
  }
  start(when?: number): void {
    this.started = when
  }
  stop(when?: number): void {
    this.stopped = when
  }
  fireEnded(): void {
    ;(this.onended as (() => void) | null)?.()
  }
}

class FakeBiquadFilter implements BiquadFilterNodeLike {
  type: BiquadFilterType = 'lowpass'
  readonly frequency = new FakeParam()
  readonly Q = new FakeParam()
  connectedTo: AudioNodeLike[] = []
  disconnected = false
  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination)
  }
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeAudioBuffer implements AudioBufferLike {
  private readonly channel: Float32Array
  constructor(length: number) {
    this.channel = new Float32Array(length)
  }
  getChannelData(): Float32Array {
    return this.channel
  }
}

class FakeBufferSource implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null
  onended: unknown = null
  connectedTo: AudioNodeLike[] = []
  disconnected = false
  started: number | undefined
  stopped: number | undefined
  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination)
  }
  disconnect(): void {
    this.disconnected = true
  }
  start(when?: number): void {
    this.started = when
  }
  stop(when?: number): void {
    this.stopped = when
  }
  fireEnded(): void {
    ;(this.onended as (() => void) | null)?.()
  }
}

class FakeContext implements MinimalAudioContext {
  currentTime = 10
  sampleRate = 48000
  state: AudioContextState = 'running'
  readonly destination: AudioNodeLike = { connect: () => {}, disconnect: () => {} }
  gains: FakeGain[] = []
  oscillators: FakeOscillator[] = []
  filters: FakeBiquadFilter[] = []
  bufferSources: FakeBufferSource[] = []
  createGain(): GainNodeLike {
    const g = new FakeGain()
    this.gains.push(g)
    return g
  }
  createOscillator(): OscillatorNodeLike {
    const o = new FakeOscillator()
    this.oscillators.push(o)
    return o
  }
  createBiquadFilter(): BiquadFilterNodeLike {
    const f = new FakeBiquadFilter()
    this.filters.push(f)
    return f
  }
  createBufferSource(): AudioBufferSourceNodeLike {
    const s = new FakeBufferSource()
    this.bufferSources.push(s)
    return s
  }
  createBuffer(_channels: number, length: number): AudioBufferLike {
    return new FakeAudioBuffer(length)
  }
  createDynamicsCompressor(): never {
    throw new Error('unused')
  }
  async resume(): Promise<void> {}
}

function makeKit(): { kit: DrumKit; ctx: FakeContext; master: FakeGain } {
  const ctx = new FakeContext()
  const master = new FakeGain()
  const target: DrumKitTarget = () => ({ context: ctx, destination: master })
  return { kit: new DrumKit(target), ctx, master }
}

/** All layer gain nodes created for the most recent hit (in layer order). */
function layerGains(ctx: FakeContext): FakeGain[] {
  return ctx.gains
}

// --- Voice guards + parameter tables ----------------------------------------

describe('drum voice identity', () => {
  it('recognizes known voices and rejects others', () => {
    for (const v of DRUM_VOICES) expect(isDrumVoice(v)).toBe(true)
    expect(isDrumVoice('cowbell')).toBe(false)
    expect(isDrumVoice(42)).toBe(false)
  })

  it('defines exactly the five kit voices', () => {
    expect([...DRUM_VOICES]).toEqual(['kick', 'snare', 'hat-closed', 'hat-open', 'ride'])
  })
})

describe('parameter table sanity', () => {
  it('keeps every voice within the shared loudness band at velocity 1', () => {
    for (const voice of DRUM_VOICES) {
      const level = drumPeakLevel(resolveDrumSpec(voice))
      expect(level).toBeGreaterThanOrEqual(DRUM_LOUDNESS_BAND.min)
      expect(level).toBeLessThanOrEqual(DRUM_LOUDNESS_BAND.max)
    }
  })

  it('mixes the ride quietest and the kick loudest', () => {
    const level = (v: DrumVoice): number => drumPeakLevel(resolveDrumSpec(v))
    expect(level('ride')).toBeLessThan(level('hat-closed'))
    expect(level('kick')).toBeGreaterThan(level('snare'))
  })

  it('gives only the hats a choke group', () => {
    expect(DRUM_VOICE_DEFS['hat-closed'].chokeGroup).toBe('hats')
    expect(DRUM_VOICE_DEFS['hat-open'].chokeGroup).toBe('hats')
    expect(DRUM_VOICE_DEFS.kick.chokeGroup).toBeUndefined()
    expect(DRUM_VOICE_DEFS.snare.chokeGroup).toBeUndefined()
    expect(DRUM_VOICE_DEFS.ride.chokeGroup).toBeUndefined()
  })

  it('makes the open hat ring far longer than the closed hat', () => {
    const closed = resolveDrumSpec('hat-closed').layers[0]!
    const open = resolveDrumSpec('hat-open').layers[0]!
    expect(open.decay).toBeGreaterThan(closed.decay * 3)
  })
})

// --- resolveDrumSpec (velocity) ---------------------------------------------

describe('resolveDrumSpec velocity scaling', () => {
  it('scales layer gain down with lower velocity', () => {
    const loud = resolveDrumSpec('snare', 1)
    const soft = resolveDrumSpec('snare', 0.4)
    for (let i = 0; i < loud.layers.length; i += 1) {
      expect(soft.layers[i]!.gain).toBeLessThan(loud.layers[i]!.gain)
    }
  })

  it('reproduces the nominal table exactly at velocity 1', () => {
    const spec = resolveDrumSpec('kick', 1)
    const tone = spec.layers[0]!
    expect(tone.gain).toBeCloseTo(DRUM_VOICE_DEFS.kick.layers[0]!.gain)
    expect(tone.decay).toBeCloseTo(DRUM_VOICE_DEFS.kick.layers[0]!.decay)
  })

  it('shortens decay and dulls filters for softer hits', () => {
    const loud = resolveDrumSpec('ride', 1)
    const soft = resolveDrumSpec('ride', 0.2)
    expect(soft.layers[0]!.decay).toBeLessThan(loud.layers[0]!.decay)
    expect(soft.layers[0]!.filters![0]!.frequency).toBeLessThan(
      loud.layers[0]!.filters![0]!.frequency,
    )
  })

  it('clamps out-of-range velocity', () => {
    expect(resolveDrumSpec('kick', 5).layers[0]!.gain).toBeCloseTo(
      resolveDrumSpec('kick', 1).layers[0]!.gain,
    )
    expect(resolveDrumSpec('kick', -1).layers[0]!.gain).toBe(0)
  })
})

// --- Node wiring: per-voice --------------------------------------------------

describe('DrumKit.playDrum kick', () => {
  it('wires a pitch-dropping sine body plus a noise click into the master', () => {
    const { kit, ctx, master } = makeKit()
    kit.playDrum('kick', { when: 5 })
    // Two layers -> two gain nodes, both into the passed master.
    expect(ctx.gains.length).toBe(2)
    for (const g of ctx.gains) expect(g.connectedTo).toContain(master)
    // Body oscillator: sine, 150 -> 50 Hz pitch drop.
    expect(ctx.oscillators.length).toBe(1)
    const osc = ctx.oscillators[0]!
    expect(osc.type).toBe('sine')
    expect(osc.frequency.events[0]).toEqual({ type: 'set', value: 150, time: 5 })
    const drop = osc.frequency.events.find((e) => e.type === 'exp')
    expect(drop?.value).toBeCloseTo(50)
    expect(osc.started).toBe(5)
    expect(osc.stopped).toBeGreaterThan(5)
    // Click layer: a high-passed noise burst.
    expect(ctx.bufferSources.length).toBe(1)
    expect(ctx.filters.length).toBe(1)
    expect(ctx.filters[0]!.type).toBe('highpass')
  })

  it('applies a percussive envelope: floor -> peak -> exp to silence', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('kick', { when: 0 })
    const body = layerGains(ctx)[0]!
    const [floor, rise, fall] = body.gain.events
    expect(floor).toEqual({ type: 'set', value: expect.any(Number), time: 0 })
    expect(rise?.type).toBe('linear')
    expect(rise!.value).toBeGreaterThan(0)
    expect(fall?.type).toBe('exp')
    expect(fall!.value).toBeGreaterThan(0)
    expect(fall!.value).toBeLessThan(0.001)
    expect(fall!.time).toBeGreaterThan(rise!.time)
  })
})

describe('DrumKit.playDrum snare', () => {
  it('wires a filtered noise burst plus a ~185 Hz tonal body', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('snare', { when: 2 })
    expect(ctx.oscillators.length).toBe(1)
    expect(ctx.bufferSources.length).toBe(1)
    // Tone body around 185 Hz.
    expect(ctx.oscillators[0]!.frequency.events[0]?.value).toBeCloseTo(185)
    // Noise routed through a highpass + bandpass pair.
    const types = ctx.filters.map((f) => f.type).sort()
    expect(types).toEqual(['bandpass', 'highpass'])
  })
})

describe('DrumKit.playDrum hats and ride', () => {
  it('closed hat is a short high-passed noise burst', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('hat-closed', { when: 0 })
    expect(ctx.oscillators.length).toBe(0)
    expect(ctx.bufferSources.length).toBe(1)
    const hp = ctx.filters.find((f) => f.type === 'highpass')
    expect(hp!.frequency.events[0]!.value).toBeGreaterThanOrEqual(6000)
    const noise = ctx.bufferSources[0]!
    expect(noise.started).toBe(0)
    // Short: stops well under 0.15s after onset.
    expect(noise.stopped!).toBeLessThan(0.15)
  })

  it('ride is a long airy wash routed through a high highpass', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('ride', { when: 0 })
    const noise = ctx.bufferSources[0]!
    expect(noise.stopped!).toBeGreaterThan(0.6)
    const hp = ctx.filters.find((f) => f.type === 'highpass')
    expect(hp!.frequency.events[0]!.value).toBeGreaterThanOrEqual(8000)
  })
})

// --- Scheduling + velocity at the node level --------------------------------

describe('DrumKit.playDrum scheduling', () => {
  it('defaults the start time to the context clock', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('kick')
    expect(ctx.oscillators[0]!.started).toBe(10)
  })

  it('schedules everything relative to an explicit when', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('snare', { when: 42 })
    expect(ctx.oscillators[0]!.started).toBe(42)
    expect(ctx.bufferSources[0]!.started).toBe(42)
    expect(ctx.oscillators[0]!.frequency.events[0]!.time).toBe(42)
  })

  it('scales peak gain with velocity', () => {
    const loud = makeKit()
    loud.kit.playDrum('snare', { when: 0, velocity: 1 })
    const soft = makeKit()
    soft.kit.playDrum('snare', { when: 0, velocity: 0.3 })
    const loudPeak = loud.ctx.gains[0]!.gain.events.find((e) => e.type === 'linear')!.value
    const softPeak = soft.ctx.gains[0]!.gain.events.find((e) => e.type === 'linear')!.value
    expect(softPeak).toBeLessThan(loudPeak)
  })
})

describe('DrumKit teardown', () => {
  it('disconnects a hit’s nodes once its last source ends', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('kick', { when: 0 })
    const [bodyGain, clickGain] = ctx.gains as [FakeGain, FakeGain]
    const osc = ctx.oscillators[0]!
    const noise = ctx.bufferSources[0]!
    osc.fireEnded()
    expect(bodyGain.disconnected).toBe(false)
    noise.fireEnded()
    expect(bodyGain.disconnected).toBe(true)
    expect(clickGain.disconnected).toBe(true)
    expect(osc.disconnected).toBe(true)
    expect(noise.disconnected).toBe(true)
  })
})

// --- Choke groups -----------------------------------------------------------

describe('DrumKit choke groups', () => {
  it('choking silences a still-ringing open hat when a closed hat fires', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('hat-open', { when: 0 })
    const openNoise = ctx.bufferSources[0]!
    const openGain = ctx.gains[0]!
    const originalStop = openNoise.stopped!

    kit.playDrum('hat-closed', { when: 0.1 })

    // A second noise source was created for the closed hat.
    expect(ctx.bufferSources.length).toBe(2)
    // The open hat's source is now stopped early (right after the choke fade).
    expect(openNoise.stopped!).toBeLessThan(originalStop)
    expect(openNoise.stopped!).toBeCloseTo(0.1 + 0.008 + 0.01, 3)
    // Its gain was cancelled and ramped down to the floor at the choke time.
    expect(openGain.gain.events.some((e) => e.type === 'cancel' && e.time === 0.1)).toBe(true)
    const chokeFall = openGain.gain.events.filter((e) => e.type === 'exp').at(-1)!
    expect(chokeFall.value).toBeLessThan(0.001)
    expect(chokeFall.time).toBeCloseTo(0.1 + 0.008, 3)
  })

  it('an open hat chokes a previous open hat', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('hat-open', { when: 0 })
    const first = ctx.bufferSources[0]!
    const firstStop = first.stopped!
    kit.playDrum('hat-open', { when: 0.05 })
    expect(first.stopped!).toBeLessThan(firstStop)
  })

  it('does not choke across unrelated voices', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('hat-open', { when: 0 })
    const openNoise = ctx.bufferSources[0]!
    const originalStop = openNoise.stopped!
    kit.playDrum('kick', { when: 0.1 })
    kit.playDrum('ride', { when: 0.1 })
    expect(openNoise.stopped!).toBe(originalStop)
  })

  it('stops choking a voice once it has finished ringing', () => {
    const { kit, ctx } = makeKit()
    kit.playDrum('hat-open', { when: 0 })
    const openNoise = ctx.bufferSources[0]!
    // The open hat finishes on its own.
    openNoise.fireEnded()
    const settledStop = openNoise.stopped!
    // A later closed hat must not touch the already-dead voice.
    kit.playDrum('hat-closed', { when: 5 })
    expect(openNoise.stopped!).toBe(settledStop)
  })
})
