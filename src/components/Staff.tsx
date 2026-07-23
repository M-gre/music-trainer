/**
 * `Staff` — a pure, props-driven SVG five-line staff showing a single whole
 * note in bass or treble clef, with ledger lines and an accidental as needed.
 *
 * It contains no quiz logic: callers pass a midi pitch, a clef, and a preferred
 * spelling; all placement math lives in `staffGeometry.ts` and is unit-tested
 * without rendering. The SVG scales responsively via a `viewBox`.
 *
 * The clefs are drawn as SVG paths (a smooth generated spiral + stem for the
 * treble G-clef; a hook plus the two straddling dots for the bass F-clef)
 * rather than relying on the Musical Symbols unicode block, whose font
 * coverage is unreliable. Accidentals use the widely-supported ♯/♭ glyphs
 * (U+266F / U+266D) as SVG text.
 */

import {
  computeStaffLayout,
  DEFAULT_STAFF_LAYOUT,
  ledgerLines,
  midiToStaffNote,
  yForPosition,
  type Accidental,
  type Clef,
  type StaffLayout,
  type StaffLayoutConfig,
} from './staffGeometry.ts'
import { midiToName } from '../lib/theory/notes.ts'

export interface StaffProps {
  /** Midi pitch of the note to draw. */
  midi: number
  /** Which clef to render. */
  clef: Clef
  /** Accidental spelling for the drawn note. Default `'sharp'`. */
  prefer?: Accidental
  /** Pixel layout overrides (partial). */
  layoutConfig?: Partial<StaffLayoutConfig>
  /** Extra class on the root `<svg>`. */
  className?: string
  /** Accessible label for the SVG. Defaults to a description of the note. */
  ariaLabel?: string
}

const ACCIDENTAL_GLYPH: Record<Accidental, string> = {
  sharp: '♯',
  flat: '♭',
}

/** Smooth generated spiral + stem forming a stylized treble (G) clef. */
function trebleClefPath(layout: StaffLayout): string {
  const g = layout.config.lineGap
  const cx = layout.clefX
  const cyG = yForPosition(layout, 2) // the G line the clef curls around
  const steps = 64
  const turns = 2.25
  const rMax = g * 1.18
  const thetaMax = turns * 2 * Math.PI
  const pts: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const theta = t * thetaMax
    const r = g * 0.12 + rMax * t
    const x = cx + r * Math.cos(theta - Math.PI / 2)
    const y = cyG - r * Math.sin(theta - Math.PI / 2)
    pts.push(`${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  // Spiral (inner → outer), then a bowed stem rising above the staff and a
  // small tail curling below it.
  const spiral = `M ${pts.join(' L ')}`
  const stemTopY = yForPosition(layout, 11.5)
  const tailY = yForPosition(layout, -2.2)
  const stem =
    `M ${(cx + g * 0.18).toFixed(2)} ${(cyG - rMax).toFixed(2)}` +
    ` C ${(cx + g * 0.9).toFixed(2)} ${(cyG - rMax - g).toFixed(2)}` +
    ` ${(cx + g * 0.55).toFixed(2)} ${stemTopY.toFixed(2)}` +
    ` ${(cx - g * 0.15).toFixed(2)} ${stemTopY.toFixed(2)}`
  const tail =
    `M ${cx.toFixed(2)} ${(cyG + g * 0.1).toFixed(2)}` +
    ` C ${(cx - g * 0.1).toFixed(2)} ${(tailY - g).toFixed(2)}` +
    ` ${(cx - g * 0.9).toFixed(2)} ${tailY.toFixed(2)}` +
    ` ${(cx - g * 1.1).toFixed(2)} ${(tailY + g * 0.4).toFixed(2)}`
  return `${stem} ${spiral} ${tail}`
}

/** Hook forming a stylized bass (F) clef. The two dots are drawn separately. */
function bassClefPath(layout: StaffLayout): string {
  const g = layout.config.lineGap
  const cx = layout.clefX
  const yF = yForPosition(layout, 6) // the F line the dots straddle
  // A comma/ear that starts near the F line, sweeps up and over into a bulb,
  // then curls back down and to the left.
  return (
    `M ${(cx - g * 0.4).toFixed(2)} ${yForPosition(layout, 7.4).toFixed(2)}` +
    ` C ${(cx - g * 0.5).toFixed(2)} ${yForPosition(layout, 8.9).toFixed(2)}` +
    ` ${(cx + g * 1.7).toFixed(2)} ${yForPosition(layout, 8.9).toFixed(2)}` +
    ` ${(cx + g * 1.7).toFixed(2)} ${yForPosition(layout, 7.0).toFixed(2)}` +
    ` C ${(cx + g * 1.7).toFixed(2)} ${yForPosition(layout, 5.3).toFixed(2)}` +
    ` ${(cx + g * 0.3).toFixed(2)} ${yForPosition(layout, 5.0).toFixed(2)}` +
    ` ${(cx - g * 0.6).toFixed(2)} ${yForPosition(layout, 5.8).toFixed(2)}` +
    ` C ${(cx - g * 1.4).toFixed(2)} ${yForPosition(layout, 6.5).toFixed(2)}` +
    ` ${(cx - g * 1.4).toFixed(2)} ${yForPosition(layout, 3.6).toFixed(2)}` +
    ` ${(cx - g * 2.1).toFixed(2)} ${yF.toFixed(2)}`
  )
}

export function Staff({
  midi,
  clef,
  prefer = 'sharp',
  layoutConfig,
  className,
  ariaLabel,
}: StaffProps) {
  const config: StaffLayoutConfig = { ...DEFAULT_STAFF_LAYOUT, ...layoutConfig }
  const layout = computeStaffLayout(config)
  const note = midiToStaffNote(midi, clef, prefer)
  const noteY = yForPosition(layout, note.position)
  const ledgers = ledgerLines(note.position)
  const g = config.lineGap

  const label = ariaLabel ?? `${midiToName(midi, prefer)} on the ${clef} clef`

  return (
    <svg
      className={`st-staff${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      role="img"
      aria-label={label}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* Five staff lines */}
      {layout.lineYs.map((y, i) => (
        <line
          key={`line-${i}`}
          className="st-line"
          x1={layout.staffLeft}
          y1={y}
          x2={layout.staffRight}
          y2={y}
        />
      ))}

      {/* Clef */}
      {clef === 'treble' ? (
        <path className="st-clef" d={trebleClefPath(layout)} fill="none" />
      ) : (
        <g className="st-clef-group">
          <path className="st-clef" d={bassClefPath(layout)} fill="none" />
          <circle
            className="st-clef-dot"
            cx={layout.clefX + g * 2.4}
            cy={yForPosition(layout, 7)}
            r={g * 0.2}
          />
          <circle
            className="st-clef-dot"
            cx={layout.clefX + g * 2.4}
            cy={yForPosition(layout, 5)}
            r={g * 0.2}
          />
        </g>
      )}

      {/* Ledger lines through the notehead */}
      {ledgers.map((pos) => {
        const y = yForPosition(layout, pos)
        return (
          <line
            key={`ledger-${pos}`}
            className="st-ledger"
            x1={layout.noteX - layout.ledgerHalf}
            y1={y}
            x2={layout.noteX + layout.ledgerHalf}
            y2={y}
          />
        )
      })}

      {/* Accidental */}
      {note.accidental && (
        <text
          className="st-accidental"
          x={layout.accidentalX}
          y={noteY}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {ACCIDENTAL_GLYPH[note.accidental]}
        </text>
      )}

      {/* Whole note: an open oval (outer disc with a rotated bg-coloured hole) */}
      <g className="st-note">
        <ellipse cx={layout.noteX} cy={noteY} rx={layout.noteRx} ry={layout.noteRy} />
        <ellipse
          className="st-note-hole"
          cx={layout.noteX}
          cy={noteY}
          rx={layout.noteRx * 0.55}
          ry={layout.noteRy * 0.62}
          transform={`rotate(-24 ${layout.noteX} ${noteY})`}
        />
      </g>
    </svg>
  )
}
