import { describe, expect, it } from 'vitest'
import {
  AudioEngine,
  DEFAULT_MASTER_VOLUME,
  type AudioNodeLike,
  type AudioParamLike,
  type DynamicsCompressorNodeLike,
  type GainNodeLike,
  type MinimalAudioContext,
  type OscillatorNodeLike,
} from './engine.ts'

// --- Fakes implementing the minimal structural interfaces ------------------
// These compile without casts, which proves the engine's Web Audio surface is
// genuinely minimal. No real AudioContext is ever constructed.

interface ParamEvent {
  type: 'set' | 'linear' | 'cancel'
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

class FakeCompressor implements DynamicsCompressorNodeLike {
  readonly threshold = new FakeParam()
  readonly knee = new FakeParam()
  readonly ratio = new FakeParam()
  readonly attack = new FakeParam()
  readonly release = new FakeParam()
  connectedTo: AudioNodeLike[] = []
  connect(destination: AudioNodeLike): void {
    this.connectedTo.push(destination)
  }
  disconnect(): void {}
}

class FakeContext implements MinimalAudioContext {
  currentTime = 10
  state: AudioContextState = 'suspended'
  readonly destination: AudioNodeLike = { connect: () => {}, disconnect: () => {} }
  resumeCalls = 0
  gains: FakeGain[] = []
  oscillators: FakeOscillator[] = []
  compressors: FakeCompressor[] = []
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
  createDynamicsCompressor(): DynamicsCompressorNodeLike {
    const c = new FakeCompressor()
    this.compressors.push(c)
    return c
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1
    this.state = 'running'
  }
}

function makeEngine(): { engine: AudioEngine; factory: () => FakeContext } {
  let ctx: FakeContext | undefined
  const factory = (): FakeContext => {
    if (!ctx) ctx = new FakeContext()
    return ctx
  }
  const engine = new AudioEngine(factory)
  return { engine, factory }
}

describe('AudioEngine lifecycle', () => {
  it('does not create a context until first use', () => {
    let created = 0
    const engine = new AudioEngine(() => {
      created += 1
      return new FakeContext()
    })
    expect(created).toBe(0)
    expect(engine.isInitialized).toBe(false)
    expect(engine.masterVolume).toBe(DEFAULT_MASTER_VOLUME)
  })

  it('ensureRunning creates and resumes the context', async () => {
    const { engine, factory } = makeEngine()
    await engine.ensureRunning()
    expect(engine.isInitialized).toBe(true)
    expect(factory().resumeCalls).toBe(1)
    expect(factory().state).toBe('running')
  })

  it('ensureRunning does not resume again once running', async () => {
    const { engine, factory } = makeEngine()
    await engine.ensureRunning()
    await engine.ensureRunning()
    expect(factory().resumeCalls).toBe(1)
  })

  it('builds the master -> limiter -> destination chain once', () => {
    const { engine, factory } = makeEngine()
    engine.getMasterInput()
    engine.getMasterInput()
    const ctx = factory()
    expect(ctx.gains.length).toBe(1) // master reused
    expect(ctx.compressors.length).toBe(1)
    const master = ctx.gains[0]!
    const limiter = ctx.compressors[0]!
    expect(master.connectedTo).toContain(limiter)
    expect(limiter.connectedTo).toContain(ctx.destination)
    expect(master.gain.value).toBe(DEFAULT_MASTER_VOLUME)
  })
})

describe('AudioEngine.setMasterVolume', () => {
  it('clamps and stores the volume before the context exists', () => {
    const { engine } = makeEngine()
    engine.setMasterVolume(2)
    expect(engine.masterVolume).toBe(1)
    engine.setMasterVolume(-1)
    expect(engine.masterVolume).toBe(0)
  })

  it('ramps the master gain when the context exists', () => {
    const { engine, factory } = makeEngine()
    engine.getMasterInput()
    engine.setMasterVolume(0.5)
    const master = factory().gains[0]!
    const ramp = master.gain.events.find((e) => e.type === 'linear')
    expect(ramp?.value).toBe(0.5)
  })
})

describe('AudioEngine.playNote', () => {
  it('wires two detuned oscillators through a voice gain into the master', () => {
    const { engine, factory } = makeEngine()
    engine.playNote(69, 1, { when: 100, detune: 8 })
    const ctx = factory()
    // one master gain + one voice gain
    expect(ctx.gains.length).toBe(2)
    expect(ctx.oscillators.length).toBe(2)
    const master = ctx.gains[0]!
    const voice = ctx.gains[1]!
    expect(voice.connectedTo).toContain(master)
    for (const osc of ctx.oscillators) {
      expect(osc.connectedTo).toContain(voice)
      expect(osc.started).toBe(100)
      expect(osc.stopped).toBeGreaterThan(100)
    }
    // symmetric detune ±4 cents
    const detunes = ctx.oscillators.map((o) => o.detune.events[0]?.value)
    expect(detunes).toEqual([-4, 4])
    // A4 = 440 Hz
    expect(ctx.oscillators[0]!.frequency.events[0]?.value).toBeCloseTo(440)
  })

  it('applies the envelope plan to the voice gain (starts and ends at 0)', () => {
    const { engine, factory } = makeEngine()
    engine.playNote(60, 0.5, { when: 0 })
    const voice = factory().gains[1]!
    const events = voice.gain.events
    expect(events[0]).toEqual({ type: 'cancel', value: 0, time: 0 })
    expect(events[1]).toEqual({ type: 'set', value: 0, time: 0 })
    expect(events[events.length - 1]?.value).toBe(0)
  })

  it('defaults the start time to the context clock', () => {
    const { engine, factory } = makeEngine()
    engine.playNote(60, 1)
    expect(factory().oscillators[0]!.started).toBe(10)
  })

  it('disconnects nodes only after the last oscillator ends', () => {
    const { engine, factory } = makeEngine()
    engine.playNote(60, 1)
    const ctx = factory()
    const voice = ctx.gains[1]!
    const [a, b] = ctx.oscillators as [FakeOscillator, FakeOscillator]
    a.fireEnded()
    expect(voice.disconnected).toBe(false)
    b.fireEnded()
    expect(voice.disconnected).toBe(true)
    expect(a.disconnected).toBe(true)
    expect(b.disconnected).toBe(true)
  })
})

describe('AudioEngine.currentTime', () => {
  it('is 0 before the context exists and tracks the clock afterwards', () => {
    const { engine } = makeEngine()
    expect(engine.currentTime).toBe(0)
    engine.getMasterInput()
    expect(engine.currentTime).toBe(10)
  })
})

describe('AudioEngine.playClick', () => {
  it('wires a single oscillator through a click gain into the master', () => {
    const { engine, factory } = makeEngine()
    engine.playClick({ frequency: 1200, when: 5, gain: 0.5, duration: 0.04 })
    const ctx = factory()
    expect(ctx.oscillators.length).toBe(1)
    expect(ctx.gains.length).toBe(2) // master + click gain
    const master = ctx.gains[0]!
    const click = ctx.gains[1]!
    const osc = ctx.oscillators[0]!
    expect(click.connectedTo).toContain(master)
    expect(osc.connectedTo).toContain(click)
    expect(osc.type).toBe('square')
    expect(osc.frequency.events[0]?.value).toBe(1200)
    expect(osc.started).toBe(5)
    expect(osc.stopped).toBeGreaterThan(5)
  })

  it('rises to the peak gain then decays back to silence', () => {
    const { engine, factory } = makeEngine()
    engine.playClick({ frequency: 1000, when: 0, gain: 0.5, duration: 0.04 })
    const click = factory().gains[1]!
    const linear = click.gain.events.filter((e) => e.type === 'linear')
    expect(linear[0]?.value).toBe(0.5)
    expect(linear[linear.length - 1]?.value).toBe(0)
  })

  it('disconnects its nodes when the oscillator ends', () => {
    const { engine, factory } = makeEngine()
    engine.playClick({ frequency: 1000 })
    const ctx = factory()
    const click = ctx.gains[1]!
    const osc = ctx.oscillators[0] as FakeOscillator
    osc.fireEnded()
    expect(osc.disconnected).toBe(true)
    expect(click.disconnected).toBe(true)
  })
})

describe('AudioEngine.playChord', () => {
  it('plays one voice per note into the shared master', () => {
    const { engine, factory } = makeEngine()
    engine.playChord([60, 64, 67], 1, { when: 0 })
    const ctx = factory()
    expect(ctx.oscillators.length).toBe(6) // 3 notes x 2 osc
    expect(ctx.gains.length).toBe(4) // 1 master + 3 voices
  })
})
