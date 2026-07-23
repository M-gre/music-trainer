import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { buildPrecacheAssets, computeCacheVersion, injectPrecache } from './src/lib/build/precache'

/**
 * Tiny build-only plugin: after `vite build` finishes writing dist/
 * (including the files copied verbatim from public/, such as sw.js), it
 * rewrites the `self.__PRECACHE__ = []` / `self.__CACHE_VERSION__ = 'dev'`
 * placeholders in dist/sw.js with the real list of hashed build assets and a
 * content-derived cache version (see src/lib/build/precache.ts for the pure
 * logic, and public/sw.js for how the placeholders are consumed at
 * runtime). Never runs in dev — the placeholder in public/sw.js is left
 * untouched there, and the SW isn't registered outside production builds
 * (see src/main.tsx).
 */
function pwaPrecachePlugin(): Plugin {
  let outDir = 'dist'
  let base = '/'
  return {
    name: 'pwa-precache',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir
      base = config.base
    },
    // Runs after the whole build (including the public/ dir copy) has been
    // written to disk, so dist/sw.js is guaranteed to already exist.
    closeBundle() {
      const absOutDir = resolve(outDir)
      const swPath = resolve(absOutDir, 'sw.js')
      if (!existsSync(swPath)) return

      const bundleFileNames = listBuiltFileNames(absOutDir, absOutDir).filter((name) => name !== 'sw.js')
      const assets = buildPrecacheAssets(base, bundleFileNames)
      const version = computeCacheVersion(assets)
      const source = readFileSync(swPath, 'utf-8')
      writeFileSync(swPath, injectPrecache(source, assets, version))
    },
  }
}

// Recursively lists every file emitted under `dir`, returned as paths
// relative to `root` (using forward slashes, matching URL paths).
function listBuiltFileNames(dir: string, root: string): string[] {
  const names: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry)
    if (statSync(full).isDirectory()) {
      names.push(...listBuiltFileNames(full, root))
    } else {
      names.push(full.slice(root.length + 1).split(sep).join('/'))
    }
  }
  return names
}

export default defineConfig({
  // Deployed as a GitHub Pages project page at /music-trainer/
  base: '/music-trainer/',
  plugins: [react(), pwaPrecachePlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
