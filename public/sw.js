// Music Trainer service worker.
//
// Plain JS, no build step: this file is copied verbatim from public/ into
// dist/ by Vite. The two lines below are placeholders — the pwaPrecache Vite
// plugin (src/lib/build/precache.ts, wired up in vite.config.ts) rewrites
// them in the *emitted* dist/sw.js after `vite build`, replacing the empty
// array/'dev' version with the real list of hashed build assets and a
// content-derived cache version. In dev (`npm run dev`) nothing rewrites
// this file, so PRECACHE_URLS stays empty and the worker is effectively a
// no-op — and src/main.tsx doesn't even register it outside production.
self.__PRECACHE__ = []
self.__CACHE_VERSION__ = 'dev'

const PRECACHE_URLS = self.__PRECACHE__
const CACHE_NAME = `mt-precache-${self.__CACHE_VERSION__}`

// Every build gets its own cache name (derived from the asset list's
// content hash), so a new deploy never mixes stale and fresh assets in one
// cache. The old cache(s) are only removed on activate, once the new
// version has fully installed.
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      if (PRECACHE_URLS.length > 0) {
        const cache = await caches.open(CACHE_NAME)
        await cache.addAll(PRECACHE_URLS)
      }
      // Activate this worker as soon as it finishes installing rather than
      // waiting for all tabs of the old version to close.
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys
          .filter((key) => key.startsWith('mt-precache-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

// The app uses a hash router (#/route), so every navigation loads the same
// index.html document. Find it in the precache list rather than hardcoding
// the deploy base path.
function shellUrl() {
  return PRECACHE_URLS.find((url) => url.endsWith('index.html'))
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const shell = shellUrl()
        if (shell) {
          const cachedShell = await caches.match(shell)
          if (cachedShell) return cachedShell
        }
        try {
          return await fetch(request)
        } catch (err) {
          const fallback = shell && (await caches.match(shell))
          if (fallback) return fallback
          throw err
        }
      })(),
    )
    return
  }

  // Cache-first for everything else (hashed, precached build assets): serve
  // from cache when present, otherwise fall through to the network.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request)
      if (cached) return cached
      return fetch(request)
    })(),
  )
})
