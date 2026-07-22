import { useEffect, useState } from 'react'

/**
 * Minimal hash-based router. Hash routing (#/path) is used instead of history
 * routing because GitHub Pages serves static files only — deep links to
 * history-routed paths would 404. Zero dependencies by design.
 */
export function useHashRoute(): string {
  const [route, setRoute] = useState(readHash)

  useEffect(() => {
    const onChange = () => setRoute(readHash())
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

function readHash(): string {
  const hash = window.location.hash.replace(/^#/, '')
  return hash === '' ? '/' : hash
}

export function navigate(route: string): void {
  window.location.hash = route
}
