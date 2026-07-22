/**
 * `Fretboard` — a pure, props-driven SVG view of a fretted instrument neck.
 *
 * It contains no tool-specific logic: callers pass a `Tuning`, a fret range,
 * and a set of highlight `markers`, and receive click callbacks with the
 * position and midi pitch. It works for any tuning (bass 4/5/6-string,
 * guitar 6/7-string, drop tunings, custom) — string count and pitches come
 * entirely from the `Tuning`, never hardcoded.
 *
 * The neck is horizontal with the lowest-pitched string at the bottom
 * (standard tab orientation). The SVG scales responsively to its container
 * width via a `viewBox`. All geometry lives in `fretboardGeometry.ts`.
 */

import { fretMidi, type Tuning } from '../lib/theory/instruments.ts'
import {
  computeLayout,
  defaultMarkerLabel,
  DEFAULT_LAYOUT,
  type FretboardLayoutConfig,
  inlayDots,
  noteX,
  stringStrokeWidth,
  stringY,
  wireX,
} from './fretboardGeometry.ts'

/** Visual kind of a marker, mapped to a CSS class. */
export type MarkerVariant = 'default' | 'root' | 'accent' | 'dim'

/** A highlighted note position on the board. */
export interface FretboardMarker {
  /** String index, 0 = lowest-pitched string. */
  string: number
  /** Fret number, 0 = open string. */
  fret: number
  /** Label drawn in the dot; defaults to the note's pitch-class name. */
  label?: string
  /** Highlight kind; defaults to `'default'`. */
  variant?: MarkerVariant
}

/** A concrete board position, passed to `onFretClick`. */
export interface FretPosition {
  string: number
  fret: number
  midi: number
}

export interface FretboardProps {
  /** The instrument tuning. Drives string count and open-string pitches. */
  tuning: Tuning
  /** Lowest fret shown (0 = include the nut / open strings). Default 0. */
  fromFret?: number
  /** Highest fret shown. Default 12. */
  toFret?: number
  /** Highlighted note positions. */
  markers?: FretboardMarker[]
  /** Called when any playable position (open or fretted) is clicked. */
  onFretClick?: (pos: FretPosition) => void
  /** Show fret-number labels beneath inlay positions. Default true. */
  showFretNumbers?: boolean
  /** Mirror the neck horizontally for left-handed players. Default false. */
  leftHanded?: boolean
  /** Accidental spelling for default marker labels. Default `'sharp'`. */
  prefer?: 'sharp' | 'flat'
  /** Pixel layout overrides (partial). */
  layoutConfig?: Partial<FretboardLayoutConfig>
  /** Extra class on the root `<svg>`. */
  className?: string
  /** Accessible label for the SVG. */
  ariaLabel?: string
}

export function Fretboard({
  tuning,
  fromFret = 0,
  toFret = 12,
  markers = [],
  onFretClick,
  showFretNumbers = true,
  leftHanded = false,
  prefer = 'sharp',
  layoutConfig,
  className,
  ariaLabel,
}: FretboardProps) {
  const stringCount = tuning.strings.length
  const config: FretboardLayoutConfig = { ...DEFAULT_LAYOUT, ...layoutConfig }
  const layout = computeLayout(fromFret, toFret, stringCount, showFretNumbers, config)

  // Mirror x for left-handed layouts while keeping labels upright.
  const mx = (x: number): number => (leftHanded ? layout.width - x : x)

  const stringIndexes = Array.from({ length: stringCount }, (_, i) => i)
  // Fret wires from the leftmost boundary (nut or firstFret-1) through toFret.
  const wireFrets = Array.from(
    { length: layout.cells + 1 },
    (_, i) => layout.firstFret - 1 + i,
  )
  // Fretted frets that carry a clickable/hittable cell.
  const cellFrets = Array.from({ length: layout.cells }, (_, i) => layout.firstFret + i)
  const clickableFrets = layout.open ? [0, ...cellFrets] : cellFrets

  const midY = (layout.boardTop + layout.boardBottom) / 2
  const inlayR = Math.min(config.stringSpacing, config.fretWidth) * 0.16
  const dotR = Math.min(config.stringSpacing, config.fretWidth) * 0.4

  return (
    <svg
      className={`fb-fretboard${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      role="img"
      aria-label={ariaLabel ?? `${tuning.name} fretboard`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Neck surface */}
      <rect
        className="fb-neck"
        x={Math.min(mx(layout.boardLeft), mx(layout.boardRight))}
        y={layout.boardTop}
        width={layout.boardRight - layout.boardLeft}
        height={layout.boardBottom - layout.boardTop}
      />

      {/* Fret-marker inlay dots */}
      {inlayDots(layout.fromFret, layout.toFret).map((dot) => {
        const cx = mx(noteX(layout, dot.fret))
        if (!dot.double) {
          return <circle key={`inlay-${dot.fret}`} className="fb-inlay" cx={cx} cy={midY} r={inlayR} />
        }
        const offset = config.stringSpacing * 0.9
        return (
          <g key={`inlay-${dot.fret}`}>
            <circle className="fb-inlay" cx={cx} cy={midY - offset} r={inlayR} />
            <circle className="fb-inlay" cx={cx} cy={midY + offset} r={inlayR} />
          </g>
        )
      })}

      {/* Fret wires (first is the nut, thicker when open) */}
      {wireFrets.map((fret, i) => {
        const x = mx(wireX(layout, fret))
        const isNut = i === 0 && layout.open
        return (
          <line
            key={`wire-${fret}`}
            className={isNut ? 'fb-wire fb-nut' : 'fb-wire'}
            x1={x}
            y1={layout.boardTop}
            x2={x}
            y2={layout.boardBottom}
          />
        )
      })}

      {/* Strings (thicker toward the low strings) */}
      {stringIndexes.map((s) => {
        const y = stringY(layout, s)
        return (
          <line
            key={`string-${s}`}
            className="fb-string"
            x1={mx(layout.boardLeft)}
            y1={y}
            x2={mx(layout.boardRight)}
            y2={y}
            strokeWidth={stringStrokeWidth(s, stringCount)}
          />
        )
      })}

      {/* Fret numbers under inlay positions */}
      {showFretNumbers &&
        inlayDots(layout.fromFret, layout.toFret).map((dot) => (
          <text
            key={`num-${dot.fret}`}
            className="fb-fret-number"
            x={mx(noteX(layout, dot.fret))}
            y={layout.boardBottom + config.labelGutter - 4}
            textAnchor="middle"
          >
            {dot.fret}
          </text>
        ))}

      {/* Click targets */}
      {onFretClick &&
        stringIndexes.flatMap((s) =>
          clickableFrets.map((fret) => {
            const midi = fretMidi(tuning, s, fret)
            return (
              <rect
                key={`hit-${s}-${fret}`}
                className="fb-hit"
                x={mx(noteX(layout, fret)) - config.fretWidth / 2}
                y={stringY(layout, s) - config.stringSpacing / 2}
                width={config.fretWidth}
                height={config.stringSpacing}
                onClick={() => onFretClick({ string: s, fret, midi })}
              />
            )
          }),
        )}

      {/* Markers */}
      {markers.map((m) => {
        const midi = fretMidi(tuning, m.string, m.fret)
        const label = m.label ?? defaultMarkerLabel(midi, prefer)
        const variant = m.variant ?? 'default'
        const cx = mx(noteX(layout, m.fret))
        const cy = stringY(layout, m.string)
        return (
          <g key={`marker-${m.string}-${m.fret}`} className={`fb-dot fb-dot-${variant}`}>
            <circle cx={cx} cy={cy} r={dotR} />
            <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central">
              {label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
