/**
 * Compact per-note progress display shared by the note trainers. Shows one
 * accuracy chip per pitch class (a small bar + percentage), highlights the
 * three weakest seen notes, and offers a reset button that confirms before
 * wiping the tool's stats.
 *
 * Presentational only: it reads a `NoteStatsData` map and calls `onReset`; the
 * page owns the store. Unseen notes render dimmed with an em dash.
 */

import { pcToName, type PitchClass } from '../lib/theory/notes.ts'
import type { NoteStatsData } from '../lib/noteStats.ts'

const PITCH_CLASSES: PitchClass[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
/** How many of the weakest seen notes to highlight. */
const WORST_COUNT = 3

interface NoteStatsPanelProps {
  stats: NoteStatsData
  prefer: 'sharp' | 'flat'
  onReset: () => void
}

/** Pitch classes of the `WORST_COUNT` seen notes with the lowest accuracy. */
function worstPitchClasses(stats: NoteStatsData): Set<PitchClass> {
  const seen = PITCH_CLASSES.map((pc) => ({ pc, stat: stats[pc] })).filter(
    (e): e is { pc: PitchClass; stat: NonNullable<typeof e.stat> } =>
      e.stat !== undefined && e.stat.attempts > 0 && e.stat.accuracy !== null,
  )
  seen.sort((a, b) => (a.stat.accuracy ?? 1) - (b.stat.accuracy ?? 1))
  return new Set(seen.slice(0, WORST_COUNT).map((e) => e.pc))
}

export function NoteStatsPanel({ stats, prefer, onReset }: NoteStatsPanelProps) {
  const anySeen = PITCH_CLASSES.some((pc) => (stats[pc]?.attempts ?? 0) > 0)
  const worst = anySeen ? worstPitchClasses(stats) : new Set<PitchClass>()

  const handleReset = (): void => {
    if (typeof window !== 'undefined' && !window.confirm('Reset progress stats for this trainer?'))
      return
    onReset()
  }

  return (
    <div className="ns-panel">
      <div className="ns-panel-head">
        <span className="tool-control-label">Per-note accuracy</span>
        <button
          type="button"
          className="ns-reset"
          onClick={handleReset}
          disabled={!anySeen}
        >
          Reset stats
        </button>
      </div>
      {anySeen ? (
        <div className="ns-chips" role="list">
          {PITCH_CLASSES.map((pc) => {
            const stat = stats[pc]
            const seen = stat !== undefined && stat.attempts > 0 && stat.accuracy !== null
            const pct = seen ? Math.round((stat.accuracy ?? 0) * 100) : null
            const cls = ['ns-chip']
            if (!seen) cls.push('ns-chip-unseen')
            if (worst.has(pc)) cls.push('ns-chip-worst')
            return (
              <div
                key={pc}
                className={cls.join(' ')}
                role="listitem"
                title={
                  seen
                    ? `${pcToName(pc, prefer)}: ${pct}% over ${stat.attempts} attempt${stat.attempts === 1 ? '' : 's'}`
                    : `${pcToName(pc, prefer)}: not yet quizzed`
                }
              >
                <span className="ns-chip-note">{pcToName(pc, prefer)}</span>
                <span className="ns-chip-bar" aria-hidden="true">
                  <span className="ns-chip-fill" style={{ width: `${pct ?? 0}%` }} />
                </span>
                <span className="ns-chip-pct">{pct === null ? '–' : `${pct}%`}</span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="ns-empty">Answer some questions to build up per-note stats.</p>
      )}
    </div>
  )
}
