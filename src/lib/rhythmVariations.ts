/**
 * Rhythm variation layer (M5) — apply a rhythm pattern to ANY dexterity
 * exercise (built-in patterns, scale sequences, arpeggios) so notes follow the
 * chosen rhythm instead of one note per metronome beat, plus an
 * accent-every-N-notes displacement layer.
 *
 * Pure and framework-free like the rest of `src/lib/`. It works over the same
 * `ExerciseStep[]` all three drill modes emit and hands its output straight
 * into the existing scheduling machinery in `exercises.ts`
 * (`locateStep`/`StepTiming`).
 *
 * Timing is expressed in EXACT rational beat offsets. A `Rhythm` maps the steps
 * of one exercise loop onto beat offsets by cycling its per-beat `offsets` over
 * the whole sequence: e.g. `triplets` (offsets 0, 1/3, 2/3) turns steps into
 * onsets 0, 1/3, 2/3, 1, 4/3 … — all kept as reduced fractions so a triplet
 * offset is exactly k/3, never a lossy 0.333… float.
 *
 * Scheduling: the Dexterity page runs its `Scheduler` at a fixed fine
 * resolution of `RHYTHM_RESOLUTION` (12) subdivisions per beat — the LCM of the
 * halves, thirds, and quarters every rhythm needs — so every rhythm onset lands
 * on an exact integer grid tick (1/3 → 4 ticks, 3/4 → 9 ticks). `rhythmTiming`
 * produces a `StepTiming` in those ticks that the existing `locateStep` maps
 * the scheduler's absolute step onto, unchanged. No scheduler changes needed.
 *
 * Accents: with the accent layer off, the first note landing in each beat is
 * accented (the natural pulse). `accentEveryN` overrides that, accenting every
 * Nth note regardless of the rhythm's own grouping — so a 3-against-4 accent
 * over sixteenths shifts through the beat and yields a displacement drill.
 */

import type { ExerciseStep } from './exercises.ts'

// --- Exact fractions ---------------------------------------------------------

/** A rational number in lowest terms, `den > 0`. Used for exact beat offsets. */
export interface Fraction {
  readonly num: number
  readonly den: number
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    ;[x, y] = [y, x % y]
  }
  return x === 0 ? 1 : x
}

/** Build a reduced fraction (`den > 0`); `0` is normalized to `0/1`. */
export function fraction(num: number, den: number): Fraction {
  if (den === 0) throw new Error('fraction: zero denominator')
  const sign = den < 0 ? -1 : 1
  const n = num * sign
  const d = den * sign
  if (n === 0) return { num: 0, den: 1 }
  const g = gcd(n, d)
  return { num: n / g, den: d / g }
}

/** Decimal value of a fraction (only for the audio boundary, never for tests). */
export function fractionToNumber(f: Fraction): number {
  return f.num / f.den
}

/** Exact structural equality of two fractions (both must be reduced). */
export function fractionsEqual(a: Fraction, b: Fraction): boolean {
  return a.num === b.num && a.den === b.den
}

/**
 * Convert a beat-offset fraction to an integer count of grid ticks at
 * `resolution` ticks per beat. Requires `resolution` to be a multiple of the
 * fraction's denominator (guaranteed for every built-in rhythm at
 * `RHYTHM_RESOLUTION`), so the result is exact with no rounding.
 */
export function fractionToTicks(f: Fraction, resolution: number): number {
  if (resolution % f.den !== 0) {
    throw new Error(`fractionToTicks: ${f.num}/${f.den} not expressible at resolution ${resolution}`)
  }
  return f.num * (resolution / f.den)
}

/** Integer floor of a fraction (which whole beat it sits in). */
function floorFraction(f: Fraction): number {
  return Math.floor(f.num / f.den)
}

// --- Rhythm definitions ------------------------------------------------------

export type RhythmId =
  | 'straight-quarters'
  | 'eighths'
  | 'triplets'
  | 'sixteenths'
  | 'gallop'
  | 'reverse-gallop'
  | 'dotted-8th-16th'
  | 'offbeat-8ths'

/**
 * A rhythm pattern. `offsets` are the beat offsets (in `[0, 1)`) of the notes
 * within one cycle; `cycleBeats` is how many beats a cycle spans (always 1 for
 * the built-ins). The steps of an exercise are laid onto successive cycles, so
 * `offsets.length` notes fall in each `cycleBeats`-beat window.
 */
export interface Rhythm {
  id: RhythmId
  name: string
  description: string
  offsets: readonly Fraction[]
  cycleBeats: number
}

const F0 = fraction(0, 1)

/** All rhythms, in picker order. */
export const RHYTHMS: readonly Rhythm[] = [
  {
    id: 'straight-quarters',
    name: 'Straight (quarters)',
    description: 'One note per beat — the plain pulse.',
    offsets: [F0],
    cycleBeats: 1,
  },
  {
    id: 'eighths',
    name: 'Eighths',
    description: 'Two even notes per beat (1 & 2 & …).',
    offsets: [F0, fraction(1, 2)],
    cycleBeats: 1,
  },
  {
    id: 'triplets',
    name: 'Triplets',
    description: 'Three even notes per beat (1-trip-let).',
    offsets: [F0, fraction(1, 3), fraction(2, 3)],
    cycleBeats: 1,
  },
  {
    id: 'sixteenths',
    name: 'Sixteenths',
    description: 'Four even notes per beat (1 e & a).',
    offsets: [F0, fraction(1, 4), fraction(1, 2), fraction(3, 4)],
    cycleBeats: 1,
  },
  {
    id: 'gallop',
    name: 'Gallop',
    description: 'Eighth then two sixteenths per beat (1 . & a) — the classic gallop.',
    offsets: [F0, fraction(1, 2), fraction(3, 4)],
    cycleBeats: 1,
  },
  {
    id: 'reverse-gallop',
    name: 'Reverse gallop',
    description: 'Two sixteenths then an eighth per beat (1 e & .).',
    offsets: [F0, fraction(1, 4), fraction(1, 2)],
    cycleBeats: 1,
  },
  {
    id: 'dotted-8th-16th',
    name: 'Dotted 8th + 16th',
    description: 'A long-short dotted-eighth then sixteenth per beat (1 . . a).',
    offsets: [F0, fraction(3, 4)],
    cycleBeats: 1,
  },
  {
    id: 'offbeat-8ths',
    name: 'Offbeat eighths',
    description: 'One note per beat on the "&" — starts off the beat.',
    offsets: [fraction(1, 2)],
    cycleBeats: 1,
  },
]

export const RHYTHM_IDS: readonly RhythmId[] = RHYTHMS.map((r) => r.id)

export const DEFAULT_RHYTHM_ID: RhythmId = 'straight-quarters'

/** Type guard for a persisted/typed rhythm id. */
export function isRhythmId(value: unknown): value is RhythmId {
  return typeof value === 'string' && (RHYTHM_IDS as readonly string[]).includes(value)
}

/** Look up a rhythm by id, falling back to the default for unknown ids. */
export function getRhythm(id: string): Rhythm {
  return RHYTHMS.find((r) => r.id === id) ?? RHYTHMS[0]!
}

/**
 * The four subdivisions the tool historically offered as "notes per beat" map
 * onto the matching even rhythm, used to migrate older settings sensibly.
 */
export function rhythmForNotesPerBeat(notesPerBeat: unknown): RhythmId {
  switch (notesPerBeat) {
    case 2:
      return 'eighths'
    case 3:
      return 'triplets'
    case 4:
      return 'sixteenths'
    default:
      return 'straight-quarters'
  }
}

// --- Accent options ----------------------------------------------------------

/** Accent-every-N choices offered by the UI; `0` means the accent layer is off. */
export const ACCENT_EVERY_N_OPTIONS = [0, 2, 3, 4] as const

export type AccentEveryN = (typeof ACCENT_EVERY_N_OPTIONS)[number]

/** Type guard for a persisted/typed accent-every-N value. */
export function isAccentEveryN(value: unknown): value is AccentEveryN {
  return (ACCENT_EVERY_N_OPTIONS as readonly number[]).includes(value as number)
}

// --- Rhythmizing -------------------------------------------------------------

/** One exercise step placed at an exact beat offset, with its accent flag. */
export interface RhythmEvent {
  /** The exercise step this onset plays. */
  step: ExerciseStep
  /** Index of the step within the sequence (0-based). */
  index: number
  /** Exact beats from the loop start where the note sounds. */
  beatOffset: Fraction
  /** Whether the note is accented (louder/emphasized). */
  accent: boolean
}

/** A rhythmized loop: its events plus the whole-beat length of one loop. */
export interface RhythmizedSequence {
  events: RhythmEvent[]
  /** Total beats in one loop (a whole number, so loops fall on beat lines). */
  loopBeats: number
}

/**
 * Lay an exercise's steps onto a rhythm, cycling the rhythm's `offsets` across
 * the whole sequence. Step `i` sits in cycle `floor(i / notesPerCycle)` at that
 * cycle's `i % notesPerCycle`-th offset, so its beat offset is
 * `cycle * cycleBeats + offset` — kept exact as a reduced fraction.
 *
 * The loop rounds up to a whole number of cycles (so it always ends on a beat
 * line and the metronome/position-advance stay aligned); a partial final cycle
 * simply leaves its trailing slots as rests.
 *
 * Default accent: the first note landing in each beat is accented.
 */
export function rhythmizeSteps(steps: readonly ExerciseStep[], rhythm: Rhythm): RhythmizedSequence {
  const notesPerCycle = rhythm.offsets.length
  const events: RhythmEvent[] = []
  let prevBeat = -1
  steps.forEach((step, index) => {
    const cycle = Math.floor(index / notesPerCycle)
    const slot = index % notesPerCycle
    const offset = rhythm.offsets[slot]!
    // beatOffset = cycle * cycleBeats + offset, exact.
    const beatsBefore = cycle * rhythm.cycleBeats
    const beatOffset = fraction(beatsBefore * offset.den + offset.num, offset.den)
    const beat = floorFraction(beatOffset)
    const accent = beat !== prevBeat
    prevBeat = beat
    events.push({ step, index, beatOffset, accent })
  })
  const cycles = notesPerCycle > 0 ? Math.ceil(steps.length / notesPerCycle) : 0
  const loopBeats = cycles * rhythm.cycleBeats
  return { events, loopBeats }
}

/**
 * Override each event's accent so every Nth note (starting at `phase`) is
 * accented, independent of the rhythm's grouping. Returns a NEW array; inputs
 * are not mutated. `n <= 1` accents every note. This is what produces
 * displacement drills — e.g. `n = 3` over sixteenths accents notes 0, 3, 6 …,
 * marching the accent through the four-note beat.
 */
export function accentEveryN(
  events: readonly RhythmEvent[],
  n: number,
  phase = 0,
): RhythmEvent[] {
  const step = Math.max(1, Math.floor(n))
  const ph = ((Math.floor(phase) % step) + step) % step
  return events.map((event, index) => ({
    ...event,
    accent: (((index - ph) % step) + step) % step === 0,
  }))
}

/**
 * Apply the accent choice to a rhythmized sequence's events: `0` keeps the
 * rhythm's default first-of-beat accents, any other value delegates to
 * `accentEveryN`.
 */
export function applyAccent(events: readonly RhythmEvent[], accent: AccentEveryN): RhythmEvent[] {
  return accent === 0 ? [...events] : accentEveryN(events, accent)
}

// --- Grid timing (reuses the exercises.ts StepTiming shape) ------------------

/** Fine grid resolution the scheduler runs at: 12 = LCM of 2, 3, 4 ticks/beat. */
export const RHYTHM_RESOLUTION = 12

/** Onsets in grid ticks plus the loop length in ticks — a `StepTiming`. */
export interface RhythmTiming {
  onsets: number[]
  totalGridSteps: number
}

/**
 * Convert a rhythmized sequence to grid-tick timing at `resolution` ticks per
 * beat. Every onset is exact (each rhythm's denominators divide 12), and the
 * loop spans `loopBeats * resolution` ticks. The result matches the
 * `StepTiming` shape so `locateStep` from `exercises.ts` consumes it directly.
 */
export function rhythmTiming(
  seq: RhythmizedSequence,
  resolution = RHYTHM_RESOLUTION,
): RhythmTiming {
  const onsets = seq.events.map((e) => fractionToTicks(e.beatOffset, resolution))
  return { onsets, totalGridSteps: seq.loopBeats * resolution }
}

/**
 * Length in grid ticks each note sounds for: the gap to the next onset, with
 * the last note extended to the loop's end. Used to size playback note lengths.
 */
export function noteDurationsTicks(timing: RhythmTiming): number[] {
  const { onsets, totalGridSteps } = timing
  return onsets.map((onset, i) => {
    const next = i + 1 < onsets.length ? onsets[i + 1]! : totalGridSteps
    return Math.max(1, next - onset)
  })
}
