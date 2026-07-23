import { describe, expect, it } from 'vitest'
import {
  clampBpm,
  clampSwing,
  collectEvents,
  DEFAULT_BPM,
  DEFAULT_GRID,
  DEFAULT_LOOKAHEAD,
  DEFAULT_TICK_INTERVAL_MS,
  MAX_BPM,
  MIN_BPM,
  resolveGrid,
  Scheduler,
  secondsPerSubdivision,
  stepToPosition,
  swingDelay,
  type GridConfig,
  type IntervalTimer,
  type SchedulerClock,
  type SchedulerEvent,
  type TimedEvent,
  type TransportState,
} from './scheduler.ts'

// --- Fakes ------------------------------------------------------------------
// A mutable clock and a hand-driven timer implementing the injectable
// interfaces without casts — no real setInterval or AudioContext involved.

class FakeClock implements SchedulerClock {
  currentTime = 0
  advance(seconds: number): void {
    this.currentTime += seconds
  }
}

class FakeTimer implements IntervalTimer {
  callback: (() => void) | null = null
  intervalMs: number | null = null
  setCalls = 0
  clearCalls = 0
  lastClearedHandle: unknown = null
  set(callback: () => void, intervalMs: number): unknown {
    this.setCalls += 1
    this.callback = callback
    this.intervalMs = intervalMs
    return { id: this.setCalls }
  }
  clear(handle: unknown): void {
    this.clearCalls += 1
    this.lastClearedHandle = handle
    this.callback = null
    this.intervalMs = null
  }
  fire(): void {
    this.callback?.()
  }
}

interface Harness {
  clock: FakeClock
  timer: FakeTimer
  scheduler: Scheduler
  fired: TimedEvent[]
}

function makeScheduler(options: Partial<GridConfig> & { lookahead?: number } = {}): Harness {
  const clock = new FakeClock()
  const timer = new FakeTimer()
  const fired: TimedEvent[] = []
  const scheduler = new Scheduler(clock, {
    ...options,
    timer,
    onEvent: (event, when) => {
      fired.push({ event, when })
    },
  })
  return { clock, timer, scheduler, fired }
}

/** Advance fake time in `stepSeconds` chunks, firing a tick after each. */
function run(h: Harness, totalSeconds: number, stepSeconds = 0.025): void {
  const ticks = Math.round(totalSeconds / stepSeconds)
  for (let i = 0; i < ticks; i++) {
    h.clock.advance(stepSeconds)
    h.timer.fire()
  }
}

// --- Pure math ----------------------------------------------------------------

describe('clampBpm', () => {
  it('passes normal tempi through', () => {
    expect(clampBpm(120)).toBe(120)
  })
  it('clamps to the supported range', () => {
    expect(clampBpm(1)).toBe(MIN_BPM)
    expect(clampBpm(9999)).toBe(MAX_BPM)
  })
  it('falls back to the default on NaN', () => {
    expect(clampBpm(Number.NaN)).toBe(DEFAULT_BPM)
  })
})

describe('clampSwing', () => {
  it('clamps into 0..1 and treats NaN as straight', () => {
    expect(clampSwing(0.5)).toBe(0.5)
    expect(clampSwing(-1)).toBe(0)
    expect(clampSwing(2)).toBe(1)
    expect(clampSwing(Number.NaN)).toBe(0)
  })
})

describe('resolveGrid', () => {
  it('returns the defaults when nothing is passed', () => {
    expect(resolveGrid()).toEqual(DEFAULT_GRID)
  })
  it('overrides only the provided fields', () => {
    expect(resolveGrid({ bpm: 90 })).toEqual({ ...DEFAULT_GRID, bpm: 90 })
  })
  it('floors and clamps meter values to at least 1', () => {
    expect(resolveGrid({ beatsPerBar: 0, subdivisionsPerBeat: 2.9 })).toEqual({
      ...DEFAULT_GRID,
      beatsPerBar: 1,
      subdivisionsPerBeat: 2,
    })
  })
})

describe('secondsPerSubdivision', () => {
  it('is 0.5s per quarter at 120 BPM', () => {
    expect(secondsPerSubdivision(120, 1)).toBeCloseTo(0.5)
  })
  it('divides the beat by the subdivision count', () => {
    expect(secondsPerSubdivision(120, 2)).toBeCloseTo(0.25)
    expect(secondsPerSubdivision(60, 4)).toBeCloseTo(0.25)
  })
  it('clamps silly tempi instead of exploding', () => {
    expect(secondsPerSubdivision(0, 1)).toBeCloseTo(60 / MIN_BPM)
  })
})

describe('stepToPosition', () => {
  it('starts at bar 0, beat 0, subdivision 0', () => {
    expect(stepToPosition(0, 4, 2)).toEqual({ bar: 0, beat: 0, subdivision: 0 })
  })
  it('walks subdivisions within a beat first', () => {
    expect(stepToPosition(1, 4, 2)).toEqual({ bar: 0, beat: 0, subdivision: 1 })
    expect(stepToPosition(2, 4, 2)).toEqual({ bar: 0, beat: 1, subdivision: 0 })
  })
  it('rolls over into the next bar', () => {
    expect(stepToPosition(7, 4, 2)).toEqual({ bar: 0, beat: 3, subdivision: 1 })
    expect(stepToPosition(8, 4, 2)).toEqual({ bar: 1, beat: 0, subdivision: 0 })
  })
  it('handles 3/4 with quarters', () => {
    expect(stepToPosition(3, 3, 1)).toEqual({ bar: 1, beat: 0, subdivision: 0 })
    expect(stepToPosition(5, 3, 1)).toEqual({ bar: 1, beat: 2, subdivision: 0 })
  })
})

describe('swingDelay', () => {
  it('is zero when swing is zero', () => {
    expect(swingDelay(1, 120, 2, 0)).toBe(0)
  })
  it('never moves even subdivisions (the beats)', () => {
    expect(swingDelay(0, 120, 2, 1)).toBe(0)
    expect(swingDelay(2, 120, 4, 1)).toBe(0)
  })
  it('delays odd subdivisions by a third of a step at full swing', () => {
    // 120 BPM eighths: step = 0.25s, full swing delay = 0.25/3
    expect(swingDelay(1, 120, 2, 1)).toBeCloseTo(0.25 / 3)
  })
  it('scales linearly with the swing amount', () => {
    expect(swingDelay(1, 120, 2, 0.5)).toBeCloseTo(0.25 / 6)
    expect(swingDelay(3, 120, 4, 0.5)).toBeCloseTo(0.125 / 6)
  })
})

describe('collectEvents', () => {
  const straight: GridConfig = { bpm: 120, beatsPerBar: 4, subdivisionsPerBeat: 2, swing: 0 }
  const start: TransportState = { step: 0, nextStepTime: 0 }

  it('returns nothing when the next step is at or past the horizon', () => {
    const { events, state } = collectEvents({ step: 3, nextStepTime: 1 }, straight, 1)
    expect(events).toEqual([])
    expect(state).toEqual({ step: 3, nextStepTime: 1 })
  })

  it('emits every step strictly before the horizon, evenly spaced', () => {
    const { events, state } = collectEvents(start, straight, 1)
    // 120 BPM eighths = every 0.25s: 0, 0.25, 0.5, 0.75 (1.0 excluded)
    expect(events.map((e) => e.when)).toEqual([0, 0.25, 0.5, 0.75])
    expect(events.map((e) => e.event.step)).toEqual([0, 1, 2, 3])
    expect(state).toEqual({ step: 4, nextStepTime: 1 })
  })

  it('carries bar/beat/subdivision indices on each event', () => {
    const { events } = collectEvents(start, straight, 1.25)
    expect(events[0]?.event).toEqual({ step: 0, bar: 0, beat: 0, subdivision: 0 })
    expect(events[1]?.event).toEqual({ step: 1, bar: 0, beat: 0, subdivision: 1 })
    expect(events[2]?.event).toEqual({ step: 2, bar: 0, beat: 1, subdivision: 0 })
  })

  it('does not mutate the input state and is deterministic', () => {
    const frozen: TransportState = { step: 0, nextStepTime: 0 }
    const a = collectEvents(frozen, straight, 0.6)
    const b = collectEvents(frozen, straight, 0.6)
    expect(frozen).toEqual({ step: 0, nextStepTime: 0 })
    expect(a).toEqual(b)
  })

  it('is gapless and duplicate-free across consecutive windows', () => {
    let state = start
    const all: TimedEvent[] = []
    for (let horizon = 0.1; horizon <= 2.0001; horizon += 0.1) {
      const result = collectEvents(state, straight, horizon)
      state = result.state
      all.push(...result.events)
    }
    expect(all.map((e) => e.event.step)).toEqual(all.map((_, i) => i))
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.when - all[i - 1]!.when).toBeCloseTo(0.25)
    }
  })

  it('changes spacing after a tempo change without skipping or doubling steps', () => {
    const first = collectEvents(start, straight, 0.6) // steps 0,1,2 at 0.25s spacing
    const faster: GridConfig = { ...straight, bpm: 240 }
    const second = collectEvents(first.state, faster, 1.2) // continues at 0.125s spacing
    const all = [...first.events, ...second.events]
    // No skip/double: absolute steps are consecutive.
    expect(all.map((e) => e.event.step)).toEqual(all.map((_, i) => i))
    // Monotonically increasing times across the change.
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.when).toBeGreaterThan(all[i - 1]!.when)
    }
    // Old spacing before the change, new spacing after it.
    expect(first.events[1]!.when - first.events[0]!.when).toBeCloseTo(0.25)
    expect(second.events[1]!.when - second.events[0]!.when).toBeCloseTo(0.125)
    // The first post-change step still lands on the pre-change grid (0.75).
    expect(second.events[0]!.when).toBeCloseTo(0.75)
  })

  it('slowing down mid-run also keeps times monotonic', () => {
    const first = collectEvents(start, straight, 0.3)
    const slower: GridConfig = { ...straight, bpm: 60 }
    const second = collectEvents(first.state, slower, 2)
    const all = [...first.events, ...second.events]
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.when).toBeGreaterThan(all[i - 1]!.when)
    }
    expect(second.events[1]!.when - second.events[0]!.when).toBeCloseTo(0.5)
  })

  it('swing shifts only the off-beats, by exactly swing * step / 3', () => {
    const swung: GridConfig = { ...straight, swing: 1 }
    const { events } = collectEvents(start, swung, 1)
    // Straight grid 0, 0.25, 0.5, 0.75; odd subdivisions delayed by 0.25/3.
    expect(events[0]!.when).toBeCloseTo(0)
    expect(events[1]!.when).toBeCloseTo(0.25 + 0.25 / 3)
    expect(events[2]!.when).toBeCloseTo(0.5)
    expect(events[3]!.when).toBeCloseTo(0.75 + 0.25 / 3)
  })

  it('half swing shifts off-beats by half the full-swing delay', () => {
    const swung: GridConfig = { ...straight, swing: 0.5 }
    const { events } = collectEvents(start, swung, 0.6)
    expect(events[1]!.when).toBeCloseTo(0.25 + 0.25 / 6)
  })

  it('with sixteenths, swing delays subdivisions 1 and 3 but not 0 and 2', () => {
    const sixteenths: GridConfig = { bpm: 120, beatsPerBar: 4, subdivisionsPerBeat: 4, swing: 1 }
    const { events } = collectEvents(start, sixteenths, 0.5)
    // Straight grid every 0.125s.
    expect(events[0]!.when).toBeCloseTo(0)
    expect(events[1]!.when).toBeCloseTo(0.125 + 0.125 / 3)
    expect(events[2]!.when).toBeCloseTo(0.25)
    expect(events[3]!.when).toBeCloseTo(0.375 + 0.125 / 3)
  })

  it('swung sequences remain monotonic and non-overlapping', () => {
    const swung: GridConfig = { ...straight, swing: 1 }
    let state = start
    const all: TimedEvent[] = []
    for (let horizon = 0.1; horizon <= 2.0001; horizon += 0.1) {
      const result = collectEvents(state, swung, horizon)
      state = result.state
      all.push(...result.events)
    }
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.when).toBeGreaterThan(all[i - 1]!.when)
    }
  })

  it('the straight grid is unaffected by swing (state advances identically)', () => {
    const swung: GridConfig = { ...straight, swing: 1 }
    const a = collectEvents(start, straight, 1)
    const b = collectEvents(start, swung, 1)
    expect(a.state).toEqual(b.state)
    expect(a.events.length).toBe(b.events.length)
  })
})

// --- Scheduler shell ------------------------------------------------------------

describe('Scheduler lifecycle', () => {
  it('does nothing until start()', () => {
    const h = makeScheduler()
    expect(h.scheduler.isRunning).toBe(false)
    h.timer.fire()
    expect(h.fired).toEqual([])
    expect(h.scheduler.currentPosition()).toBeNull()
  })

  it('start() installs the interval with the configured tick period', () => {
    const clock = new FakeClock()
    const timer = new FakeTimer()
    const scheduler = new Scheduler(clock, { timer, tickIntervalMs: 40 })
    scheduler.start()
    expect(timer.setCalls).toBe(1)
    expect(timer.intervalMs).toBe(40)
    scheduler.stop()
  })

  it('defaults to a 25ms tick and 100ms lookahead', () => {
    expect(DEFAULT_TICK_INTERVAL_MS).toBe(25)
    expect(DEFAULT_LOOKAHEAD).toBe(0.1)
    const h = makeScheduler({ bpm: 600 }) // clamped to MAX_BPM = 400 -> 0.15s steps
    h.scheduler.start()
    expect(h.timer.intervalMs).toBe(25)
    // Only steps within 0.1s of now: just step 0 at t=0.
    expect(h.fired.length).toBe(1)
  })

  it('start() emits the first window immediately, beginning at the clock time', () => {
    const h = makeScheduler({ bpm: 120 })
    h.clock.currentTime = 5
    h.scheduler.start()
    expect(h.scheduler.isRunning).toBe(true)
    expect(h.fired.length).toBe(1) // 0.5s steps, 0.1s lookahead -> only step 0
    expect(h.fired[0]!.when).toBe(5)
    expect(h.fired[0]!.event).toEqual({ step: 0, bar: 0, beat: 0, subdivision: 0 })
  })

  it('stop() clears the interval with the handle it created', () => {
    const h = makeScheduler()
    h.scheduler.start()
    h.scheduler.stop()
    expect(h.scheduler.isRunning).toBe(false)
    expect(h.timer.clearCalls).toBe(1)
    expect(h.timer.lastClearedHandle).toEqual({ id: 1 })
  })

  it('restart begins cleanly from step 0 / bar 0 at the new clock time', () => {
    const h = makeScheduler({ bpm: 120 })
    h.scheduler.start()
    run(h, 1)
    h.scheduler.stop()
    h.fired.length = 0
    h.clock.advance(10)
    h.scheduler.start()
    expect(h.fired[0]!.event).toEqual({ step: 0, bar: 0, beat: 0, subdivision: 0 })
    expect(h.fired[0]!.when).toBeCloseTo(h.clock.currentTime)
    expect(h.scheduler.currentPosition()?.step).toBe(0)
  })

  it('starting while running restarts instead of stacking intervals', () => {
    const h = makeScheduler()
    h.scheduler.start()
    h.scheduler.start()
    expect(h.timer.setCalls).toBe(2)
    expect(h.timer.clearCalls).toBe(1)
  })
})

describe('Scheduler event stream', () => {
  it('advancing fake time yields a deterministic, gapless, evenly spaced sequence', () => {
    const h = makeScheduler({ bpm: 120, subdivisionsPerBeat: 2 })
    h.scheduler.start()
    run(h, 2)
    // 0.25s per step, horizon reaches 2.1s -> steps 0..8 at least.
    expect(h.fired.length).toBeGreaterThanOrEqual(9)
    h.fired.forEach((timed, i) => {
      expect(timed.event.step).toBe(i)
      expect(timed.when).toBeCloseTo(i * 0.25)
    })
  })

  it('never emits an event outside the lookahead window', () => {
    const h = makeScheduler({ bpm: 240, subdivisionsPerBeat: 4 })
    h.scheduler.start()
    for (let i = 0; i < 40; i++) {
      h.clock.advance(0.025)
      h.timer.fire()
      const last = h.fired[h.fired.length - 1]!
      expect(last.when).toBeLessThan(h.clock.currentTime + DEFAULT_LOOKAHEAD)
    }
  })

  it('emits no duplicates when ticks fire faster than steps arrive', () => {
    const h = makeScheduler({ bpm: 60 }) // 1s per step, 0.1s lookahead
    h.scheduler.start()
    run(h, 3, 0.005) // very dense ticking
    const steps = h.fired.map((e) => e.event.step)
    expect(steps).toEqual(steps.map((_, i) => i))
  })

  it('counts bars and beats correctly across bar lines', () => {
    const h = makeScheduler({ bpm: 240, beatsPerBar: 3 })
    h.scheduler.start()
    run(h, 1.2) // 0.25s per beat, 3/4 -> bar every 0.75s
    const positions = h.fired.map((e) => e.event)
    expect(positions[0]).toEqual({ step: 0, bar: 0, beat: 0, subdivision: 0 })
    expect(positions[3]).toEqual({ step: 3, bar: 1, beat: 0, subdivision: 0 })
    expect(positions[5]).toEqual({ step: 5, bar: 1, beat: 2, subdivision: 0 })
  })

  it('setTempo mid-run keeps times monotonic and steps consecutive', () => {
    const h = makeScheduler({ bpm: 120 })
    h.scheduler.start()
    run(h, 1)
    h.scheduler.setTempo(240)
    expect(h.scheduler.tempo).toBe(240)
    run(h, 1)
    const steps = h.fired.map((e) => e.event.step)
    expect(steps).toEqual(steps.map((_, i) => i))
    for (let i = 1; i < h.fired.length; i++) {
      expect(h.fired[i]!.when).toBeGreaterThan(h.fired[i - 1]!.when)
    }
    // Spacing tightened from 0.5s to 0.25s at the end of the run.
    const last = h.fired[h.fired.length - 1]!
    const beforeLast = h.fired[h.fired.length - 2]!
    expect(last.when - beforeLast.when).toBeCloseTo(0.25)
  })

  it('setSwing mid-run shifts only subsequent off-beats', () => {
    const h = makeScheduler({ bpm: 120, subdivisionsPerBeat: 2 })
    h.scheduler.start()
    run(h, 0.5) // straight so far
    h.scheduler.setSwing(1)
    expect(h.scheduler.swing).toBe(1)
    run(h, 1)
    for (const { event, when } of h.fired) {
      const straightTime = event.step * 0.25
      if (event.subdivision === 0) {
        expect(when).toBeCloseTo(straightTime)
      } else if (when > 0.6) {
        expect(when).toBeCloseTo(straightTime + 0.25 / 3)
      }
    }
  })

  it('setMeter re-maps positions without stopping the transport', () => {
    const h = makeScheduler({ bpm: 240, beatsPerBar: 4 })
    h.scheduler.start()
    h.scheduler.setMeter({ beatsPerBar: 3 })
    expect(h.scheduler.gridConfig.beatsPerBar).toBe(3)
    run(h, 1)
    expect(h.scheduler.isRunning).toBe(true)
    const bars = h.fired.map((e) => e.event.bar)
    expect(bars[3]).toBe(1) // bar line after 3 beats
  })

  it('clamps tempo and swing setters', () => {
    const h = makeScheduler()
    h.scheduler.setTempo(100000)
    expect(h.scheduler.tempo).toBe(MAX_BPM)
    h.scheduler.setSwing(5)
    expect(h.scheduler.swing).toBe(1)
  })

  it('works without an onEvent callback (observing via currentPosition only)', () => {
    const clock = new FakeClock()
    const timer = new FakeTimer()
    const scheduler = new Scheduler(clock, { timer, bpm: 120 })
    scheduler.start()
    clock.advance(0.01)
    expect(scheduler.currentPosition()?.step).toBe(0)
    scheduler.stop()
  })
})

describe('Scheduler.currentPosition (visual clock)', () => {
  it('lags the scheduled events until the audio clock reaches them', () => {
    const h = makeScheduler({ bpm: 120 })
    h.scheduler.start()
    // Step 0 was scheduled for t=0; the clock is still at 0, so it is current.
    expect(h.scheduler.currentPosition()?.step).toBe(0)
    run(h, 0.45)
    // Step 1 (t=0.5) is already handed to onEvent (lookahead) but not audible yet.
    expect(h.fired.some((e) => e.event.step === 1)).toBe(true)
    expect(h.scheduler.currentPosition()?.step).toBe(0)
    run(h, 0.1)
    expect(h.scheduler.currentPosition()?.step).toBe(1)
  })

  it('follows along through several beats', () => {
    const h = makeScheduler({ bpm: 60, beatsPerBar: 4 })
    h.scheduler.start()
    const seen: (SchedulerEvent | null)[] = []
    // Sample mid-beat (t ~= 1.5, 2.5, 3.5, 4.5) to stay clear of boundaries.
    run(h, 1.5)
    seen.push(h.scheduler.currentPosition())
    for (let i = 0; i < 3; i++) {
      run(h, 1)
      seen.push(h.scheduler.currentPosition())
    }
    expect(seen.map((p) => p?.beat)).toEqual([1, 2, 3, 0])
    expect(seen[3]?.bar).toBe(1)
  })

  it('resets to null on stop', () => {
    const h = makeScheduler({ bpm: 120 })
    h.scheduler.start()
    run(h, 0.5)
    expect(h.scheduler.currentPosition()).not.toBeNull()
    h.scheduler.stop()
    expect(h.scheduler.currentPosition()).toBeNull()
  })
})
