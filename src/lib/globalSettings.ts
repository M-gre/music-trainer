/**
 * Global, cross-tool preferences: fretboard orientation (left-handed flip),
 * accidental spelling (sharps vs flats vs the context-dependent default), and
 * master output volume. Persisted through the versioned `Store` wrapper in
 * `src/lib/storage.ts` so they survive reloads and every tool inherits them
 * with zero wiring.
 *
 * Mirrors the shape of the other `*Settings` libs: a factory (tests inject
 * `memoryBackend()`), a ready-made localStorage-backed store, and pure helpers
 * (`normalizeGlobalSettings`, `applySpellingPreference`, `clampVolume`) kept
 * framework-free so they are unit-tested without rendering React.
 *
 * The `Fretboard` (left-handed + spelling) and `Keyboard` (spelling) SVG
 * components read this store directly, and the `AudioEngine` seeds its master
 * volume from `readPersistedMasterVolume()` on construction, so the settings
 * apply globally without editing any tool page.
 */

import { Store, type StorageBackend } from './storage.ts'

/**
 * How default note-name labels are spelled:
 *  - `'auto'` keeps each tool's context-dependent choice (e.g. flats for
 *    flat-side keys) — today's behavior.
 *  - `'sharps'` / `'flats'` force that accidental everywhere a default label
 *    is drawn.
 */
export type SpellingPreference = 'auto' | 'sharps' | 'flats'

/** All spelling preferences, for building the settings UI. */
export const SPELLING_PREFERENCES: readonly SpellingPreference[] = ['auto', 'sharps', 'flats']

/**
 * Default master volume (0..1). Mirrors `AudioEngine`'s `DEFAULT_MASTER_VOLUME`
 * so a brand-new visitor hears the same level whether or not they have opened
 * the settings page yet.
 */
export const DEFAULT_MASTER_VOLUME = 0.8

export interface GlobalSettings {
  /** Mirror the fretboard horizontally (nut on the right) for left-handers. */
  leftHanded: boolean
  /** Accidental spelling preference for default note-name labels. */
  spellingPreference: SpellingPreference
  /** Master output volume, 0..1. */
  masterVolume: number
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  leftHanded: false,
  spellingPreference: 'auto',
  masterVolume: DEFAULT_MASTER_VOLUME,
}

/** Clamp a volume into `[0, 1]`; NaN falls back to the default volume. */
export function clampVolume(volume: number): number {
  if (Number.isNaN(volume)) return DEFAULT_MASTER_VOLUME
  return Math.min(1, Math.max(0, volume))
}

function isSpellingPreference(value: unknown): value is SpellingPreference {
  return value === 'auto' || value === 'sharps' || value === 'flats'
}

/**
 * Coerce arbitrary (persisted, hand-edited, or older-version) data into a valid
 * `GlobalSettings`, falling back per-field to the defaults for anything missing
 * or out of range.
 */
export function normalizeGlobalSettings(value: unknown): GlobalSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof GlobalSettings, unknown>
  >
  return {
    leftHanded:
      typeof v.leftHanded === 'boolean' ? v.leftHanded : DEFAULT_GLOBAL_SETTINGS.leftHanded,
    spellingPreference: isSpellingPreference(v.spellingPreference)
      ? v.spellingPreference
      : DEFAULT_GLOBAL_SETTINGS.spellingPreference,
    masterVolume:
      typeof v.masterVolume === 'number'
        ? clampVolume(v.masterVolume)
        : DEFAULT_GLOBAL_SETTINGS.masterVolume,
  }
}

/**
 * Migrate persisted data from an older schema version. There is only v1 so far;
 * `normalizeGlobalSettings` defensively fills any fields a future older shape
 * might lack, so a bump needs no bespoke migration logic here.
 */
export function migrateGlobalSettings(oldData: unknown): GlobalSettings {
  return normalizeGlobalSettings(oldData)
}

/**
 * Resolve the concrete accidental a spell/label function should receive.
 * `'auto'` passes the tool's context-dependent choice through unchanged
 * (preserving today's behavior); `'sharps'`/`'flats'` override it.
 */
export function applySpellingPreference(
  pref: SpellingPreference,
  contextPrefer: 'sharp' | 'flat',
): 'sharp' | 'flat' {
  switch (pref) {
    case 'sharps':
      return 'sharp'
    case 'flats':
      return 'flat'
    default:
      return contextPrefer
  }
}

/** Build a global-settings store (tests pass `memoryBackend()`). */
export function createGlobalSettingsStore(backend?: StorageBackend): Store<GlobalSettings> {
  return new Store<GlobalSettings>(
    {
      key: 'settings:global',
      version: 1,
      defaultValue: DEFAULT_GLOBAL_SETTINGS,
      migrate: migrateGlobalSettings,
    },
    backend,
  )
}

/** The app-wide global settings store (localStorage-backed). */
export const globalSettingsStore = createGlobalSettingsStore()

/**
 * The persisted master volume (falling back to the default). Called by the
 * `AudioEngine` constructor so playback starts at the user's chosen level.
 */
export function readPersistedMasterVolume(): number {
  return normalizeGlobalSettings(globalSettingsStore.get()).masterVolume
}
