/**
 * Persisted Play-Along preferences (selected groove, tempo, count-in toggle,
 * per-voice mutes and master volume), shared across visits via the `Store`
 * wrapper in `src/lib/storage.ts`. Mirrors `metronomeSettings.ts`: pure helpers
 * (`clampPlayAlongTempo`, `grooveVoices`, `normalizePlayAlongSettings`) plus a
 * ready-made localStorage-backed store, all unit-testable under the `node` env
 * without rendering React or touching Web Audio.
 */

import {
  DEFAULT_ACCOMPANIMENT_SETTINGS,
  normalizeAccompanimentSettings,
  type AccompanimentSettings,
} from './accompaniment.ts'
import {
  DEFAULT_GROOVE,
  DEFAULT_MASTER_VOLUME,
  DRUM_VOICES,
  getGroove,
  isDrumVoice,
  isGrooveId,
  type DrumVoice,
  type Groove,
} from './audio/index.ts'
import { Store, type StorageBackend } from './storage.ts'
import {
  DEFAULT_TEMPO_TRAINER,
  normalizeTempoTrainerConfig,
  type TempoTrainerConfig,
} from './tempoTrainer.ts'

export interface PlayAlongSettings {
  /** Id of the selected groove (see `GROOVES`). */
  grooveId: string
  /** Tempo in beats per minute. */
  bpm: number
  /** Whether a one-bar count-in precedes playback. */
  countIn: boolean
  /** Master output volume, 0..1. */
  masterVolume: number
  /** Drum-bus mix level, 0..1 — the drums' level under the master volume. */
  drumVolume: number
  /** Accompaniment (comp) mix level, 0..1 — sits under the drums by default. */
  accompanimentVolume: number
  /** Voices the user has muted, in `DRUM_VOICES` order (deduped, validated). */
  mutedVoices: DrumVoice[]
  /** Chord-progression accompaniment (comping voice) settings. */
  accompaniment: AccompanimentSettings
  /** Show the current chord's tones on a fretboard (for building bass lines). */
  showChordTones: boolean
  /** Tempo trainer: auto-increase the BPM every N bars up to a target. */
  tempoTrainer: TempoTrainerConfig
}

/** Tempo range offered by the Play-Along slider/steppers. */
export const MIN_PLAY_ALONG_TEMPO = 40
export const MAX_PLAY_ALONG_TEMPO = 220
/** Tempo a fresh Play-Along page loads at. */
export const DEFAULT_PLAY_ALONG_TEMPO = 100

/** Human-readable labels for the mute chips (a groove only exposes voices it uses). */
export const VOICE_LABELS: Record<DrumVoice, string> = {
  kick: 'Kick',
  snare: 'Snare',
  'hat-closed': 'Hats',
  'hat-open': 'Open Hat',
  ride: 'Ride',
}

/** Clamp a tempo into `[MIN, MAX]`, rounding; NaN falls back to the default. */
export function clampPlayAlongTempo(bpm: number): number {
  if (Number.isNaN(bpm)) return DEFAULT_PLAY_ALONG_TEMPO
  return Math.min(MAX_PLAY_ALONG_TEMPO, Math.max(MIN_PLAY_ALONG_TEMPO, Math.round(bpm)))
}

/** Clamp a volume into 0..1; NaN falls back to the engine default. */
function clampVolume(volume: number): number {
  if (Number.isNaN(volume)) return DEFAULT_MASTER_VOLUME
  return Math.min(1, Math.max(0, volume))
}

/** Default mix level for the drum bus (the backbone — full level). */
export const DEFAULT_DRUM_VOLUME = 1
/** Default mix level for the accompaniment (sits under the drums). */
export const DEFAULT_ACCOMPANIMENT_VOLUME = 0.7

/** Clamp a mix scalar into 0..1; NaN falls back to `fallback`. */
function clampMixVolume(volume: number, fallback: number): number {
  if (Number.isNaN(volume)) return fallback
  return Math.min(1, Math.max(0, volume))
}

/**
 * The drum voices a groove actually plays, in `DRUM_VOICES` order — the set the
 * mute row renders a chip for. Derived from the groove's (partial) track map so
 * an all-rest lane never appears and switching grooves changes the chip set.
 */
export function grooveVoices(groove: Groove): DrumVoice[] {
  return DRUM_VOICES.filter((voice) => groove.tracks[voice] !== undefined)
}

/** Deduplicate + validate a persisted mute list, keeping `DRUM_VOICES` order. */
function normalizeMutedVoices(value: unknown): DrumVoice[] {
  if (!Array.isArray(value)) return []
  const wanted = new Set<DrumVoice>()
  for (const entry of value) if (isDrumVoice(entry)) wanted.add(entry)
  return DRUM_VOICES.filter((voice) => wanted.has(voice))
}

export const DEFAULT_PLAY_ALONG_SETTINGS: PlayAlongSettings = {
  grooveId: DEFAULT_GROOVE.id,
  bpm: DEFAULT_PLAY_ALONG_TEMPO,
  countIn: true,
  masterVolume: DEFAULT_MASTER_VOLUME,
  drumVolume: DEFAULT_DRUM_VOLUME,
  accompanimentVolume: DEFAULT_ACCOMPANIMENT_VOLUME,
  mutedVoices: [],
  accompaniment: DEFAULT_ACCOMPANIMENT_SETTINGS,
  showChordTones: true,
  tempoTrainer: DEFAULT_TEMPO_TRAINER,
}

/**
 * Coerce arbitrary (persisted, hand-edited, or typed) data into a valid
 * `PlayAlongSettings`, falling back per-field to the defaults for anything
 * missing or out of range. Muted voices are validated against the known drum
 * voices, but are intentionally NOT filtered to the selected groove — a voice
 * muted in one groove stays muted when the user returns to a groove that uses
 * it.
 */
export function normalizePlayAlongSettings(value: unknown): PlayAlongSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof PlayAlongSettings, unknown>
  >
  return {
    grooveId: isGrooveId(v.grooveId) ? v.grooveId : DEFAULT_PLAY_ALONG_SETTINGS.grooveId,
    bpm: typeof v.bpm === 'number' ? clampPlayAlongTempo(v.bpm) : DEFAULT_PLAY_ALONG_SETTINGS.bpm,
    countIn: typeof v.countIn === 'boolean' ? v.countIn : DEFAULT_PLAY_ALONG_SETTINGS.countIn,
    masterVolume:
      typeof v.masterVolume === 'number'
        ? clampVolume(v.masterVolume)
        : DEFAULT_PLAY_ALONG_SETTINGS.masterVolume,
    drumVolume:
      typeof v.drumVolume === 'number'
        ? clampMixVolume(v.drumVolume, DEFAULT_DRUM_VOLUME)
        : DEFAULT_PLAY_ALONG_SETTINGS.drumVolume,
    accompanimentVolume:
      typeof v.accompanimentVolume === 'number'
        ? clampMixVolume(v.accompanimentVolume, DEFAULT_ACCOMPANIMENT_VOLUME)
        : DEFAULT_PLAY_ALONG_SETTINGS.accompanimentVolume,
    mutedVoices: normalizeMutedVoices(v.mutedVoices),
    accompaniment: normalizeAccompanimentSettings(v.accompaniment),
    showChordTones:
      typeof v.showChordTones === 'boolean'
        ? v.showChordTones
        : DEFAULT_PLAY_ALONG_SETTINGS.showChordTones,
    tempoTrainer: normalizeTempoTrainerConfig(v.tempoTrainer),
  }
}

/** Re-export the groove lookup so the page imports settings + lookup together. */
export { getGroove }

/** Build a Play-Along settings store (tests pass `memoryBackend()`). */
export function createPlayAlongSettingsStore(backend?: StorageBackend): Store<PlayAlongSettings> {
  return new Store<PlayAlongSettings>(
    {
      key: 'settings:play-along',
      // v2 added the chord-progression accompaniment block; v3 added the
      // `showChordTones` fretboard-panel toggle; v4 added the `tempoTrainer`
      // auto-increase config; v5 added the `drumVolume` / `accompanimentVolume`
      // mix levels.
      version: 5,
      defaultValue: DEFAULT_PLAY_ALONG_SETTINGS,
      // Older data lacks the newer fields; normalizing fills them (and every
      // other field) from the defaults, so a v1/v2/v3/v4 -> v5 upgrade never
      // loses existing drum or accompaniment prefs.
      migrate: (oldData) => normalizePlayAlongSettings(oldData),
    },
    backend,
  )
}

/** The app-wide Play-Along settings store (localStorage-backed). */
export const playAlongSettingsStore = createPlayAlongSettingsStore()
