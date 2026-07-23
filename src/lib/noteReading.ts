/**
 * Pure logic and persistence for the Note Reading tool: per-clef pitch ranges,
 * drawing a random target note, checking answers from each of the three input
 * modes, and a versioned settings store (mirrors `settings.ts` /
 * `metronomeSettings.ts`). Kept free of React and the DOM so it is unit-tested
 * in the node environment; the page component stays thin.
 *
 * A shared quiz lib (`src/lib/quiz.ts`) does not exist in this worktree, so the
 * session bookkeeping the page needs (streak/score) is trivial and kept in the
 * component; only the reusable, testable pieces live here.
 */

import { Store, type StorageBackend } from './storage.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { midiToPc } from './theory/notes.ts'
import type { Clef } from '../components/staffGeometry.ts'

export type InputMode = 'name' | 'fretboard' | 'keyboard'

export const CLEF_OPTIONS = ['bass', 'treble'] as const
export const INPUT_MODE_OPTIONS: readonly InputMode[] = ['name', 'fretboard', 'keyboard']

/**
 * Default (inclusive) midi range drawn on each clef. Chosen to stay within the
 * staff plus about two ledger lines so notes are readable without a magnifying
 * glass — bass C2…C4 (2 ledger below to 1 above), treble A3…C6 (2 ledger each
 * side). A wider, configurable range is the follow-up roadmap item.
 */
export const CLEF_RANGE: Record<Clef, { low: number; high: number }> = {
  // C2 … C4
  bass: { low: 36, high: 60 },
  // A3 … C6
  treble: { low: 57, high: 84 },
}

/**
 * Pick a random midi pitch within a clef's range. `rng` defaults to
 * `Math.random`; tests inject a deterministic generator. `avoid` re-rolls so
 * the same note is not drawn twice in a row (best-effort, bounded).
 */
export function randomNote(
  clef: Clef,
  rng: () => number = Math.random,
  avoid?: number,
): number {
  const { low, high } = CLEF_RANGE[clef]
  const span = high - low + 1
  let pick = low + Math.floor(rng() * span)
  if (pick > high) pick = high
  for (let tries = 0; pick === avoid && tries < 8; tries++) {
    pick = low + Math.floor(rng() * span)
    if (pick > high) pick = high
  }
  return pick
}

/** True when clicking a name (by pitch class) matches the target's pitch class. */
export function checkNameAnswer(chosenPc: number, targetMidi: number): boolean {
  return midiToPc(chosenPc) === midiToPc(targetMidi)
}

/** True when a clicked keyboard key is the exact target pitch. */
export function checkKeyboardAnswer(clickedMidi: number, targetMidi: number): boolean {
  return clickedMidi === targetMidi
}

/**
 * Whether the exact target pitch can be played anywhere on the board within the
 * given fret range for the tuning.
 */
export function pitchOnBoard(
  tuning: Tuning,
  targetMidi: number,
  fromFret: number,
  toFret: number,
): boolean {
  for (let s = 0; s < tuning.strings.length; s++) {
    for (let f = fromFret; f <= toFret; f++) {
      if (fretMidi(tuning, s, f) === targetMidi) return true
    }
  }
  return false
}

/**
 * Grade a fretboard click for staff reading.
 *
 * Design choice: prefer an *exact-pitch* match, but only require it when the
 * target's exact octave is actually reachable on the board. When the drawn
 * note lies outside the board's range (common for high treble notes on a
 * 4-string bass, or notes below the lowest string), demanding the exact octave
 * would be impossible/punishing, so any position of the correct pitch class is
 * accepted. This keeps the drill fair across every tuning without dumbing it
 * down where the exact note is genuinely playable.
 */
export function checkFretboardAnswer(
  tuning: Tuning,
  clickedMidi: number,
  targetMidi: number,
  fromFret: number,
  toFret: number,
): boolean {
  if (clickedMidi === targetMidi) return true
  if (pitchOnBoard(tuning, targetMidi, fromFret, toFret)) return false
  return midiToPc(clickedMidi) === midiToPc(targetMidi)
}

export interface NoteReadingSettings {
  clef: Clef
  inputMode: InputMode
}

/** Bass clef first: the primary user is a bassist. */
export const DEFAULT_NOTE_READING_SETTINGS: NoteReadingSettings = {
  clef: 'bass',
  inputMode: 'name',
}

function isClef(value: unknown): value is Clef {
  return value === 'bass' || value === 'treble'
}

function isInputMode(value: unknown): value is InputMode {
  return value === 'name' || value === 'fretboard' || value === 'keyboard'
}

/** Coerce arbitrary persisted/typed data into valid settings, per field. */
export function normalizeNoteReadingSettings(value: unknown): NoteReadingSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof NoteReadingSettings, unknown>
  >
  return {
    clef: isClef(v.clef) ? v.clef : DEFAULT_NOTE_READING_SETTINGS.clef,
    inputMode: isInputMode(v.inputMode) ? v.inputMode : DEFAULT_NOTE_READING_SETTINGS.inputMode,
  }
}

/** Build a settings store (tests pass `memoryBackend()`). */
export function createNoteReadingSettingsStore(
  backend?: StorageBackend,
): Store<NoteReadingSettings> {
  return new Store<NoteReadingSettings>(
    {
      key: 'settings:note-reading',
      version: 1,
      defaultValue: DEFAULT_NOTE_READING_SETTINGS,
    },
    backend,
  )
}

/** The app-wide note-reading settings store (localStorage-backed). */
export const noteReadingSettingsStore = createNoteReadingSettingsStore()
