/**
 * Pure logic for the Play-Along chord-progression accompaniment: degree
 * parsing/validation, progression presets, expansion of scale degrees to
 * key-spelled chords, voice-led close voicings, bar -> chord mapping (with a
 * bars-per-chord setting), the comping-voice event decisions, and the persisted
 * settings shape.
 *
 * Everything here is framework-free and node-safe (no `window`, no Web Audio at
 * module load — it only imports the pure `GridPosition` *type* from the
 * scheduler), so the whole progression engine is unit-testable. The one impure
 * class, `ChordCompPlayer`, is thin glue that maps scheduler events onto a
 * `ChordTrigger` (the `AudioEngine` satisfies it structurally); it holds no Web
 * Audio itself and takes its synth injected, so it too runs under the `node`
 * test environment with a mock trigger.
 *
 * Chords stay sample-accurately in sync with the drums because the React page
 * feeds `ChordCompPlayer.handleEvent` the very same `Scheduler` events the
 * `GroovePlayer` consumes, at the same audio `when` times.
 */

import { VOICING_BASE_MIDI } from './chordExplorer.ts'
import { buildDiatonicChordCards, nearestVoicing } from './diatonicChords.ts'
import type { GridPosition } from './audio/scheduler.ts'
import { getChordQuality, type ChordQuality } from './theory/chords.ts'
import { mod12, pcToName, type Midi, type PitchClass } from './theory/notes.ts'
import { prefersFlats } from './theory/spell.ts'

// --- Degree parsing / validation ---------------------------------------------

/** Lowest / highest scale degree accepted (diatonic, major key). */
export const MIN_DEGREE = 1
export const MAX_DEGREE = 7
/** Upper bound on a custom progression's length, to keep the UI sane. */
export const MAX_CUSTOM_DEGREES = 16

export interface DegreeParseOk {
  ok: true
  degrees: number[]
}
export interface DegreeParseErr {
  ok: false
  error: string
}
export type DegreeParseResult = DegreeParseOk | DegreeParseErr

/**
 * Parse a custom degree string like "1-5-6-4", "2 5 1" or "1,4,5,1" into a list
 * of diatonic degrees (1–7). Separators are any run of whitespace, commas or
 * hyphens/dashes. Returns a friendly error for empty input, a non-1–7 token, or
 * more than `MAX_CUSTOM_DEGREES` degrees. Pure — no state, no throwing.
 */
export function parseDegrees(input: string): DegreeParseResult {
  const tokens = input
    .split(/[\s,–—-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) {
    return { ok: false, error: 'Enter at least one degree (1–7), e.g. 1-5-6-4.' }
  }
  if (tokens.length > MAX_CUSTOM_DEGREES) {
    return { ok: false, error: `Too many chords — keep it to ${MAX_CUSTOM_DEGREES} or fewer.` }
  }
  const degrees: number[] = []
  for (const token of tokens) {
    if (!/^[1-7]$/.test(token)) {
      return { ok: false, error: `"${token}" isn't a degree — use numbers 1–7.` }
    }
    degrees.push(Number(token))
  }
  return { ok: true, degrees }
}

// --- Progressions -------------------------------------------------------------

/**
 * One chord slot in a progression: a diatonic degree plus an optional forced
 * quality id. Diatonic presets leave `qualityId` unset (the key's own triad
 * quality is used); the 12-bar blues forces `dom7` on every chord.
 */
export interface DegreeSpec {
  degree: number
  qualityId?: string
}

export interface ProgressionPreset {
  id: string
  /** Short display name for the picker. */
  name: string
  /** Roman-numeral layout, e.g. "I · V · vi · IV". */
  label: string
  specs: DegreeSpec[]
  /** When set, bars-per-chord is fixed to this (the 12-bar blues form = 1). */
  fixedBarsPerChord?: number
}

/** Id used for the free-form custom-degree progression. */
export const CUSTOM_PROGRESSION_ID = 'custom'

function degs(list: number[]): DegreeSpec[] {
  return list.map((degree) => ({ degree }))
}

/** 12-bar blues form: I-I-I-I-IV-IV-I-I-V-IV-I-I, all dominant 7ths. */
function bluesSpecs(): DegreeSpec[] {
  return [1, 1, 1, 1, 4, 4, 1, 1, 5, 4, 1, 1].map((degree) => ({ degree, qualityId: 'dom7' }))
}

export const PROGRESSION_PRESETS: readonly ProgressionPreset[] = [
  { id: 'I-V-vi-IV', name: 'I–V–vi–IV', label: 'I · V · vi · IV', specs: degs([1, 5, 6, 4]) },
  { id: 'ii-V-I', name: 'ii–V–I', label: 'ii · V · I', specs: degs([2, 5, 1]) },
  { id: 'I-IV-V-I', name: 'I–IV–V–I', label: 'I · IV · V · I', specs: degs([1, 4, 5, 1]) },
  { id: 'vi-IV-I-V', name: 'vi–IV–I–V', label: 'vi · IV · I · V', specs: degs([6, 4, 1, 5]) },
  {
    id: 'blues-12',
    name: '12-Bar Blues',
    label: 'I⁷ · IV⁷ · V⁷ (12-bar)',
    specs: bluesSpecs(),
    fixedBarsPerChord: 1,
  },
]

export function getProgressionPreset(id: string): ProgressionPreset | undefined {
  return PROGRESSION_PRESETS.find((p) => p.id === id)
}

/** Whether a string names a shipped preset or the custom progression. */
export function isProgressionId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === CUSTOM_PROGRESSION_ID || PROGRESSION_PRESETS.some((p) => p.id === value))
  )
}

// --- Degrees -> key-spelled chords --------------------------------------------

export interface AccompChord {
  /** Scale degree, 1-based (1 = tonic). */
  degree: number
  root: PitchClass
  quality: ChordQuality
  /** Key-spelled chord symbol, e.g. "Em", "G", "C7". */
  symbol: string
}

/**
 * Resolve degree specs against a major key (root pitch class) to concrete,
 * key-spelled chords. Diatonic slots take the key's own triad quality; a slot
 * with a `qualityId` override (blues dom7) keeps the diatonic root letter but
 * swaps in that quality's symbol suffix. Reuses the tested diatonic-chord
 * spelling so enharmonics stay correct.
 */
export function resolveProgressionChords(
  rootPc: PitchClass,
  specs: readonly DegreeSpec[],
): AccompChord[] {
  const cards = buildDiatonicChordCards(mod12(rootPc), 'major')
  return specs.map((spec) => {
    const card = cards[spec.degree - 1]
    if (!card) throw new Error(`Invalid scale degree: ${spec.degree}`)
    if (spec.qualityId) {
      const quality = getChordQuality(spec.qualityId)
      const rootName = card.toneNames[0] ?? card.symbol
      return { degree: spec.degree, root: card.root, quality, symbol: rootName + quality.symbol }
    }
    return { degree: spec.degree, root: card.root, quality: card.quality, symbol: card.symbol }
  })
}

/**
 * Voice-led close voicings for a progression: each chord voiced (around
 * `baseMidi`, default C4) as the inversion whose centre lands nearest the
 * previous chord, so the comping voice moves smoothly. Index-aligned with
 * `chords`.
 */
export function voiceLeadProgression(
  chords: readonly AccompChord[],
  baseMidi: Midi = VOICING_BASE_MIDI,
): Midi[][] {
  let previous: Midi[] | null = null
  return chords.map((chord) => {
    const midis = nearestVoicing(chord.root, chord.quality, previous, baseMidi)
    previous = midis
    return midis
  })
}

// --- Bars-per-chord mapping ---------------------------------------------------

export const MIN_BARS_PER_CHORD = 1
export const MAX_BARS_PER_CHORD = 2

/** Clamp bars-per-chord into the supported range (1 or 2); NaN -> minimum. */
export function clampBarsPerChord(value: number): number {
  if (!Number.isFinite(value)) return MIN_BARS_PER_CHORD
  return Math.min(MAX_BARS_PER_CHORD, Math.max(MIN_BARS_PER_CHORD, Math.round(value)))
}

/** Total bars one loop of the progression spans. */
export function progressionTotalBars(chordCount: number, barsPerChord: number): number {
  return Math.max(0, Math.floor(chordCount)) * clampBarsPerChord(barsPerChord)
}

/**
 * Which progression-chord index sounds in pattern bar `bar` (0-based, count-in
 * already removed), looping. `null` when the progression has no chords.
 */
export function barToChordIndex(
  bar: number,
  chordCount: number,
  barsPerChord: number,
): number | null {
  if (chordCount <= 0) return null
  const bpc = clampBarsPerChord(barsPerChord)
  const total = chordCount * bpc
  const wrapped = ((bar % total) + total) % total
  return Math.floor(wrapped / bpc)
}

// --- Comping voice ------------------------------------------------------------

/** Comping style: a sustained pad (one chord per bar) or beat-by-beat stabs. */
export type CompStyle = 'pad' | 'stabs'
export const COMP_STYLES: readonly CompStyle[] = ['pad', 'stabs']

export function isCompStyle(value: unknown): value is CompStyle {
  return value === 'pad' || value === 'stabs'
}

/**
 * Whether a comp chord fires at this grid position under the given style. A pad
 * fires once per bar (the downbeat); stabs fire on every beat head. Off-beat
 * subdivisions never trigger the comp.
 */
export function compTriggersAt(position: GridPosition, style: CompStyle): boolean {
  if (position.subdivision !== 0) return false
  return style === 'pad' ? position.beat === 0 : true
}

/** How long a comp chord is gated, in seconds. */
export function compChordDuration(style: CompStyle, beatsPerBar: number, bpm: number): number {
  const secondsPerBeat = 60 / (bpm > 0 ? bpm : 120)
  if (style === 'pad') return secondsPerBeat * Math.max(1, beatsPerBar)
  return secondsPerBeat * 0.6
}

/** Moderate velocity so the comp sits behind the drums. */
export const DEFAULT_COMP_VELOCITY = 0.5

/** Envelope + waveform for the soft, sustained pad. */
const PAD_VOICE = {
  type: 'triangle' as OscillatorType,
  attack: 0.09,
  decay: 0.2,
  sustain: 0.85,
  release: 0.55,
}
/** Envelope + waveform for the shorter comping stabs. */
const STAB_VOICE = {
  type: 'sawtooth' as OscillatorType,
  attack: 0.008,
  decay: 0.09,
  sustain: 0.35,
  release: 0.14,
}

export function compVoice(style: CompStyle): typeof PAD_VOICE {
  return style === 'pad' ? PAD_VOICE : STAB_VOICE
}

/** Options a `ChordTrigger` accepts (a subset of the engine's `PlayNoteOptions`). */
export interface ChordVoiceOptions {
  when?: number
  velocity?: number
  type?: OscillatorType
  attack?: number
  decay?: number
  sustain?: number
  release?: number
}

/** The only thing the comp player needs from the audio engine. */
export interface ChordTrigger {
  playChord(midis: readonly Midi[], duration: number, opts?: ChordVoiceOptions): void
}

/** Live configuration of the comping voice. */
export interface ChordCompConfig {
  /** Master enable — when false the player schedules nothing. */
  enabled: boolean
  style: CompStyle
  /** Voice-led voicings, index-aligned with the progression chords. */
  voicings: readonly Midi[][]
  /** Bars each chord is held (blues form forces 1). */
  barsPerChord: number
  /** Beats per bar of the current groove — sets a pad's held duration. */
  beatsPerBar: number
  /** Current tempo — sets the comp chord duration. */
  bpm: number
  /** Count-in bars to skip before the progression starts. */
  countInBars: number
  /** Comp velocity, 0..1. */
  velocity: number
}

export const DEFAULT_CHORD_COMP_CONFIG: ChordCompConfig = {
  enabled: false,
  style: 'pad',
  voicings: [],
  barsPerChord: 1,
  beatsPerBar: 4,
  bpm: 100,
  countInBars: 0,
  velocity: DEFAULT_COMP_VELOCITY,
}

/**
 * Thin glue: turns each `Scheduler` event into a comping-chord trigger. Given
 * the same events (and audio `when`) the `GroovePlayer` receives, it plays the
 * bar's voice-led voicing at the exact bar boundary, skipping the count-in, so
 * the harmony stays locked to the drums through count-in and tempo changes.
 * All decisions come from the pure helpers above; `handleEvent` is public so it
 * can be unit-tested directly with a mock trigger.
 */
export class ChordCompPlayer {
  private cfg: ChordCompConfig

  constructor(
    private readonly synth: ChordTrigger,
    cfg: Partial<ChordCompConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_CHORD_COMP_CONFIG, ...cfg }
  }

  get config(): ChordCompConfig {
    return this.cfg
  }

  /** Replace the live configuration (key/progression/style/tempo/count-in). */
  configure(cfg: ChordCompConfig): void {
    this.cfg = cfg
  }

  handleEvent(position: GridPosition, when: number): void {
    const c = this.cfg
    if (!c.enabled || c.voicings.length === 0) return
    if (!compTriggersAt(position, c.style)) return
    if (position.bar < c.countInBars) return
    const index = barToChordIndex(position.bar - c.countInBars, c.voicings.length, c.barsPerChord)
    if (index === null) return
    const voicing = c.voicings[index]
    if (!voicing || voicing.length === 0) return
    const duration = compChordDuration(c.style, c.beatsPerBar, c.bpm)
    this.synth.playChord(voicing, duration, {
      when,
      velocity: c.velocity,
      ...compVoice(c.style),
    })
  }
}

// --- Resolving settings -> a playable / displayable progression ---------------

export interface AccompanimentSettings {
  /** Whether the accompaniment produces sound. */
  enabled: boolean
  /** Key root pitch class, 0–11 (0 = C). */
  rootPc: PitchClass
  /** Preset id (see `PROGRESSION_PRESETS`) or `CUSTOM_PROGRESSION_ID`. */
  progressionId: string
  /** Raw text for the custom degree input (parsed when `progressionId` is custom). */
  customDegrees: string
  /** Bars each chord is held (1 or 2; ignored for fixed-form presets). */
  barsPerChord: number
  style: CompStyle
}

export const DEFAULT_CUSTOM_DEGREES = '1-6-4-5'

export const DEFAULT_ACCOMPANIMENT_SETTINGS: AccompanimentSettings = {
  enabled: false,
  rootPc: 0,
  progressionId: 'I-V-vi-IV',
  customDegrees: DEFAULT_CUSTOM_DEGREES,
  barsPerChord: 1,
  style: 'pad',
}

/** Coerce arbitrary (persisted, hand-edited) data into valid accompaniment settings. */
export function normalizeAccompanimentSettings(value: unknown): AccompanimentSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof AccompanimentSettings, unknown>
  >
  const d = DEFAULT_ACCOMPANIMENT_SETTINGS
  return {
    enabled: typeof v.enabled === 'boolean' ? v.enabled : d.enabled,
    rootPc:
      typeof v.rootPc === 'number' && Number.isFinite(v.rootPc)
        ? mod12(Math.round(v.rootPc))
        : d.rootPc,
    progressionId: isProgressionId(v.progressionId) ? v.progressionId : d.progressionId,
    customDegrees: typeof v.customDegrees === 'string' ? v.customDegrees : d.customDegrees,
    barsPerChord:
      typeof v.barsPerChord === 'number' ? clampBarsPerChord(v.barsPerChord) : d.barsPerChord,
    style: isCompStyle(v.style) ? v.style : d.style,
  }
}

export interface ResolvedAccompaniment {
  /** Chord slots in progression order (empty on a custom parse error). */
  chords: AccompChord[]
  /** Voice-led voicings, index-aligned with `chords`. */
  voicings: Midi[][]
  /** Bars each chord is held (fixed-form presets override the setting). */
  barsPerChord: number
  /** Total bars one loop spans. */
  totalBars: number
  /** Whether bars-per-chord is locked by the preset (12-bar blues form). */
  barsPerChordLocked: boolean
  /** Parse error for an invalid custom progression, else null. */
  error: string | null
}

/**
 * Turn persisted accompaniment settings into everything the page needs: the
 * resolved chords, their voice-led voicings, the effective bars-per-chord, and
 * a parse error for invalid custom input. Pure end-to-end so the whole pipeline
 * is testable.
 */
export function resolveAccompaniment(
  settings: AccompanimentSettings,
  baseMidi: Midi = VOICING_BASE_MIDI,
): ResolvedAccompaniment {
  let specs: DegreeSpec[]
  let barsPerChord = clampBarsPerChord(settings.barsPerChord)
  let barsPerChordLocked = false

  if (settings.progressionId === CUSTOM_PROGRESSION_ID) {
    const parsed = parseDegrees(settings.customDegrees)
    if (!parsed.ok) {
      return {
        chords: [],
        voicings: [],
        barsPerChord,
        totalBars: 0,
        barsPerChordLocked: false,
        error: parsed.error,
      }
    }
    specs = parsed.degrees.map((degree) => ({ degree }))
  } else {
    const preset = getProgressionPreset(settings.progressionId) ?? PROGRESSION_PRESETS[0]!
    specs = preset.specs.map((s) => ({ ...s }))
    if (preset.fixedBarsPerChord !== undefined) {
      barsPerChord = preset.fixedBarsPerChord
      barsPerChordLocked = true
    }
  }

  const chords = resolveProgressionChords(settings.rootPc, specs)
  const voicings = voiceLeadProgression(chords, baseMidi)
  return {
    chords,
    voicings,
    barsPerChord,
    totalBars: progressionTotalBars(chords.length, barsPerChord),
    barsPerChordLocked,
    error: null,
  }
}

// --- Key picker ----------------------------------------------------------------

export interface KeyOption {
  pc: PitchClass
  /** Root name spelled per `prefersFlats` (e.g. "Bb", "F#"). */
  name: string
}

/** The 12 chromatic roots for the key picker, each spelled per `prefersFlats`. */
export function keyOptions(): KeyOption[] {
  return Array.from({ length: 12 }, (_, pc) => ({
    pc,
    name: pcToName(pc, prefersFlats(pc) ? 'flat' : 'sharp'),
  }))
}
