// Pure, framework-free helpers used by the pwaPrecache Vite plugin (see
// vite.config.ts) to turn a production build's output file list into the
// contents of the service worker's precache manifest. Kept side-effect-free
// (no filesystem/network access) so it's fully unit-testable in the node
// test environment; the plugin itself does the file I/O.
import { createHash } from 'node:crypto'

/**
 * Builds the ordered, de-duplicated list of same-origin URLs the service
 * worker should precache: the static files copied verbatim from `public/`
 * (index.html, the manifest, icons, ...) followed by the hashed JS/CSS/asset
 * files Rollup emitted for this build. Each name is joined to the site's
 * base path (Vite's `base`, e.g. "/music-trainer/") so the list is correct
 * whether the base is "/" (dev/preview) or a GitHub Pages project path.
 */
export function buildPrecacheAssets(
  base: string,
  bundleFileNames: readonly string[],
  staticFileNames: readonly string[] = ['index.html', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg'],
): string[] {
  const prefix = base.endsWith('/') ? base : `${base}/`
  const seen = new Set<string>()
  const urls: string[] = []
  for (const name of [...staticFileNames, ...bundleFileNames]) {
    const cleanName = name.startsWith('/') ? name.slice(1) : name
    const url = `${prefix}${cleanName}`
    if (!seen.has(url)) {
      seen.add(url)
      urls.push(url)
    }
  }
  return urls
}

/**
 * Derives a short, stable cache-version string from the precache asset
 * list. Any change to the built output (a new content hash, a file added or
 * removed) changes this version, which changes the service worker's cache
 * name — so `activate` reliably evicts the previous deploy's cache instead
 * of serving a mix of old and new assets.
 */
export function computeCacheVersion(assets: readonly string[]): string {
  const hash = createHash('sha256')
  for (const asset of [...assets].sort()) hash.update(asset)
  return hash.digest('hex').slice(0, 10)
}

const PRECACHE_PLACEHOLDER = /self\.__PRECACHE__\s*=\s*\[\]/
const VERSION_PLACEHOLDER = /self\.__CACHE_VERSION__\s*=\s*'dev'/

/**
 * Rewrites the `self.__PRECACHE__ = []` / `self.__CACHE_VERSION__ = 'dev'`
 * placeholders in public/sw.js's source with the real, build-time values.
 * Throws if either placeholder is missing so an accidental edit to sw.js's
 * template can't silently ship a service worker with an empty precache list.
 */
export function injectPrecache(swSource: string, assets: readonly string[], version: string): string {
  if (!PRECACHE_PLACEHOLDER.test(swSource)) {
    throw new Error('sw.js is missing the `self.__PRECACHE__ = []` placeholder')
  }
  if (!VERSION_PLACEHOLDER.test(swSource)) {
    throw new Error("sw.js is missing the `self.__CACHE_VERSION__ = 'dev'` placeholder")
  }

  return swSource
    .replace(PRECACHE_PLACEHOLDER, `self.__PRECACHE__ = ${JSON.stringify(assets)}`)
    .replace(VERSION_PLACEHOLDER, `self.__CACHE_VERSION__ = ${JSON.stringify(version)}`)
}
