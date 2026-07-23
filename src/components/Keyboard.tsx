/**
 * `Keyboard` — a pure, props-driven SVG view of a piano keyboard.
 *
 * It contains no tool-specific logic: callers pass a pitch range (as midi
 * numbers or an octave range), a set of highlight `markers`, and receive a
 * click callback with the midi pitch of the key pressed. White keys have
 * equal width; black keys are narrower and shorter, painted on top and
 * centred on the boundary between the white keys they fall between (there is
 * no black key on the E–F or B–C boundary). The SVG scales responsively to
 * its container width via a `viewBox`. All geometry lives in
 * `keyboardGeometry.ts`.
 */

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useGlobalSettings } from '../hooks/useGlobalSettings.ts'
import { applySpellingPreference } from '../lib/globalSettings.ts'
import type { MarkerVariant } from './Fretboard.tsx'
import {
  blackKeyMidis,
  blackKeyX,
  computeLayout,
  DEFAULT_LAYOUT,
  defaultKeyLabel,
  isBlackKey,
  type KeyboardLayoutConfig,
  keyboardKeyLabel,
  keyCenterX,
  nextKeyboardMidi,
  octaveRangeToMidi,
  whiteKeyMidis,
  whiteKeyX,
} from './keyboardGeometry.ts'

/** A highlighted key on the keyboard. */
export interface KeyboardMarker {
  /** Midi pitch of the key to highlight. */
  midi: number
  /** Label drawn in the dot; defaults to the key's pitch-class name. */
  label?: string
  /** Highlight kind; defaults to `'default'`. Matches the Fretboard vocabulary. */
  variant?: MarkerVariant
}

/** Which white-key names to print as static labels. */
export type KeyboardLabelMode = 'none' | 'c' | 'all'

export interface KeyboardProps {
  /**
   * Lowest midi pitch shown. Snapped down to a white key. If omitted, the
   * range is derived from `fromOctave`/`toOctave` (default octaves 3–4).
   */
  from?: number
  /** Highest midi pitch shown. Snapped up to a white key. */
  to?: number
  /** Lowest octave shown (scientific pitch, C4 = middle C). Default 3. */
  fromOctave?: number
  /** Highest octave shown. Default 4. */
  toOctave?: number
  /** Highlighted keys. */
  markers?: KeyboardMarker[]
  /** Called when any key is clicked. */
  onKeyClick?: (key: { midi: number }) => void
  /**
   * Static white-key name labels: `'none'`, `'c'` (only C keys, with octave
   * for orientation) or `'all'` (every white key). Default `'c'`.
   */
  showLabels?: KeyboardLabelMode
  /**
   * Accidental spelling for default labels (the tool's context-dependent
   * choice). The global spelling preference is applied on top: `'auto'` keeps
   * this value, `'sharps'`/`'flats'` override it. Defaults to `'sharp'`.
   */
  prefer?: 'sharp' | 'flat'
  /** Pixel layout overrides (partial). */
  layoutConfig?: Partial<KeyboardLayoutConfig>
  /** Extra class on the root `<svg>`. */
  className?: string
  /** Accessible label for the SVG. */
  ariaLabel?: string
}

export function Keyboard({
  from,
  to,
  fromOctave = 3,
  toOctave = 4,
  markers = [],
  onKeyClick,
  showLabels = 'c',
  prefer = 'sharp',
  layoutConfig,
  className,
  ariaLabel,
}: KeyboardProps) {
  const { settings } = useGlobalSettings()
  // The global spelling preference overrides the tool's context choice unless
  // it is 'auto', which keeps the caller-supplied `prefer` as-is.
  const resolvedPrefer = applySpellingPreference(settings.spellingPreference, prefer)
  const config: KeyboardLayoutConfig = { ...DEFAULT_LAYOUT, ...layoutConfig }
  const octRange = octaveRangeToMidi(fromOctave, toOctave)
  const rawFrom = from ?? octRange.from
  const rawTo = to ?? octRange.to
  const layout = computeLayout(rawFrom, rawTo, config, showLabels !== 'none')

  const whites = whiteKeyMidis(layout.from, layout.to)
  const blacks = blackKeyMidis(layout.from, layout.to)
  const markerByMidi = new Map(markers.map((m) => [m.midi, m]))

  // Roving tabindex: one tabstop for the whole keybed; arrow keys move a single
  // focused key. Every drawn key is a consecutive midi in [from, to].
  const orderedMidis = Array.from({ length: layout.to - layout.from + 1 }, (_, i) => layout.from + i)
  const [cursor, setCursor] = useState(layout.from)
  const keyRefs = useRef(new Map<number, SVGRectElement>())
  const activeMidi = orderedMidis.includes(cursor) ? cursor : layout.from

  const keyA11y = (midi: number) =>
    onKeyClick
      ? ({
          ref: (el: SVGRectElement | null) => {
            const map = keyRefs.current
            if (el) map.set(midi, el)
            else map.delete(midi)
          },
          role: 'button' as const,
          tabIndex: midi === activeMidi ? 0 : -1,
          'aria-label': keyboardKeyLabel(midi, resolvedPrefer),
          onKeyDown: (e: ReactKeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onKeyClick({ midi })
              return
            }
            const next = nextKeyboardMidi(midi, e.key, orderedMidis)
            if (next !== midi) {
              e.preventDefault()
              setCursor(next)
              keyRefs.current.get(next)?.focus()
            }
          },
        })
      : {}

  // Marker dot radius fits inside the narrower black keys.
  const dotR = layout.blackWidth * 0.42
  const dotPad = 8

  const showWhiteLabel = (midi: number): boolean => {
    if (showLabels === 'all') return true
    if (showLabels === 'c') return midi % 12 === 0
    return false
  }

  return (
    <svg
      className={`kb-keyboard${onKeyClick ? ' kb-interactive' : ''}${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width="100%"
      role={onKeyClick ? 'group' : 'img'}
      aria-label={ariaLabel ?? 'piano keyboard'}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* White keys */}
      {whites.map((midi) => (
        <rect
          key={`white-${midi}`}
          className="kb-key kb-white"
          x={whiteKeyX(layout, midi)}
          y={layout.boardTop}
          width={layout.whiteWidth}
          height={layout.whiteHeight}
          rx={3}
          onClick={onKeyClick ? () => onKeyClick({ midi }) : undefined}
          {...keyA11y(midi)}
        />
      ))}

      {/* Black keys, painted on top */}
      {blacks.map((midi) => (
        <rect
          key={`black-${midi}`}
          className="kb-key kb-black"
          x={blackKeyX(layout, midi)}
          y={layout.boardTop}
          width={layout.blackWidth}
          height={layout.blackHeight}
          rx={2}
          onClick={onKeyClick ? () => onKeyClick({ midi }) : undefined}
          {...keyA11y(midi)}
        />
      ))}

      {/* Static white-key name labels in the reserved strip below the keys, so
          marker dots (which sit on the keys) never cover them */}
      {whites.filter(showWhiteLabel).map((midi) => (
        <text
          key={`label-${midi}`}
          className="kb-key-label"
          x={keyCenterX(layout, midi)}
          y={layout.labelBaselineY}
          textAnchor="middle"
        >
          {defaultKeyLabel(midi, resolvedPrefer, true)}
        </text>
      ))}

      {/* Highlight dots (rendered last, on top of every key) */}
      {[...whites, ...blacks]
        .filter((midi) => markerByMidi.has(midi))
        .map((midi) => {
          const marker = markerByMidi.get(midi)!
          const variant = marker.variant ?? 'default'
          const label = marker.label ?? defaultKeyLabel(midi, resolvedPrefer)
          const black = isBlackKey(midi)
          const cy = layout.boardTop + (black ? layout.blackHeight : layout.whiteHeight) - dotR - dotPad
          return (
            <g key={`dot-${midi}`} className={`kb-dot kb-dot-${variant}`}>
              <circle cx={keyCenterX(layout, midi)} cy={cy} r={dotR} />
              <text
                x={keyCenterX(layout, midi)}
                y={cy}
                textAnchor="middle"
                dominantBaseline="central"
              >
                {label}
              </text>
            </g>
          )
        })}
    </svg>
  )
}
