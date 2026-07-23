import { describe, expect, it } from 'vitest'
import { DRUM_VOICES, type DrumVoice, type PlayDrumOptions } from './drums.ts'
import type { GridPosition, SchedulerEventCallback } from './scheduler.ts'
import {
  DEFAULT_COUNT_IN,
  DEFAULT_GROOVE,
  GROOVES,
  GroovePlayer,
  SUBDIVISION_STEPS,
  filterMuted,
  getGroove,
  grooveBars,
  grooveBeatsPerBar,
  grooveGrid,
  grooveStepCount,
  grooveStepIndex,
  isGrooveId,
  makeSteps,
  planEvent,
  resolveCountIn,
  subdivisionsPerBeat,
  type DrumTrigger,
  type GrooveHit,
  type GrooveTransport,
  type Subdivision,
} from './grooves.ts'

const CYMBALS: readonly DrumVoice[] = ['hat-closed', 'hat-open', 'ride']

function pos(bar: number, beat: number, subdivision: number): GridPosition {
  return { bar, beat, subdivision }
}

// --- Grid geometry -----------------------------------------------------------

describe('subdivisionsPerBeat', () => {
  it('maps each subdivision to its steps-per-beat', () => {
    expect(subdivisionsPerBeat('8th')).toBe(2)
    expect(subdivisionsPerBeat('16th')).toBe(4)
    expect(subdivisionsPerBeat('triplet')).toBe(3)
  })
  it('agrees with the exported table', () => {
    for (const sub of Object.keys(SUBDIVISION_STEPS) as Subdivision[]) {
      expect(subdivisionsPerBeat(sub)).toBe(SUBDIVISION_STEPS[sub])
    }
  })
})

describe('groove geometry helpers', () => {
  it('derives beats-per-bar from stepsPerBar and subdivision', () => {
    expect(grooveBeatsPerBar(getGroove('rock-8ths'))).toBe(4) // 8 / 2
    expect(grooveBeatsPerBar(getGroove('rock-16ths'))).toBe(4) // 16 / 4
    expect(grooveBeatsPerBar(getGroove('swing'))).toBe(4) // 12 / 3
    expect(grooveBeatsPerBar(getGroove('blues-12-8'))).toBe(4) // 12 / 3
  })
  it('defaults bars to 1 and reports multi-bar patterns', () => {
    expect(grooveBars(getGroove('rock-8ths'))).toBe(1)
    expect(grooveBars(getGroove('bossa'))).toBe(2)
  })
  it('computes the total step count across bars', () => {
    expect(grooveStepCount(getGroove('rock-8ths'))).toBe(8)
    expect(grooveStepCount(getGroove('bossa'))).toBe(32)
  })
  it('produces a scheduler grid that matches the groove', () => {
    expect(grooveGrid(getGroove('swing'))).toEqual({
      beatsPerBar: 4,
      subdivisionsPerBeat: 3,
      swing: 0,
    })
    expect(grooveGrid(getGroove('rock-16ths'))).toEqual({
      beatsPerBar: 4,
      subdivisionsPerBeat: 4,
      swing: 0,
    })
  })
})

// --- Step-index math ---------------------------------------------------------

describe('grooveStepIndex', () => {
  it('maps beat/subdivision to a step inside a single-bar 8th groove', () => {
    const g = getGroove('rock-8ths') // subs=2
    expect(grooveStepIndex(g, pos(0, 0, 0))).toBe(0)
    expect(grooveStepIndex(g, pos(0, 0, 1))).toBe(1)
    expect(grooveStepIndex(g, pos(0, 1, 0))).toBe(2)
    expect(grooveStepIndex(g, pos(0, 3, 1))).toBe(7)
  })

  it('maps a 16th groove across all four subdivisions of a beat', () => {
    const g = getGroove('rock-16ths') // subs=4
    expect(grooveStepIndex(g, pos(0, 0, 3))).toBe(3)
    expect(grooveStepIndex(g, pos(0, 1, 0))).toBe(4)
    expect(grooveStepIndex(g, pos(0, 3, 3))).toBe(15)
  })

  it('maps a triplet groove (3 steps per beat)', () => {
    const g = getGroove('blues-12-8') // subs=3
    expect(grooveStepIndex(g, pos(0, 0, 2))).toBe(2)
    expect(grooveStepIndex(g, pos(0, 1, 0))).toBe(3)
    expect(grooveStepIndex(g, pos(0, 3, 2))).toBe(11)
  })

  it('wraps a single-bar pattern every bar', () => {
    const g = getGroove('rock-8ths')
    expect(grooveStepIndex(g, pos(1, 0, 0))).toBe(0)
    expect(grooveStepIndex(g, pos(5, 1, 1))).toBe(3)
  })

  it('addresses the second bar of a multi-bar pattern, then wraps', () => {
    const g = getGroove('bossa') // 2 bars, 16 steps each
    expect(grooveStepIndex(g, pos(0, 0, 0))).toBe(0)
    expect(grooveStepIndex(g, pos(1, 0, 0))).toBe(16) // bar 2
    expect(grooveStepIndex(g, pos(2, 0, 0))).toBe(0) // wraps back to bar 1
    expect(grooveStepIndex(g, pos(3, 0, 0))).toBe(16) // bar 2 again
  })
})

// --- makeSteps ---------------------------------------------------------------

describe('makeSteps', () => {
  it('fills a rest lane and sets the given hits', () => {
    expect(
      makeSteps(4, [
        [0, 0.9],
        [2, 0.5],
      ]),
    ).toEqual([0.9, 0, 0.5, 0])
  })
  it('ignores out-of-range and non-integer indices', () => {
    expect(
      makeSteps(3, [
        [-1, 0.5],
        [3, 0.5],
        [1.5, 0.5],
        [1, 0.5],
      ]),
    ).toEqual([0, 0.5, 0])
  })
  it('clamps velocities into 0..1', () => {
    expect(
      makeSteps(2, [
        [0, 2],
        [1, -1],
      ]),
    ).toEqual([1, 0])
  })
})

// --- Count-in ----------------------------------------------------------------

describe('resolveCountIn', () => {
  it('returns the defaults when nothing is passed', () => {
    expect(resolveCountIn()).toEqual(DEFAULT_COUNT_IN)
  })
  it('overrides only the provided fields and clamps', () => {
    expect(resolveCountIn({ bars: 2, velocity: 5 })).toEqual({
      ...DEFAULT_COUNT_IN,
      bars: 2,
      velocity: 1,
    })
  })
  it('allows disabling the count-in with 0 bars', () => {
    expect(resolveCountIn({ bars: 0 }).bars).toBe(0)
  })
})

// --- planEvent ---------------------------------------------------------------

describe('planEvent count-in phase', () => {
  const g = getGroove('rock-8ths')
  const countIn = resolveCountIn({ bars: 1 })

  it('ticks once per beat (subdivision 0 only) during the count-in bar', () => {
    const onBeat = planEvent(g, pos(0, 1, 0), countIn)
    expect(onBeat.phase).toBe('count-in')
    expect(onBeat.patternStep).toBeNull()
    expect(onBeat.hits).toEqual([{ voice: 'hat-closed', velocity: DEFAULT_COUNT_IN.velocity }])

    const offBeat = planEvent(g, pos(0, 1, 1), countIn)
    expect(offBeat.phase).toBe('count-in')
    expect(offBeat.hits).toEqual([])
  })

  it('accents beat 1 of the count-in bar', () => {
    const beat1 = planEvent(g, pos(0, 0, 0), countIn)
    expect(beat1.hits[0]?.velocity).toBe(DEFAULT_COUNT_IN.accentVelocity)
  })

  it('spans multiple count-in bars', () => {
    const two = resolveCountIn({ bars: 2 })
    expect(planEvent(g, pos(1, 0, 0), two).phase).toBe('count-in')
    expect(planEvent(g, pos(2, 0, 0), two).phase).toBe('groove')
  })

  it('emits no count-in when bars is 0', () => {
    const none = resolveCountIn({ bars: 0 })
    expect(planEvent(g, pos(0, 0, 0), none).phase).toBe('groove')
  })
})

describe('planEvent groove phase', () => {
  const g = getGroove('rock-8ths')
  const countIn = resolveCountIn({ bars: 1 })

  it('offsets the pattern by the count-in bars', () => {
    // First groove bar is scheduler bar 1 when there is a one-bar count-in.
    const plan = planEvent(g, pos(1, 0, 0), countIn)
    expect(plan.phase).toBe('groove')
    expect(plan.patternStep).toBe(0)
    // Beat 1: kick plus the driving hat head.
    expect(plan.hits).toEqual([
      { voice: 'kick', velocity: 0.9 },
      { voice: 'hat-closed', velocity: 0.62 },
    ])
  })

  it('returns hits in DRUM_VOICES order when several voices coincide', () => {
    // Blues shuffle bar 1 beat 1: kick + ride both fire on step 0.
    const blues = getGroove('blues-12-8')
    const plan = planEvent(blues, pos(0, 0, 0), resolveCountIn({ bars: 0 }))
    expect(plan.hits.map((h) => h.voice)).toEqual(['kick', 'ride'])
  })

  it('emits nothing on a rest step', () => {
    // Half-time bar 1, step 1 (the "e" of beat 1) is a rest in every lane.
    const half = getGroove('half-time')
    const plan = planEvent(half, pos(1, 0, 1), countIn)
    expect(plan.patternStep).toBe(1)
    expect(plan.hits).toEqual([])
  })

  it('reads the correct bar of a multi-bar pattern', () => {
    const bossa = getGroove('bossa')
    const none = resolveCountIn({ bars: 0 })
    // Bar 2 kick hit is at pattern step 16 (local step 0 of bar 2).
    const plan = planEvent(bossa, pos(1, 0, 0), none)
    expect(plan.patternStep).toBe(16)
    expect(plan.hits.some((h) => h.voice === 'kick')).toBe(true)
  })
})

// --- filterMuted -------------------------------------------------------------

describe('filterMuted', () => {
  const hits: GrooveHit[] = [
    { voice: 'kick', velocity: 0.9 },
    { voice: 'snare', velocity: 0.8 },
    { voice: 'hat-closed', velocity: 0.5 },
  ]
  it('drops muted voices only', () => {
    expect(filterMuted(hits, new Set<DrumVoice>(['snare']))).toEqual([
      { voice: 'kick', velocity: 0.9 },
      { voice: 'hat-closed', velocity: 0.5 },
    ])
  })
  it('returns everything with an empty mute set', () => {
    expect(filterMuted(hits, new Set())).toEqual(hits)
  })
  it('can mute everything', () => {
    expect(filterMuted(hits, new Set<DrumVoice>(['kick', 'snare', 'hat-closed']))).toEqual([])
  })
})

// --- GroovePlayer ------------------------------------------------------------

interface TriggeredHit {
  voice: DrumVoice
  when: number
  velocity: number | undefined
}

class FakeKit implements DrumTrigger {
  hits: TriggeredHit[] = []
  playDrum(voice: DrumVoice, opts: PlayDrumOptions): void {
    this.hits.push({ voice, when: opts.when ?? 0, velocity: opts.velocity })
  }
}

class FakeTransport implements GrooveTransport {
  onEvent: SchedulerEventCallback | null = null
  meter: { beatsPerBar?: number; subdivisionsPerBeat?: number } | null = null
  swing: number | null = null
  started = 0
  stopped = 0
  setMeter(meter: { beatsPerBar?: number; subdivisionsPerBeat?: number }): void {
    this.meter = meter
  }
  setSwing(swing: number): void {
    this.swing = swing
  }
  start(): void {
    this.started += 1
  }
  stop(): void {
    this.stopped += 1
  }
  /** Drive one scheduler event through the wired handler. */
  emit(position: GridPosition, when: number): void {
    this.onEvent?.({ ...position, step: 0 }, when)
  }
}

function makePlayer(options?: ConstructorParameters<typeof GroovePlayer>[2]): {
  player: GroovePlayer
  kit: FakeKit
  transport: FakeTransport
} {
  const kit = new FakeKit()
  const transport = new FakeTransport()
  const player = new GroovePlayer(transport, kit, options)
  return { player, kit, transport }
}

describe('GroovePlayer wiring', () => {
  it('defaults to the first shipped groove', () => {
    const { player } = makePlayer()
    expect(player.currentGroove.id).toBe(DEFAULT_GROOVE.id)
  })

  it('applies the groove grid to the transport on start', () => {
    const { player, transport } = makePlayer({ groove: getGroove('swing') })
    player.start()
    expect(transport.meter).toEqual({ beatsPerBar: 4, subdivisionsPerBeat: 3 })
    expect(transport.swing).toBe(0)
    expect(transport.started).toBe(1)
    expect(transport.onEvent).not.toBeNull()
  })

  it('re-applies the grid when the groove changes', () => {
    const { player, transport } = makePlayer({ groove: getGroove('rock-8ths') })
    player.setGroove(getGroove('rock-16ths'))
    expect(transport.meter).toEqual({ beatsPerBar: 4, subdivisionsPerBeat: 4 })
    expect(player.currentGroove.id).toBe('rock-16ths')
  })

  it('detaches the handler and stops the transport on stop', () => {
    const { player, transport } = makePlayer()
    player.start()
    player.stop()
    expect(transport.stopped).toBe(1)
    expect(transport.onEvent).toBeNull()
  })
})

describe('GroovePlayer playback', () => {
  it('triggers the groove hits at the event time, past the count-in', () => {
    const { player, kit, transport } = makePlayer({
      groove: getGroove('rock-8ths'),
      countIn: { bars: 0 },
    })
    player.start()
    transport.emit(pos(0, 0, 0), 1.5) // beat 1: kick
    transport.emit(pos(0, 1, 0), 2.0) // beat 2: snare (+ hat)
    const kick = kit.hits.find((h) => h.voice === 'kick')
    expect(kick).toEqual({ voice: 'kick', when: 1.5, velocity: 0.9 })
    expect(kit.hits.some((h) => h.voice === 'snare' && h.when === 2.0)).toBe(true)
  })

  it('plays the count-in click before the groove starts', () => {
    const { player, kit, transport } = makePlayer({
      groove: getGroove('rock-8ths'),
      countIn: { bars: 1 },
    })
    player.start()
    // Count-in bar: only hat-closed ticks, one per beat.
    transport.emit(pos(0, 0, 0), 0)
    transport.emit(pos(0, 0, 1), 0.25) // off-beat: silent
    transport.emit(pos(0, 1, 0), 0.5)
    expect(kit.hits.map((h) => h.voice)).toEqual(['hat-closed', 'hat-closed'])
    expect(kit.hits[0]?.velocity).toBe(DEFAULT_COUNT_IN.accentVelocity)
    // First groove bar begins at scheduler bar 1.
    kit.hits.length = 0
    transport.emit(pos(1, 0, 0), 2)
    expect(kit.hits.some((h) => h.voice === 'kick')).toBe(true)
  })

  it('honours per-voice mutes for groove hits', () => {
    const { player, kit, transport } = makePlayer({
      groove: getGroove('rock-8ths'),
      countIn: { bars: 0 },
    })
    player.mute('kick')
    player.start()
    transport.emit(pos(0, 0, 0), 0) // kick step, muted
    expect(kit.hits.some((h) => h.voice === 'kick')).toBe(false)
    player.unmute('kick')
    transport.emit(pos(1, 0, 0), 1)
    expect(kit.hits.some((h) => h.voice === 'kick')).toBe(true)
  })

  it('toggleMute reports the new state and tracks the muted set', () => {
    const { player } = makePlayer()
    expect(player.toggleMute('snare')).toBe(true)
    expect(player.isMuted('snare')).toBe(true)
    expect(player.mutedVoices).toEqual(['snare'])
    expect(player.toggleMute('snare')).toBe(false)
    expect(player.isMuted('snare')).toBe(false)
  })

  it('does not mute the count-in click', () => {
    const { player, kit, transport } = makePlayer({
      groove: getGroove('rock-8ths'),
      countIn: { bars: 1, voice: 'hat-closed' },
    })
    player.mute('hat-closed')
    player.start()
    transport.emit(pos(0, 0, 0), 0)
    expect(kit.hits.some((h) => h.voice === 'hat-closed')).toBe(true)
  })

  it('schedules nothing while disabled, and resumes when re-enabled', () => {
    const { player, kit, transport } = makePlayer({
      groove: getGroove('rock-8ths'),
      countIn: { bars: 0 },
      enabled: false,
    })
    player.start()
    transport.emit(pos(0, 0, 0), 0)
    expect(kit.hits).toEqual([])
    player.setEnabled(true)
    transport.emit(pos(1, 0, 0), 1)
    expect(kit.hits.length).toBeGreaterThan(0)
  })

  it('reflects the configured count-in bar count', () => {
    const { player } = makePlayer({ countIn: { bars: 2 } })
    expect(player.countInBars).toBe(2)
    player.setCountIn({ bars: 0 })
    expect(player.countInBars).toBe(0)
  })
})

// --- Registry ----------------------------------------------------------------

describe('groove registry', () => {
  it('recognises shipped ids and rejects others', () => {
    expect(isGrooveId('funk')).toBe(true)
    expect(isGrooveId('nope')).toBe(false)
    expect(isGrooveId(42)).toBe(false)
  })
  it('looks up by id and falls back to the default', () => {
    expect(getGroove('funk').id).toBe('funk')
    expect(getGroove('missing').id).toBe(DEFAULT_GROOVE.id)
  })
  it('ships all seven roadmap grooves', () => {
    expect(GROOVES.map((g) => g.id)).toEqual([
      'rock-8ths',
      'rock-16ths',
      'funk',
      'swing',
      'bossa',
      'blues-12-8',
      'half-time',
    ])
  })
})

// --- Data sanity -------------------------------------------------------------

describe('groove data sanity', () => {
  it('has stepsPerBar equal to beatsPerBar * subdivision steps', () => {
    for (const g of GROOVES) {
      expect(g.stepsPerBar).toBe(grooveBeatsPerBar(g) * subdivisionsPerBeat(g.subdivision))
    }
  })

  it('sizes every present track to stepsPerBar * bars', () => {
    for (const g of GROOVES) {
      const expected = grooveStepCount(g)
      for (const voice of DRUM_VOICES) {
        const track = g.tracks[voice]
        if (!track) continue
        expect(track.length, `${g.id}/${voice}`).toBe(expected)
      }
    }
  })

  it('keeps every velocity within (0..1] for hits and 0 for rests', () => {
    for (const g of GROOVES) {
      for (const voice of DRUM_VOICES) {
        const track = g.tracks[voice]
        if (!track) continue
        for (const step of track) {
          expect(step).toBeGreaterThanOrEqual(0)
          expect(step).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('gives every groove a kick, a snare and a cymbal voice', () => {
    for (const g of GROOVES) {
      expect(g.tracks.kick, `${g.id} kick`).toBeDefined()
      expect(g.tracks.snare, `${g.id} snare`).toBeDefined()
      const hasCymbal = CYMBALS.some((voice) => g.tracks[voice] !== undefined)
      expect(hasCymbal, `${g.id} cymbal`).toBe(true)
    }
  })

  it('has at least one hit in every present track', () => {
    for (const g of GROOVES) {
      for (const voice of DRUM_VOICES) {
        const track = g.tracks[voice]
        if (!track) continue
        expect(track.some((step) => step > 0), `${g.id}/${voice}`).toBe(true)
      }
    }
  })

  it('uses dynamic accents rather than flat velocities', () => {
    // Each groove should contain more than one distinct hit velocity overall.
    for (const g of GROOVES) {
      const velocities = new Set<number>()
      for (const voice of DRUM_VOICES) {
        for (const step of g.tracks[voice] ?? []) {
          if (step > 0) velocities.add(step)
        }
      }
      expect(velocities.size, `${g.id} dynamics`).toBeGreaterThan(1)
    }
  })

  it('gives funk quiet ghost-note snares under its backbeat', () => {
    const snare = getGroove('funk').tracks.snare ?? []
    const hits = snare.filter((s) => s > 0)
    const ghosts = hits.filter((s) => s < 0.3)
    const backbeats = hits.filter((s) => s >= 0.8)
    expect(ghosts.length).toBeGreaterThan(0)
    expect(backbeats.length).toBeGreaterThan(0)
  })
})
