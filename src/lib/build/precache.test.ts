import { describe, expect, it } from 'vitest'
import { buildPrecacheAssets, computeCacheVersion, injectPrecache } from './precache'

describe('buildPrecacheAssets', () => {
  it('prefixes static and bundle files with the base path', () => {
    const assets = buildPrecacheAssets('/music-trainer/', ['assets/index-abc123.js', 'assets/index-def456.css'], [
      'index.html',
      'manifest.webmanifest',
    ])
    expect(assets).toEqual([
      '/music-trainer/index.html',
      '/music-trainer/manifest.webmanifest',
      '/music-trainer/assets/index-abc123.js',
      '/music-trainer/assets/index-def456.css',
    ])
  })

  it('normalizes a base path without a trailing slash', () => {
    const assets = buildPrecacheAssets('/music-trainer', ['app.js'], ['index.html'])
    expect(assets).toEqual(['/music-trainer/index.html', '/music-trainer/app.js'])
  })

  it('works with a root base path', () => {
    const assets = buildPrecacheAssets('/', ['app.js'], ['index.html'])
    expect(assets).toEqual(['/index.html', '/app.js'])
  })

  it('strips a leading slash from individual file names before joining', () => {
    const assets = buildPrecacheAssets('/music-trainer/', ['/assets/app.js'], [])
    expect(assets).toEqual(['/music-trainer/assets/app.js'])
  })

  it('de-duplicates and keeps first-seen order (static files first)', () => {
    const assets = buildPrecacheAssets('/base/', ['index.html', 'app.js'], ['index.html'])
    expect(assets).toEqual(['/base/index.html', '/base/app.js'])
  })

  it('defaults staticFileNames to index.html, manifest and icons', () => {
    const assets = buildPrecacheAssets('/base/', ['app.js'])
    expect(assets).toEqual([
      '/base/index.html',
      '/base/manifest.webmanifest',
      '/base/icon.svg',
      '/base/icon-maskable.svg',
      '/base/app.js',
    ])
  })
})

describe('computeCacheVersion', () => {
  it('is deterministic for the same asset list regardless of input order', () => {
    const a = computeCacheVersion(['/base/a.js', '/base/b.css'])
    const b = computeCacheVersion(['/base/b.css', '/base/a.js'])
    expect(a).toBe(b)
  })

  it('changes when the asset list changes', () => {
    const a = computeCacheVersion(['/base/a.js'])
    const b = computeCacheVersion(['/base/a-newhash.js'])
    expect(a).not.toBe(b)
  })

  it('returns a short hex string', () => {
    const version = computeCacheVersion(['/base/a.js'])
    expect(version).toMatch(/^[0-9a-f]{10}$/)
  })
})

describe('injectPrecache', () => {
  const template = ["self.__PRECACHE__ = []", "self.__CACHE_VERSION__ = 'dev'", 'const x = 1'].join('\n')

  it('replaces both placeholders with the real values', () => {
    const result = injectPrecache(template, ['/base/index.html', '/base/app.js'], 'abc123')
    expect(result).toContain('self.__PRECACHE__ = ["/base/index.html","/base/app.js"]')
    expect(result).toContain('self.__CACHE_VERSION__ = "abc123"')
    expect(result).toContain('const x = 1')
  })

  it('throws if the precache placeholder is missing', () => {
    const broken = "self.__CACHE_VERSION__ = 'dev'"
    expect(() => injectPrecache(broken, [], 'v1')).toThrow(/__PRECACHE__/)
  })

  it('throws if the version placeholder is missing', () => {
    const broken = 'self.__PRECACHE__ = []'
    expect(() => injectPrecache(broken, [], 'v1')).toThrow(/__CACHE_VERSION__/)
  })
})
