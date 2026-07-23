/**
 * `Staff` — a pure, props-driven SVG five-line staff showing a single whole
 * note in bass or treble clef, with ledger lines and an accidental as needed.
 *
 * It contains no quiz logic: callers pass a midi pitch, a clef, and a preferred
 * spelling; all placement math lives in `staffGeometry.ts` and is unit-tested
 * without rendering. The SVG scales responsively via a `viewBox`.
 *
 * The clefs are drawn from real, public-domain engraved glyph outlines (see
 * `TREBLE_CLEF` / `BASS_CLEF` below) rather than the Musical Symbols unicode
 * block, whose font coverage is unreliable, or hand-rolled curves. Each glyph
 * keeps its source coordinate system; a single wrapping `<g transform>`,
 * derived from the staff layout, scales it and anchors its musical reference
 * point (the treble clef's spiral eye onto the G4 line; the bass clef's dots
 * straddling the F3 line) to the correct staff line. Accidentals use the
 * widely-supported ♯/♭ glyphs (U+266F / U+266D) as SVG text.
 */

import {
  computeStaffLayout,
  DEFAULT_STAFF_LAYOUT,
  ledgerLines,
  midiToStaffNote,
  yForPosition,
  type Accidental,
  type Clef,
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

/**
 * Real, public-domain engraved clef glyph outlines and the metadata needed to
 * anchor each to the staff lines.
 *
 * Treble (G) clef — from Wikimedia Commons `File:GClef.svg`, public domain
 *   ("ineligible for copyright … no original authorship"). Native coordinate
 *   box ≈ 0..15.76 × 0..41.19. `anchorY` is the spiral eye (the point the glyph
 *   curls around, i.e. the G4 line); `unitSpace` is glyph units per staff space.
 *
 * Bass (F) clef body — from Wikimedia Commons `File:Music-Fclef.svg`, public
 *   domain (same rationale). The source path is flattened here into absolute
 *   coordinates (its `matrix(3,0,0,3,15,-150)` group transform baked in). The
 *   two dots are the source file's circles (also flattened), which straddle the
 *   F3 line exactly one staff space apart — so their spacing calibrates the
 *   glyph's staff-space size, and their midpoint marks the F line.
 */
const TREBLE_CLEF = {
  path: 'm12.049 3.5296c0.305 3.1263-2.019 5.6563-4.0772 7.7014-0.9349 0.897-0.155 0.148-0.6437 0.594-0.1022-0.479-0.2986-1.731-0.2802-2.11 0.1304-2.6939 2.3198-6.5875 4.2381-8.0236 0.309 0.5767 0.563 0.6231 0.763 1.8382zm0.651 16.142c-1.232-0.906-2.85-1.144-4.3336-0.885-0.1913-1.255-0.3827-2.51-0.574-3.764 2.3506-2.329 4.9066-5.0322 5.0406-8.5394 0.059-2.232-0.276-4.6714-1.678-6.4836-1.7004 0.12823-2.8995 2.156-3.8019 3.4165-1.4889 2.6705-1.1414 5.9169-0.57 8.7965-0.8094 0.952-1.9296 1.743-2.7274 2.734-2.3561 2.308-4.4085 5.43-4.0046 8.878 0.18332 3.334 2.5894 6.434 5.8702 7.227 1.2457 0.315 2.5639 0.346 3.8241 0.099 0.2199 2.25 1.0266 4.629 0.0925 6.813-0.7007 1.598-2.7875 3.004-4.3325 2.192-0.5994-0.316-0.1137-0.051-0.478-0.252 1.0698-0.257 1.9996-1.036 2.26-1.565 0.8378-1.464-0.3998-3.639-2.1554-3.358-2.262 0.046-3.1904 3.14-1.7356 4.685 1.3468 1.52 3.833 1.312 5.4301 0.318 1.8125-1.18 2.0395-3.544 1.8325-5.562-0.07-0.678-0.403-2.67-0.444-3.387 0.697-0.249 0.209-0.059 1.193-0.449 2.66-1.053 4.357-4.259 3.594-7.122-0.318-1.469-1.044-2.914-2.302-3.792zm0.561 5.757c0.214 1.991-1.053 4.321-3.079 4.96-0.136-0.795-0.172-1.011-0.2626-1.475-0.4822-2.46-0.744-4.987-1.116-7.481 1.6246-0.168 3.4576 0.543 4.0226 2.184 0.244 0.577 0.343 1.197 0.435 1.812zm-5.1486 5.196c-2.5441 0.141-4.9995-1.595-5.6343-4.081-0.749-2.153-0.5283-4.63 0.8207-6.504 1.1151-1.702 2.6065-3.105 4.0286-4.543 0.183 1.127 0.366 2.254 0.549 3.382-2.9906 0.782-5.0046 4.725-3.215 7.451 0.5324 0.764 1.9765 2.223 2.7655 1.634-1.102-0.683-2.0033-1.859-1.8095-3.227-0.0821-1.282 1.3699-2.911 2.6513-3.198 0.4384 2.869 0.9413 6.073 1.3797 8.943-0.5054 0.1-1.0211 0.143-1.536 0.143z',
  /** Horizontal centre of the glyph → clefX. */
  anchorX: 7.71,
  /** Spiral eye (the G4 line) → the G line. */
  anchorY: 26,
  /** Glyph units per staff space. */
  unitSpace: 6.05,
} as const

const BASS_CLEF = {
  body: 'M 202.535 233.521 C 202.535 231.002 214.661 220.636 229.481 210.485 C 261.346 188.661 284.357 164.783 297.742 139.656 C 328.435 82.035 318.712 21.954 277.806 16.467 C 255.18 13.432 226.535 29.941 226.535 46.016 C 226.535 51.979 228.061 52.459 244.647 51.719 C 264.942 50.812 278.672 70.567 267.69 84.871 C 250.336 107.474 208.535 94.489 208.535 66.496 C 208.535 41.961 223.465 22.436 249.743 12.604 C 305.978 -8.436 359.508 30.352 354.821 88.744 C 350.979 136.604 309.309 181.302 228.413 224.336 C 209.219 234.546 202.535 236.919 202.535 233.521 Z',
  /** The two dots, straddling the F line. */
  dot1: { cx: 384, cy: 48.36 },
  dot2: { cx: 385.16, cy: 108.0 },
  dotR: 16.9,
  /** Horizontal centre of the whole glyph (body + dots) → clefX. */
  anchorX: 302,
  /** Midpoint of the two dots (the F3 line) → the F line. */
  anchorY: 78.18,
  /** Glyph units per staff space (= the dot spacing). */
  unitSpace: 59.64,
} as const

/**
 * SVG transform that scales a glyph by `s` and translates it so its anchor
 * point `(ax, ay)` lands on `(tx, ty)`.
 */
function clefTransform(s: number, ax: number, ay: number, tx: number, ty: number): string {
  return `translate(${(tx - s * ax).toFixed(3)} ${(ty - s * ay).toFixed(3)}) scale(${s.toFixed(5)})`
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

      {/* Clef — a real engraved glyph, scaled and anchored to its staff line. */}
      {clef === 'treble' ? (
        <g
          transform={clefTransform(
            g / TREBLE_CLEF.unitSpace,
            TREBLE_CLEF.anchorX,
            TREBLE_CLEF.anchorY,
            layout.clefX,
            yForPosition(layout, 2), // G4 line
          )}
        >
          <path className="st-clef" d={TREBLE_CLEF.path} />
        </g>
      ) : (
        <g
          className="st-clef-group"
          transform={clefTransform(
            g / BASS_CLEF.unitSpace,
            BASS_CLEF.anchorX,
            BASS_CLEF.anchorY,
            layout.clefX,
            yForPosition(layout, 6), // F3 line
          )}
        >
          <path className="st-clef" d={BASS_CLEF.body} />
          <circle
            className="st-clef-dot"
            cx={BASS_CLEF.dot1.cx}
            cy={BASS_CLEF.dot1.cy}
            r={BASS_CLEF.dotR}
          />
          <circle
            className="st-clef-dot"
            cx={BASS_CLEF.dot2.cx}
            cy={BASS_CLEF.dot2.cy}
            r={BASS_CLEF.dotR}
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
