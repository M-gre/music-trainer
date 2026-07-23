/**
 * Metronome click voices and per-beat accent model — PURE.
 *
 * The old metronome used a single square-wave blip, which is harsh. This module
 * replaces it with four softer, synthesized voices and a four-level accent
 * scheme, and computes the low-level `ClickSpec` the engine renders. It contains
 * NO Web Audio calls and never touches `window`, so every timbral/accent
 * decision here is unit-testable under the `node` environment; `engine.playClick`
 * just wires the nodes the returned spec describes.
 *
 * Accent levels (`off | low | mid | high`) map, per voice, to increasing gain
 * and slightly rising pitch. `off` produces no click. Subdivision clicks are
 * automatically quieter and shorter so the main pulse stays clear. Each voice
 * carries a `loudness` calibration so the four voices sit at a comparable
 * perceived level.
 */

import type { ClickSpec } from './engine.ts'

/** Accent levels a beat can cycle through. `off` is silent. */
export const ACCENT_LEVELS = ['off', 'low', 'mid', 'high'] as const
export type AccentLevel = (typeof ACCENT_LEVELS)[number]
/** Accent levels that actually sound (everything but `off`). */
export type AudibleAccent = Exclude<AccentLevel, 'off'>

/** Advance a beat's accent one step in the cycle off -> low -> mid -> high -> off. */
export function cycleAccent(level: AccentLevel): AccentLevel {
  const index = ACCENT_LEVELS.indexOf(level)
  // Unknown values (index -1) restart the cycle at the first audible level.
  const next = ACCENT_LEVELS[(index + 1) % ACCENT_LEVELS.length]
  return next ?? 'off'
}

/** Whether a string is a valid accent level. */
export function isAccentLevel(value: unknown): value is AccentLevel {
  return typeof value === 'string' && (ACCENT_LEVELS as readonly string[]).includes(value)
}

// --- Voices ------------------------------------------------------------------

export const CLICK_VOICE_IDS = ['woodblock', 'blip', 'tick', 'beep'] as const
export type ClickVoiceId = (typeof CLICK_VOICE_IDS)[number]

/** The default voice — warm and soft, the antidote to the old square click. */
export const DEFAULT_CLICK_VOICE_ID: ClickVoiceId = 'woodblock'

/** Gain/pitch multipliers for one audible accent level. */
export interface VoiceAccent {
  /** Multiplier on the voice's base loudness. */
  gain: number
  /** Multiplier on the voice's base frequency (slight rise for stronger accents). */
  pitch: number
}

export type AccentTable = Record<AudibleAccent, VoiceAccent>

export interface ClickVoiceDef {
  id: ClickVoiceId
  /** Short label for the picker. */
  label: string
  /** One-line description of the character. */
  description: string
  /** Base frequency (Hz) at the `mid` accent level. */
  baseFrequency: number
  /**
   * Perceived-loudness calibration (0..1). Higher/pure tones read louder per
   * unit gain, so this balances the voices against each other at equal accent.
   */
  loudness: number
  /** Per-accent gain/pitch table. */
  accents: AccentTable
  /** Turn a resolved frequency + gain into a full synthesis spec. */
  build(frequency: number, gain: number, isSubdivision: boolean): ClickSpec
}

/** Subdivision clicks are scaled to this fraction of the beat gain, automatically. */
export const SUBDIVISION_GAIN_SCALE = 0.5

/**
 * Woodblock: a triangle burst with a fast downward pitch drop and a gentle
 * lowpass — a warm, woody "tok" with no harsh high end.
 */
const WOODBLOCK: ClickVoiceDef = {
  id: 'woodblock',
  label: 'Woodblock',
  description: 'Warm woody tok — soft, the default',
  baseFrequency: 900,
  loudness: 0.62,
  accents: {
    low: { gain: 0.7, pitch: 0.82 },
    mid: { gain: 1.0, pitch: 1.0 },
    high: { gain: 1.3, pitch: 1.14 },
  },
  build: (frequency, gain, isSub) => ({
    gain,
    duration: isSub ? 0.03 : 0.05,
    attack: 0.001,
    source: { kind: 'osc', type: 'triangle', frequency, endFrequency: frequency * 0.55 },
    filter: { type: 'lowpass', frequency: frequency * 4, q: 0.7 },
  }),
}

/** Blip: a pure sine with a soft attack — the gentlest, most rounded voice. */
const BLIP: ClickVoiceDef = {
  id: 'blip',
  label: 'Blip',
  description: 'Pure sine with a soft attack — very gentle',
  baseFrequency: 1000,
  loudness: 0.78,
  accents: {
    low: { gain: 0.7, pitch: 0.8 },
    mid: { gain: 1.0, pitch: 1.0 },
    high: { gain: 1.35, pitch: 1.25 },
  },
  build: (frequency, gain, isSub) => ({
    gain,
    duration: isSub ? 0.035 : 0.06,
    attack: 0.006,
    source: { kind: 'osc', type: 'sine', frequency },
  }),
}

/** Tick: a bandpassed white-noise burst — a subtle, dry rim tick. */
const TICK: ClickVoiceDef = {
  id: 'tick',
  label: 'Tick',
  description: 'Bandpassed noise — subtle, dry rim tick',
  baseFrequency: 2600,
  loudness: 0.5,
  accents: {
    low: { gain: 0.72, pitch: 0.9 },
    mid: { gain: 1.0, pitch: 1.0 },
    high: { gain: 1.3, pitch: 1.12 },
  },
  build: (frequency, gain, isSub) => ({
    gain,
    duration: isSub ? 0.015 : 0.025,
    attack: 0.0008,
    source: { kind: 'noise' },
    filter: { type: 'bandpass', frequency, q: 6 },
  }),
}

/**
 * Beep: the classic metronome tone, but a triangle (not the old harsh square)
 * with a gentler attack.
 */
const BEEP: ClickVoiceDef = {
  id: 'beep',
  label: 'Beep',
  description: 'Classic beep — triangle, gentler than the old square',
  baseFrequency: 1200,
  loudness: 0.55,
  accents: {
    low: { gain: 0.68, pitch: 0.79 },
    mid: { gain: 1.0, pitch: 1.0 },
    high: { gain: 1.4, pitch: 1.33 },
  },
  build: (frequency, gain, isSub) => ({
    gain,
    duration: isSub ? 0.03 : 0.05,
    attack: 0.004,
    source: { kind: 'osc', type: 'triangle', frequency },
  }),
}

/** All selectable voices, in picker order. */
export const CLICK_VOICES: readonly ClickVoiceDef[] = [WOODBLOCK, BLIP, TICK, BEEP]

const VOICES_BY_ID: Record<ClickVoiceId, ClickVoiceDef> = {
  woodblock: WOODBLOCK,
  blip: BLIP,
  tick: TICK,
  beep: BEEP,
}

/** Whether a string names a known voice. */
export function isClickVoiceId(value: unknown): value is ClickVoiceId {
  return typeof value === 'string' && value in VOICES_BY_ID
}

/** Look up a voice definition, falling back to the default voice for unknown ids. */
export function getClickVoice(id: ClickVoiceId): ClickVoiceDef {
  return CLICK_VOICES.find((voice) => voice.id === id) ?? WOODBLOCK
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Resolve the synthesis spec for a click of the given voice at the given accent
 * level. Returns `null` for `off` (no click). Subdivision clicks are scaled
 * down in gain automatically so the main pulse stays on top.
 */
export function resolveClickParams(
  voiceId: ClickVoiceId,
  level: AccentLevel,
  isSubdivision: boolean,
): ClickSpec | null {
  if (level === 'off') return null
  const voice = getClickVoice(voiceId)
  const accent = voice.accents[level]
  const frequency = voice.baseFrequency * accent.pitch
  const rawGain = voice.loudness * accent.gain * (isSubdivision ? SUBDIVISION_GAIN_SCALE : 1)
  return voice.build(frequency, clampUnit(rawGain), isSubdivision)
}
