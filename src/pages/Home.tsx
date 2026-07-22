import { TOOLS } from '../App.tsx'

export function Home() {
  return (
    <div>
      <p className="intro">
        Practice tools for bass and piano. Everything runs in your browser —
        no account, no tracking, works offline once loaded.
      </p>
      <div className="tool-grid">
        {TOOLS.map((tool) =>
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
    </div>
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
      <h2>{title}</h2>
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
