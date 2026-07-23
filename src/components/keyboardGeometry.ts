/**
 * Pure, framework-free geometry and labelling helpers for the `Keyboard`
 * SVG component. Nothing here touches `window`/`document`, so it is fully
 * unit-testable in the node test environment.
 *
 * Orientation: a horizontal piano keyboard drawn left → right from low to
 * high pitch. White keys have equal width and sit side by side; black keys
 * are narrower and shorter and are painted on top, centred on the boundary
 * between the two white keys they fall between. There is no black key on the
 * E–F or B–C boundary, which falls out naturally from the pitch classes.
 */

import { midiToPc, midiToOctave, pcToName } from '../lib/theory/notes.ts'

/** Pitch classes drawn as white keys (C D E F G A B). */
export const WHITE_PITCH_CLASSES: readonly number[] = [0, 2, 4, 5, 7, 9, 11]
/** Pitch classes drawn as black keys (C# D# F# G# A#). */
export const BLACK_PITCH_CLASSES: readonly number[] = [1, 3, 6, 8, 10]

/** True when the midi pitch is a black (accidental) key. */
export function isBlackKey(midi: number): boolean {
  return BLACK_PITCH_CLASSES.includes(midiToPc(midi))
}

/** True when the midi pitch is a white (natural) key. */
export function isWhiteKey(midi: number): boolean {
  return !isBlackKey(midi)
}

/**
 * Number of white keys in the half-open midi range `[from, midi)`.
 *
 * For a white key this is its 0-based column index counting from `from`
 * (the key at `from` has index 0). For a black key it equals the column
 * index of the white key immediately to its right, i.e. the boundary the
 * black key is centred on.
 */
export function whiteKeyIndex(from: number, midi: number): number {
  let count = 0
  for (let m = from; m < midi; m++) {
    if (isWhiteKey(m)) count++
  }
  return count
}

/** All white-key midi numbers in the inclusive range `[from, to]`, ascending. */
export function whiteKeyMidis(from: number, to: number): number[] {
  const midis: number[] = []
  for (let m = from; m <= to; m++) {
    if (isWhiteKey(m)) midis.push(m)
  }
  return midis
}

/** All black-key midi numbers in the inclusive range `[from, to]`, ascending. */
export function blackKeyMidis(from: number, to: number): number[] {
  const midis: number[] = []
  for (let m = from; m <= to; m++) {
    if (isBlackKey(m)) midis.push(m)
  }
  return midis
}

/**
 * Snap a midi range so it starts and ends on a white key: the low end is
 * lowered until it lands on a white key and the high end is raised until it
 * lands on a white key. The endpoints are ordered so `from <= to`.
 */
export function snapRangeToWhite(from: number, to: number): { from: number; to: number } {
  let lo = Math.min(from, to)
  let hi = Math.max(from, to)
  while (isBlackKey(lo)) lo--
  while (isBlackKey(hi)) hi++
  return { from: lo, to: hi }
}

/**
 * Convert an octave range (scientific pitch notation, C4 = midi 60) into a
 * midi range spanning C of the lowest octave through B of the highest — both
 * naturally white keys. Octaves may be given in either order.
 */
export function octaveRangeToMidi(
  fromOctave: number,
  toOctave: number,
): { from: number; to: number } {
  const lo = Math.min(fromOctave, toOctave)
  const hi = Math.max(fromOctave, toOctave)
  return { from: (lo + 1) * 12, to: (hi + 1) * 12 + 11 }
}

/**
 * Default label for a key: its pitch-class name, optionally suffixed with the
 * octave (e.g. `C4`) for orientation. Spelled with sharps or flats as asked.
 */
export function defaultKeyLabel(
  midi: number,
  prefer: 'sharp' | 'flat' = 'sharp',
  withOctave = false,
): string {
  const name = pcToName(midiToPc(midi), prefer)
  return withOctave ? `${name}${midiToOctave(midi)}` : name
}

/** Tunable pixel metrics for the SVG layout. */
export interface KeyboardLayoutConfig {
  /** Width of a white key. */
  whiteWidth: number
  /** Height of a white key. */
  whiteHeight: number
  /** Black-key width as a fraction of a white key. */
  blackWidthRatio: number
  /** Black-key height as a fraction of a white key. */
  blackHeightRatio: number
  /** Uniform margin around the keybed. */
  margin: number
  /**
   * Height reserved below the keys for static name labels (e.g. `C4`), so they
   * sit in their own strip where marker dots — which live on the keys — never
   * cover them. Only reserved when labels are shown.
   */
  labelStrip: number
}

export const DEFAULT_LAYOUT: KeyboardLayoutConfig = {
  whiteWidth: 36,
  whiteHeight: 150,
  blackWidthRatio: 0.6,
  blackHeightRatio: 0.62,
  margin: 8,
  labelStrip: 18,
}
/** Font size (px) of the static key-name labels in the reserved strip. */
export const KEY_LABEL_FONT_SIZE = 11
/** Descender room left below the label baseline within the strip. */
const KEY_LABEL_DESCENT = 4

/** Fully-resolved layout: snapped range plus derived pixel coordinates. */
export interface KeyboardLayout {
  config: KeyboardLayoutConfig
  /** Snapped low midi (a white key). */
  from: number
  /** Snapped high midi (a white key). */
  to: number
  whiteCount: number
  whiteWidth: number
  whiteHeight: number
  blackWidth: number
  blackHeight: number
  boardLeft: number
  boardTop: number
  /** Reserved label-strip height below the keys, 0 when labels are hidden. */
  labelStrip: number
  /** Baseline y of the static key-name labels, inside the reserved strip. */
  labelBaselineY: number
  width: number
  height: number
}

/**
 * Compute the SVG layout for a midi range and config. The range is snapped to
 * white keys first. When `reserveLabelStrip` is set, extra height is reserved
 * below the keys for static name labels so they never sit under marker dots.
 * Pure: same inputs always produce the same coordinates.
 */
export function computeLayout(
  from: number,
  to: number,
  config: KeyboardLayoutConfig = DEFAULT_LAYOUT,
  reserveLabelStrip = false,
): KeyboardLayout {
  const snapped = snapRangeToWhite(from, to)
  const whiteCount = whiteKeyMidis(snapped.from, snapped.to).length
  const blackWidth = config.whiteWidth * config.blackWidthRatio
  const blackHeight = config.whiteHeight * config.blackHeightRatio
  const boardLeft = config.margin
  const boardTop = config.margin
  const labelStrip = reserveLabelStrip ? config.labelStrip : 0
  const keysBottom = boardTop + config.whiteHeight
  const labelBaselineY = keysBottom + labelStrip - KEY_LABEL_DESCENT
  const width = boardLeft + whiteCount * config.whiteWidth + config.margin
  const height = keysBottom + labelStrip + config.margin

  return {
    config,
    from: snapped.from,
    to: snapped.to,
    whiteCount,
    whiteWidth: config.whiteWidth,
    whiteHeight: config.whiteHeight,
    blackWidth,
    blackHeight,
    boardLeft,
    boardTop,
    labelStrip,
    labelBaselineY,
    width,
    height,
  }
}

/** X of the left edge of a white key. */
export function whiteKeyX(layout: KeyboardLayout, midi: number): number {
  return layout.boardLeft + whiteKeyIndex(layout.from, midi) * layout.whiteWidth
}

/** X of the left edge of a black key (centred on the white-key boundary). */
export function blackKeyX(layout: KeyboardLayout, midi: number): number {
  const boundary = layout.boardLeft + whiteKeyIndex(layout.from, midi) * layout.whiteWidth
  return boundary - layout.blackWidth / 2
}

/** X of the horizontal centre of any key (white or black). */
export function keyCenterX(layout: KeyboardLayout, midi: number): number {
  return isBlackKey(midi)
    ? blackKeyX(layout, midi) + layout.blackWidth / 2
    : whiteKeyX(layout, midi) + layout.whiteWidth / 2
}

/** Height in px of the key at `midi` (black keys are shorter). */
export function keyHeight(layout: KeyboardLayout, midi: number): number {
  return isBlackKey(midi) ? layout.blackHeight : layout.whiteHeight
}
