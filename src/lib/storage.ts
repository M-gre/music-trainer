/**
 * Typed, versioned localStorage wrapper. All persistent state (settings,
 * quiz progress) goes through a `Store<T>` so that:
 *  - keys are namespaced under `mt:` and never collide with other sites,
 *  - values are JSON with an explicit schema version, so a shape change
 *    can migrate (or safely discard) old data instead of crashing,
 *  - corrupted values, quota errors, and missing localStorage (tests,
 *    private mode) degrade to defaults instead of throwing.
 *
 * The backend is injectable: tests pass `memoryBackend()`, the app uses
 * the default (window.localStorage when available).
 */

const PREFIX = 'mt:'

/** Minimal subset of the DOM Storage interface. */
export interface StorageBackend {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** In-memory backend for tests and environments without localStorage. */
export function memoryBackend(): StorageBackend {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

function defaultBackend(): StorageBackend {
  try {
    // Guarded: throws in some private-browsing modes; absent in node tests.
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // fall through to memory
  }
  return memoryBackend()
}

interface Envelope {
  v: number
  data: unknown
}

export interface StoreOptions<T> {
  /** Key without the `mt:` prefix, e.g. "settings". */
  key: string
  /** Bump when the persisted shape of T changes. */
  version: number
  /** Returned whenever nothing valid is stored. Must be JSON-serializable. */
  defaultValue: T
  /**
   * Optional upgrade for data stored with an older version. Given the raw
   * old data and its version; must return a valid T. If omitted, or if it
   * throws, old-version data is discarded in favor of `defaultValue`.
   */
  migrate?: (oldData: unknown, oldVersion: number) => T
}

export class Store<T> {
  private readonly storageKey: string

  constructor(
    private readonly options: StoreOptions<T>,
    private readonly backend: StorageBackend = defaultBackend(),
  ) {
    this.storageKey = PREFIX + options.key
  }

  get(): T {
    let raw: string | null
    try {
      raw = this.backend.getItem(this.storageKey)
    } catch {
      return this.options.defaultValue
    }
    if (raw === null) return this.options.defaultValue

    let envelope: Envelope
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || !('v' in parsed) || !('data' in parsed)) {
        return this.options.defaultValue
      }
      envelope = parsed as Envelope
    } catch {
      return this.options.defaultValue
    }

    if (envelope.v === this.options.version) return envelope.data as T

    if (this.options.migrate && typeof envelope.v === 'number' && envelope.v < this.options.version) {
      try {
        const migrated = this.options.migrate(envelope.data, envelope.v)
        this.set(migrated)
        return migrated
      } catch {
        return this.options.defaultValue
      }
    }
    return this.options.defaultValue
  }

  set(value: T): void {
    const envelope: Envelope = { v: this.options.version, data: value }
    try {
      this.backend.setItem(this.storageKey, JSON.stringify(envelope))
    } catch {
      // Quota exceeded or storage unavailable — losing persistence must
      // never break the app.
    }
  }

  update(fn: (current: T) => T): T {
    const next = fn(this.get())
    this.set(next)
    return next
  }

  clear(): void {
    try {
      this.backend.removeItem(this.storageKey)
    } catch {
      // ignore
    }
  }
}
