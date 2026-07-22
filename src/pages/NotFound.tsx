export function NotFound({ route, known }: { route: string; known: boolean }) {
  return (
    <div className="not-found">
      <h2>{known ? 'Coming soon' : 'Page not found'}</h2>
      <p>
        {known
          ? `The tool at ${route} is on the roadmap but not built yet.`
          : `No tool exists at ${route}.`}
      </p>
      <a href="#/">← Back to all tools</a>
    </div>
  )
}
