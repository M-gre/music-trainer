import { useMemo } from 'react'
import { TOOLS, TOOL_SECTIONS, type Tool } from '../App.tsx'
import { buildDashboard } from '../lib/dashboard.ts'
import { recentOrder } from '../lib/recentTools.ts'

export function Home() {
  // Read the practice model once per mount for the streak strip. Recency
  // ordering for the grid is read the same way.
  const dash = useMemo(() => buildDashboard(), [])

  const sections = useMemo(() => {
    return TOOL_SECTIONS.map((section) => {
      const tools = TOOLS.filter((t) => t.section === section.id)
      const order = recentOrder(tools.map((t) => t.route))
      const sorted = order
        .map((route) => tools.find((t) => t.route === route))
        .filter((t): t is Tool => t !== undefined)
      return { ...section, tools: sorted }
    })
  }, [])

  return (
    <div className="home">
      <p className="intro">
        Practice tools for bass, guitar and piano. Everything runs in your
        browser — no account, no tracking, works offline once loaded.
      </p>

      <StreakStrip dash={dash} />

      {sections.map((section) => (
        <ToolSectionGroup key={section.id} title={section.title} blurb={section.blurb} tools={section.tools} />
      ))}
    </div>
  )
}

function StreakStrip({ dash }: { dash: ReturnType<typeof buildDashboard> }) {
  const { streak, routine } = dash
  const hasData = streak.total > 0

  if (!hasData) {
    return (
      <section className="home-strip home-strip-empty" aria-label="Practice progress">
        <span className="home-strip-flame" aria-hidden="true">
          ✷
        </span>
        <p className="home-strip-empty-text">
          Practice any tool to start a streak — your progress and a suggested
          routine will show up here. <a href="#/dashboard">Open the dashboard →</a>
        </p>
      </section>
    )
  }

  return (
    <section className="home-strip" aria-label="Practice progress">
      <div className="home-strip-streak">
        <span className="home-strip-flame" aria-hidden="true">
          🔥
        </span>
        <span className="home-strip-num">{streak.current}</span>
        <span className="home-strip-label">
          day
          <br />
          streak
        </span>
      </div>

      <div className="home-strip-dots" role="img" aria-label="Practice over the last 7 days">
        {streak.last7.map((cell) => (
          <span
            key={cell.day}
            className={cell.practiced ? 'db-dot db-dot-on' : 'db-dot'}
            title={`${cell.day}${cell.practiced ? ' · practiced' : ''}`}
          />
        ))}
      </div>

      <div className="home-strip-routine">
        {routine.length > 0 ? (
          <ul className="home-strip-suggestions">
            {routine.slice(0, 2).map((item) => (
              <li key={item.key}>
                <a href={`#${item.route}`}>{item.suggestion}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="home-strip-allgood">You're on top of everything tracked — nice.</p>
        )}
        <a className="home-strip-full" href="#/dashboard">
          Full dashboard →
        </a>
      </div>
    </section>
  )
}

function ToolSectionGroup({
  title,
  blurb,
  tools,
}: {
  title: string
  blurb: string
  tools: Tool[]
}) {
  if (tools.length === 0) return null
  return (
    <section className="home-section" aria-label={title}>
      <div className="home-section-head">
        <h2 className="home-section-title">{title}</h2>
        <p className="home-section-blurb">{blurb}</p>
      </div>
      <div className="tool-grid">
        {tools.map((tool) =>
          tool.page ? (
            <a key={tool.route} className="tool-card" href={`#${tool.route}`}>
              <ToolCardBody {...tool} />
            </a>
          ) : (
            <div key={tool.route} className="tool-card tool-card-disabled">
              <ToolCardBody {...tool} />
              <span className="badge badge-soon">coming soon</span>
            </div>
          ),
        )}
      </div>
    </section>
  )
}

function ToolCardBody({
  title,
  description,
  tags,
}: {
  title: string
  description: string
  tags: string[]
}) {
  return (
    <>
      <h3>{title}</h3>
      <p>{description}</p>
      <div className="tags">
        {tags.map((tag) => (
          <span key={tag} className="badge">
            {tag}
          </span>
        ))}
      </div>
    </>
  )
}
