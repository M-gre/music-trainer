/**
 * Pure logic for the Chord Explorer tool: chord tones with labeled intervals,
 * chord-quality grouping, a concrete keyboard voicing per inversion, and
 * fretboard/keyboard marker placement. Framework-free and fully unit-tested;
 * the React page (`src/pages/ChordExplorer.tsx`) is a thin shell over this
 * plus the shared audio engine and `Fretboard`/`Keyboard` components.
 */

import { intervalName } from './theory/intervals.ts'
import { mod12, pcToName, type Midi, type PitchClass } from './theory/notes.ts'
import { CHORD_QUALITIES, type ChordQuality } from './theory/chords.ts'
import { fretMidi, type Tuning } from './theory/instruments.ts'
import { Store, type StorageBackend } from './storage.ts'

// --- Interval labeling -------------------------------------------------------

/**
 * Interval label for any non-negative semitone count, including compound
 * intervals beyond an octave (e.g. 14 semitones -> "M9", matching `add9`'s
 * ninth). Built on top of `intervalName` (which only covers 0–12 semitones)
 * by naming the simple interval within the octave and bumping its scale-step
 * number by 7 per extra octave (2nd -> 9th, 3rd -> 10th, etc.), matching
 * conventional compound-interval naming.
 */
export function intervalLabel(semitones: number): string {
  if (semitones < 0) throw new Error(`intervalLabel: negative interval ${semitones}`)
  const octaves = Math.floor(semitones / 12)
  const simple = semitones - octaves * 12
  const base = intervalName(simple).short
  if (octaves === 0) return base
  const match = /^([A-Za-z]+)(\d+)$/.exec(base)
  if (!match) return base // e.g. a compound tritone; no chord quality here needs one
  const [, quality, numberStr] = match
  const number = Number(numberStr) + 7 * octaves
  return `${quality}${number}`
}

// --- Chord tones & symbol ----------------------------------------------------

export interface ChordTone {
  pc: PitchClass
  /** Semitones above the root, as defined by the quality (may exceed 12). */
  semitones: number
  /** `"R"` for the root; otherwise the (possibly compound) interval short name. */
  label: string
}

/** Pitch classes + labeled intervals of a chord, root first. */
export function chordTones(root: PitchClass, quality: ChordQuality): ChordTone[] {
  return quality.intervals.map((semitones) => ({
    pc: mod12(root + semitones),
    semitones,
    label: semitones === 0 ? 'R' : intervalLabel(semitones),
  }))
}

/** Chord symbol like `"Am7"`, `"C"`, `"F#dim7"`. */
export function chordSymbol(
  root: PitchClass,
  quality: ChordQuality,
  prefer: 'sharp' | 'flat' = 'sharp',
): string {
  return pcToName(root, prefer) + quality.symbol
}

/** Whether a chord-tone interval reads as "the 3rd" (minor or major). */
function isThird(semitones: number): boolean {
  const simple = semitones % 12
  return simple === 3 || simple === 4
}

// --- Quality grouping ---------------------------------------------------------

export type QualityGroup = 'triads' | 'sevenths' | 'other'

const TRIAD_IDS = new Set(['maj', 'min', 'dim', 'aug', 'sus2', 'sus4'])
const SEVENTH_IDS = new Set(['maj7', 'min7', 'dom7', 'min7b5', 'dim7'])

/** Which group a quality belongs to for the picker: triads, sevenths, or other (6ths/add9/etc). */
export function qualityGroup(quality: ChordQuality): QualityGroup {
  if (TRIAD_IDS.has(quality.id)) return 'triads'
  if (SEVENTH_IDS.has(quality.id)) return 'sevenths'
  return 'other'
}

export const QUALITY_GROUP_ORDER: readonly QualityGroup[] = ['triads', 'sevenths', 'other']

export const QUALITY_GROUP_LABELS: Record<QualityGroup, string> = {
  triads: 'Triads',
  sevenths: 'Sevenths',
  other: 'Other',
}

/** All chord qualities bucketed by group, preserving `CHORD_QUALITIES` order within each bucket. */
export function groupedQualities(
  qualities: readonly ChordQuality[] = CHORD_QUALITIES,
): Record<QualityGroup, ChordQuality[]> {
  const groups: Record<QualityGroup, ChordQuality[]> = { triads: [], sevenths: [], other: [] }
  for (const q of qualities) groups[qualityGroup(q)].push(q)
  return groups
}

// --- Keyboard voicing / inversions -------------------------------------------

/** C4 — the anchor octave concrete voicings are built around. */
export const VOICING_BASE_MIDI = 60

/** Number of selectable inversions for a quality: root position + one per extra tone. */
export function inversionCount(quality: ChordQuality): number {
  return quality.intervals.length
}

export interface VoicingNote {
  midi: Midi
  /** The chord-tone interval (from `quality.intervals`) this note represents. */
  semitones: number
}

/**
 * A concrete, playable voicing of one inversion of a chord, anchored around
 * `baseMidi` (default C4). Root position stacks the quality's intervals
 * directly above the root; inversion `k` moves the bottom `k` tones (by
 * scale order, root first) up an octave each, so the chord's `k`-th tone
 * lands in the bass — standard close-position inversions. `inversion` wraps
 * into `[0, tone count)`. Notes are returned sorted low to high.
 */
export function chordVoicing(
  root: PitchClass,
  quality: ChordQuality,
  inversion: number,
  baseMidi: Midi = VOICING_BASE_MIDI,
): VoicingNote[] {
  const n = quality.intervals.length
  const inv = ((inversion % n) + n) % n
  const notes = quality.intervals.map((semitones, i) => ({
    semitones,
    midi: baseMidi + root + semitones + (i < inv ? 12 : 0),
  }))
  return notes.sort((a, b) => a.midi - b.midi)
}

/** Just the midi notes of a voicing, low to high — convenient for playback. */
export function voicingMidis(
  root: PitchClass,
  quality: ChordQuality,
  inversion: number,
  baseMidi: Midi = VOICING_BASE_MIDI,
): Midi[] {
  return chordVoicing(root, quality, inversion, baseMidi).map((n) => n.midi)
}

// --- Marker variants (shared vocabulary with Fretboard/Keyboard) -------------

/** Highlight kind for a chord tone: matches a subset of `MarkerVariant`. */
export type ChordMarkerVariant = 'root' | 'accent' | 'default'

function markerVariant(semitones: number): ChordMarkerVariant {
  if (semitones === 0) return 'root'
  return isThird(semitones) ? 'accent' : 'default'
}

export type ChordLabelMode = 'interval' | 'note'

function toneLabel(labelMode: ChordLabelMode, pc: PitchClass, intervalText: string, prefer: 'sharp' | 'flat'): string {
  return labelMode === 'interval' ? intervalText : pcToName(pc, prefer)
}

// --- Fretboard markers --------------------------------------------------------

export interface ChordFretboardMarker {
  string: number
  fret: number
  variant: ChordMarkerVariant
  label: string
}

/**
 * Every chord-tone position across the whole neck (all strings, `fromFret`
 * to `toFret`): the root gets the `'root'` variant, 3rds get `'accent'`,
 * everything else `'default'`. Labels follow `labelMode`.
 */
export function buildChordFretboardMarkers(
  tuning: Tuning,
  root: PitchClass,
  quality: ChordQuality,
  fromFret: number,
  toFret: number,
  labelMode: ChordLabelMode,
  prefer: 'sharp' | 'flat' = 'sharp',
): ChordFretboardMarker[] {
  const toneByPc = new Map<PitchClass, ChordTone>()
  for (const tone of chordTones(root, quality)) {
    if (!toneByPc.has(tone.pc)) toneByPc.set(tone.pc, tone)
  }

  const markers: ChordFretboardMarker[] = []
  for (let s = 0; s < tuning.strings.length; s++) {
    for (let fret = fromFret; fret <= toFret; fret++) {
      const tone = toneByPc.get(mod12(fretMidi(tuning, s, fret)))
      if (!tone) continue
      markers.push({
        string: s,
        fret,
        variant: markerVariant(tone.semitones),
        label: toneLabel(labelMode, tone.pc, tone.label, prefer),
      })
    }
  }
  return markers
}

// --- Keyboard markers ---------------------------------------------------------

export interface ChordKeyboardMarker {
  midi: Midi
  variant: ChordMarkerVariant
  label: string
}

/** Keyboard markers for one voicing (see `chordVoicing`), labeled per `labelMode`. */
export function buildChordKeyboardMarkers(
  root: PitchClass,
  quality: ChordQuality,
  inversion: number,
  labelMode: ChordLabelMode,
  prefer: 'sharp' | 'flat' = 'sharp',
  baseMidi: Midi = VOICING_BASE_MIDI,
): ChordKeyboardMarker[] {
  return chordVoicing(root, quality, inversion, baseMidi).map((note) => {
    const intervalText = note.semitones === 0 ? 'R' : intervalLabel(note.semitones)
    return {
      midi: note.midi,
      variant: markerVariant(note.semitones),
      label: toneLabel(labelMode, mod12(note.midi), intervalText, prefer),
    }
  })
}

// --- Arpeggio sequencing -------------------------------------------------------

export interface ArpeggioStep {
  midi: Midi
  when: number
}

/**
 * Timed sequence for arpeggio playback: the voicing ascending, then
 * (when `descend`) back down without repeating the top note, each step
 * spaced by `stepSeconds`, all offsets relative to `startTime`.
 */
export function arpeggioSteps(
  midis: readonly Midi[],
  stepSeconds: number,
  startTime = 0,
  descend = true,
): ArpeggioStep[] {
  const ascending = [...midis].sort((a, b) => a - b)
  const descending = descend ? [...ascending].reverse().slice(1) : []
  const sequence = [...ascending, ...descending]
  return sequence.map((midi, i) => ({ midi, when: startTime + i * stepSeconds }))
}

// --- Persisted settings ---------------------------------------------------------

export interface ChordExplorerSettings {
  root: PitchClass
  qualityId: string
  inversion: number
}

export const DEFAULT_CHORD_EXPLORER_SETTINGS: ChordExplorerSettings = {
  root: 0,
  qualityId: 'maj',
  inversion: 0,
}

function resolveQualityId(qualityId: unknown): ChordQuality {
  const found =
    typeof qualityId === 'string' ? CHORD_QUALITIES.find((q) => q.id === qualityId) : undefined
  return found ?? CHORD_QUALITIES.find((q) => q.id === DEFAULT_CHORD_EXPLORER_SETTINGS.qualityId)!
}

/** Coerce arbitrary (persisted, hand-edited, or typed) data into valid settings. */
export function normalizeChordExplorerSettings(value: unknown): ChordExplorerSettings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof ChordExplorerSettings, unknown>
  >
  const root =
    typeof v.root === 'number' && Number.isFinite(v.root)
      ? mod12(Math.round(v.root))
      : DEFAULT_CHORD_EXPLORER_SETTINGS.root
  const quality = resolveQualityId(v.qualityId)
  const n = inversionCount(quality)
  const rawInversion =
    typeof v.inversion === 'number' && Number.isFinite(v.inversion) ? Math.round(v.inversion) : 0
  const inversion = ((rawInversion % n) + n) % n
  return { root, qualityId: quality.id, inversion }
}

/** Build a chord-explorer-settings store (tests pass `memoryBackend()`). */
export function createChordExplorerSettingsStore(
  backend?: StorageBackend,
): Store<ChordExplorerSettings> {
  return new Store<ChordExplorerSettings>(
    {
      key: 'settings:chord-explorer',
      version: 1,
      defaultValue: DEFAULT_CHORD_EXPLORER_SETTINGS,
    },
    backend,
  )
}

/** The app-wide chord-explorer settings store (localStorage-backed). */
export const chordExplorerSettingsStore = createChordExplorerSettingsStore()
