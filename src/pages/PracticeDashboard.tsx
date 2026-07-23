import { useMemo } from 'react'
import { buildDashboard } from '../lib/dashboard.ts'

/**
 * Practice Dashboard — a read-only overview of the player's activity: a
 * practice-day streak, a suggested daily routine drawn from their weakest
 * areas, and a per-tool stats grid. All data comes from the shared `mt:` stores
 * via `buildDashboard`; the page holds no logic beyond rendering that model.
 */
export function PracticeDashboard() {
  const dash = useMemo(() => buildDashboard(), [])
  const { streak, summaries, routine } = dash

  return (
    <div className="tool-page">
      <div className="tool-page-header">
        <h1>Practice Dashboard</h1>
        <p className="tool-page-lead">
          Your streak, a suggested routine for today built from your weakest
          areas, and a summary of every tool you've practiced. Nothing leaves
          your browser.
        </p>
      </div>

      <section className="db-streak" aria-label="Practice streak">
        <div className="db-streak-figures">
          <div className="db-figure">
            <span className="db-figure-num">{streak.current}</span>
            <span className="db-figure-label">day streak</span>
          </div>
          <div className="db-figure">
            <span className="db-figure-num">{streak.best}</span>
            <span className="db-figure-label">best streak</span>
          </div>
          <div className="db-figure">
            <span className="db-figure-num">{streak.total}</span>
            <span className="db-figure-label">days total</span>
          </div>
        </div>
        <div className="db-dots" role="img" aria-label="Practice over the last 7 days">
          {streak.last7.map((cell) => (
            <span
              key={cell.day}
              className={cell.practiced ? 'db-dot db-dot-on' : 'db-dot'}
              title={`${cell.day}${cell.practiced ? ' · practiced' : ''}`}
            />
          ))}
        </div>
      </section>

      {routine.length > 0 && (
        <section className="db-section" aria-label="Suggested routine">
          <h2 className="db-section-title">Suggested routine for today</h2>
          <ol className="db-routine">
            {routine.map((item) => (
              <li key={item.key} className="db-routine-item">
                <a className="db-routine-link" href={`#${item.route}`}>
                  <span className="db-routine-text">{item.suggestion}</span>
                  <span className="db-routine-min">{item.minutes} min</span>
                </a>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="db-section" aria-label="Per-tool stats">
        <h2 className="db-section-title">Your tools</h2>
        {summaries.length === 0 ? (
          <p className="db-empty">
            No practice recorded yet. Try the{' '}
            <a href="#/fretboard-notes">Fretboard Note Trainer</a> or{' '}
            <a href="#/ear-training">Ear Training</a> and your progress will show
            up here.
          </p>
        ) : (
          <div className="db-grid">
            {summaries.map((s) => (
              <a key={s.key} className="db-stat-card" href={`#${s.route}`}>
                <h3 className="db-stat-title">{s.title}</h3>
                <p className="db-stat-headline">{s.headline}</p>
                <p className="db-stat-detail">{s.detail}</p>
                <div
                  className="db-meter"
                  role="img"
                  aria-label={`${Math.round((1 - s.weakness) * 100)}% mastered`}
                >
                  <div
                    className="db-meter-fill"
                    style={{ width: `${Math.round((1 - s.weakness) * 100)}%` }}
                  />
                </div>
              </a>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
