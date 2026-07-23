/**
 * Pure, framework-free geometry and labelling helpers for the `Fretboard`
 * SVG component. Nothing here touches `window`/`document`, so it is fully
 * unit-testable in the node test environment.
 *
 * Orientation: a horizontal fretboard. The x axis runs along the strings
 * (low frets on the left, high frets on the right); the y axis selects the
 * string, with the lowest-pitched string (index 0) drawn at the bottom in
 * standard tab orientation.
 */

import { midiToPc, pcToName } from '../lib/theory/notes.ts'

/** Frets carrying a single inlay dot on a standard guitar/bass neck. */
export const SINGLE_INLAY_FRETS = [3, 5, 7, 9, 15, 17, 19, 21] as const
/** Frets carrying a double inlay dot (the octave markers). */
export const DOUBLE_INLAY_FRETS = [12, 24] as const

/** A fret-marker inlay dot that falls within a rendered fret range. */
export interface InlayDot {
  fret: number
  /** Whether this is a double (octave) inlay rather than a single dot. */
  double: boolean
}

/**
 * Inlay dots whose fret cells are visible for the given range.
 *
 * A dot at fret `f` is shown when its cell is drawn, i.e. when
 * `max(1, fromFret) <= f <= toFret` (fret 0 is the open/nut position and
 * never carries an inlay).
 */
export function inlayDots(fromFret: number, toFret: number): InlayDot[] {
  const first = Math.max(1, fromFret)
  const dots: InlayDot[] = []
  for (const fret of SINGLE_INLAY_FRETS) {
    if (fret >= first && fret <= toFret) dots.push({ fret, double: false })
  }
  for (const fret of DOUBLE_INLAY_FRETS) {
    if (fret >= first && fret <= toFret) dots.push({ fret, double: true })
  }
  return dots.sort((a, b) => a.fret - b.fret)
}

/**
 * Default label for a marker: the pitch-class name of its midi pitch
 * (no octave), spelled with sharps or flats as requested.
 */
export function defaultMarkerLabel(midi: number, prefer: 'sharp' | 'flat' = 'sharp'): string {
  return pcToName(midiToPc(midi), prefer)
}

/** Marker dot radius as a fraction of the smaller cell dimension. */
export const MARKER_RADIUS_RATIO = 0.4
/** Fret-inlay dot radius as a fraction of the smaller cell dimension. */
export const INLAY_RADIUS_RATIO = 0.16
/** Font size (px) of the fret-number labels; the reserved gutter sizes to it. */
export const FRET_NUMBER_FONT_SIZE = 11
/** Clear space between the lowest-string marker's edge and the number's top. */
const FRET_NUMBER_TOP_GAP = 5
/** Room left below the number baseline for its descenders. */
const FRET_NUMBER_DESCENT = 4

/**
 * Radius of a marker dot in px. A marker sits on a string row, so on the lowest
 * (bottom) string it reaches `boardBottom + markerRadius` — the value the
 * fret-number gutter must clear so numbers never sit under a dot.
 */
export function markerRadius(config: FretboardLayoutConfig): number {
  return Math.min(config.stringSpacing, config.fretWidth) * MARKER_RADIUS_RATIO
}

/** Radius of a fret-inlay dot in px (smaller than a marker). */
export function inlayRadius(config: FretboardLayoutConfig): number {
  return Math.min(config.stringSpacing, config.fretWidth) * INLAY_RADIUS_RATIO
}

/**
 * String stroke width in px. Lower strings (smaller index) are drawn thicker,
 * as on a real instrument. With a single string the max width is used.
 */
export function stringStrokeWidth(
  stringIndex: number,
  stringCount: number,
  min = 1,
  max = 2.6,
): number {
  if (stringCount <= 1) return max
  const t = stringIndex / (stringCount - 1)
  return max - (max - min) * t
}

/** Tunable pixel metrics for the SVG layout. */
export interface FretboardLayoutConfig {
  /** Width of a single fret cell. */
  fretWidth: number
  /** Vertical gap between adjacent strings. */
  stringSpacing: number
  marginTop: number
  marginBottom: number
  marginRight: number
  /** Left area reserved for the nut and open-string markers. */
  nutArea: number
  /** Extra bottom space reserved for fret-number labels. */
  labelGutter: number
}

export const DEFAULT_LAYOUT: FretboardLayoutConfig = {
  fretWidth: 54,
  stringSpacing: 30,
  marginTop: 22,
  marginBottom: 14,
  marginRight: 16,
  nutArea: 40,
  labelGutter: 22,
}

/** Fully-resolved layout: input range plus derived pixel coordinates. */
export interface FretboardLayout {
  config: FretboardLayoutConfig
  fromFret: number
  toFret: number
  stringCount: number
  /** True when the nut (open strings) is shown, i.e. `fromFret === 0`. */
  open: boolean
  /** First fretted fret drawn (1 when open, else `fromFret`). */
  firstFret: number
  /** Number of fret cells drawn. */
  cells: number
  boardLeft: number
  boardRight: number
  boardTop: number
  boardBottom: number
  /**
   * Reserved space (px) below the board for fret numbers, 0 when they are
   * hidden. Sized so a bottom-string marker can never reach the numbers.
   */
  labelGutter: number
  /** Baseline y of the fret-number row, inside the reserved gutter. */
  fretNumberY: number
  width: number
  height: number
}

/**
 * Compute the SVG layout for a fret range and string count. Pure: given the
 * same inputs it always returns the same coordinates.
 */
export function computeLayout(
  fromFret: number,
  toFret: number,
  stringCount: number,
  showFretNumbers: boolean,
  config: FretboardLayoutConfig = DEFAULT_LAYOUT,
): FretboardLayout {
  const open = fromFret <= 0
  const firstFret = open ? 1 : fromFret
  const lastFret = Math.max(firstFret, toFret)
  const cells = lastFret - firstFret + 1
  const strings = Math.max(1, stringCount)

  const boardLeft = config.nutArea
  const boardRight = boardLeft + cells * config.fretWidth
  const boardTop = config.marginTop
  const boardBottom = boardTop + (strings - 1) * config.stringSpacing

  // Reserve a gutter tall enough that the number row clears the reach of a
  // marker sitting on the bottom string (`boardBottom + markerRadius`). The
  // configured `labelGutter` is a floor, so custom layouts stay at least as
  // roomy as before.
  const dotR = markerRadius(config)
  const requiredGutter = dotR + FRET_NUMBER_TOP_GAP + FRET_NUMBER_FONT_SIZE + FRET_NUMBER_DESCENT
  const labelGutter = showFretNumbers ? Math.max(config.labelGutter, requiredGutter) : 0
  const fretNumberY = boardBottom + dotR + FRET_NUMBER_TOP_GAP + FRET_NUMBER_FONT_SIZE

  const width = boardRight + config.marginRight
  const height = boardBottom + config.marginBottom + labelGutter

  return {
    config,
    fromFret,
    toFret: lastFret,
    stringCount: strings,
    open,
    firstFret,
    cells,
    boardLeft,
    boardRight,
    boardTop,
    boardBottom,
    labelGutter,
    fretNumberY,
    width,
    height,
  }
}

/**
 * X of the fret wire at fret number `fret`. The leftmost wire is the nut (when
 * open) or the wire just before `fromFret`, at `firstFret - 1`.
 */
export function wireX(layout: FretboardLayout, fret: number): number {
  return layout.boardLeft + (fret - (layout.firstFret - 1)) * layout.config.fretWidth
}

/**
 * X of the centre of the note position at `fret`. Open notes (fret 0, only
 * when the nut is shown) sit in the reserved nut area to the left of the board.
 */
export function noteX(layout: FretboardLayout, fret: number): number {
  if (fret === 0 && layout.open) {
    return layout.boardLeft - layout.config.nutArea / 2
  }
  return layout.boardLeft + (fret - layout.firstFret + 0.5) * layout.config.fretWidth
}

/**
 * Y of a string. String index 0 is the lowest pitch and is drawn at the
 * bottom; the highest index is drawn at the top.
 */
export function stringY(layout: FretboardLayout, stringIndex: number): number {
  return layout.boardTop + (layout.stringCount - 1 - stringIndex) * layout.config.stringSpacing
}

/**
 * Mirror an x coordinate about the board's vertical centre for a left-handed
 * layout: the nut moves to the right and ascending frets run leftwards.
 * Reflecting across `width` (rather than `boardRight`) keeps the reserved nut
 * area and right margin symmetric, so open-string markers and the right edge
 * stay on-canvas. The y axis (string order) is unchanged.
 */
export function mirrorX(layout: FretboardLayout, x: number): number {
  return layout.width - x
}

/**
 * Y of the centre single inlay dot. It sits on the neck's mid-line, but on an
 * odd string count that line coincides with the centre string row — where a
 * marker would sit and hide the inlay — so it is nudged half a string-spacing
 * into the adjacent gap. On an even string count the mid-line already falls in
 * a gap and is returned unchanged. Keeping inlays off string rows lets them
 * read even when markers occupy the same fret.
 */
export function inlayCenterY(layout: FretboardLayout): number {
  const midY = (layout.boardTop + layout.boardBottom) / 2
  const onStringRow = layout.stringCount % 2 === 1
  return onStringRow ? midY + layout.config.stringSpacing / 2 : midY
}

/**
 * Vertical offset of each dot of a double (octave) inlay from `inlayCenterY`.
 * A full string-spacing keeps both dots in string gaps (parallel to the centre
 * gap) regardless of string parity, so they clear the string rows markers use.
 */
export function inlayDoubleOffset(layout: FretboardLayout): number {
  return layout.config.stringSpacing
}
