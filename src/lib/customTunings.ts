/**
 * User-defined custom tunings, stored alongside the built-ins.
 *
 * A `CustomTuning` is a serializable record (name + per-string midi pitches,
 * lowest string first) that converts to the standard `Tuning` shape via
 * `toTuning`, so every fretboard tool consumes it unchanged. Custom ids are
 * prefixed `custom:` to keep them distinct from the built-in ids.
 *
 * Persistence goes through the versioned `Store` wrapper (`mt:custom-tunings`,
 * an array). CRUD helpers are pure (they take and return arrays, never touch
 * storage) so they are unit-testable without a backend; the React hook
 * (`useCustomTunings`) wires them to the store.
 *
 * The `resolveTuning` resolver checks built-ins first, then customs, and falls
 * back to a safe default when an id no longer exists — important because a tool
 * may have persisted a custom id as its global default before that tuning was
 * deleted or before storage was cleared on another device.
 */

import { Store, type StorageBackend } from './storage.ts'
import { getTuning, type FrettedInstrument, type Tuning } from './theory/instruments.ts'
import { nameToMidi, type Midi } from './theory/notes.ts'

/** Prefix that marks a tuning id as user-defined. */
export const CUSTOM_TUNING_PREFIX = 'custom:'

/** A serializable, user-defined tuning. Mirrors `Tuning` but with a custom id. */
export interface CustomTuning {
  /** `custom:<slug>-<suffix>` — always starts with {@link CUSTOM_TUNING_PREFIX}. */
  id: string
  name: string
  instrument: FrettedInstrument
  /** Open-string midi pitches, lowest string first. */
  strings: Midi[]
}

/** The editable fields of a custom tuning (everything except its generated id). */
export interface CustomTuningInput {
  name: string
  instrument: FrettedInstrument
  strings: Midi[]
}

/** Result of a validating operation: success or a human-readable reason. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

// ---- Validation rules ------------------------------------------------------
//
// A custom tuning is valid when ALL of these hold:
//  - name is non-empty after trimming and at most MAX_NAME_LENGTH chars;
//  - name is unique (case-insensitive) among other custom tunings for the same
//    instrument (built-in names are not considered — a "My EADG" is fine);
//  - instrument is 'bass' or 'guitar';
//  - it has between MIN_STRINGS and MAX_STRINGS strings;
//  - every open-string pitch is an integer midi within the instrument's sane
//    playable range (see MIDI_RANGE).

export const MIN_STRINGS = 2
export const MAX_STRINGS = 10
export const MAX_NAME_LENGTH = 40

/** Roughly the playable open-string range per instrument (inclusive midi). */
export const MIDI_RANGE: Record<FrettedInstrument, { min: Midi; max: Midi }> = {
  // A0 .. C4 — covers low-B 5/6-string basses through tenor tunings.
  bass: { min: nameToMidi('A0'), max: nameToMidi('C4') },
  // C1 .. C6 — covers 7/8-string low F# up through capo-high open tunings.
  guitar: { min: nameToMidi('C1'), max: nameToMidi('C6') },
}

/** True if the id refers to a user-defined tuning (by prefix, not existence). */
export function isCustomTuningId(id: string): boolean {
  return id.startsWith(CUSTOM_TUNING_PREFIX)
}

function isInstrument(value: unknown): value is FrettedInstrument {
  return value === 'bass' || value === 'guitar'
}

/** Convert a stored custom tuning to the standard `Tuning` shape. */
export function toTuning(ct: CustomTuning): Tuning {
  return { id: ct.id, name: ct.name, instrument: ct.instrument, strings: [...ct.strings] }
}

/**
 * Validate a would-be custom tuning against the rules above. `existing` is the
 * current custom-tuning list (for the uniqueness check); `editingId` excludes
 * the record being edited so re-saving it under its own name is allowed.
 */
export function validateCustomTuning(
  input: CustomTuningInput,
  existing: CustomTuning[],
  editingId?: string,
): Result<CustomTuningInput> {
  if (!isInstrument(input.instrument)) {
    return { ok: false, error: 'Instrument must be bass or guitar.' }
  }

  const name = input.name.trim()
  if (name.length === 0) return { ok: false, error: 'Name cannot be empty.' }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, error: `Name must be at most ${MAX_NAME_LENGTH} characters.` }
  }

  const clash = existing.some(
    (t) =>
      t.id !== editingId &&
      t.instrument === input.instrument &&
      t.name.trim().toLowerCase() === name.toLowerCase(),
  )
  if (clash) {
    return { ok: false, error: `A ${input.instrument} tuning named “${name}” already exists.` }
  }

  if (input.strings.length < MIN_STRINGS || input.strings.length > MAX_STRINGS) {
    return {
      ok: false,
      error: `A tuning must have between ${MIN_STRINGS} and ${MAX_STRINGS} strings.`,
    }
  }

  const range = MIDI_RANGE[input.instrument]
  for (const midi of input.strings) {
    if (!Number.isInteger(midi) || midi < range.min || midi > range.max) {
      return {
        ok: false,
        error: `Every string must be a pitch between ${range.min} and ${range.max} (midi).`,
      }
    }
  }

  return { ok: true, value: { name, instrument: input.instrument, strings: [...input.strings] } }
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.length > 0 ? slug : 'tuning'
}

/** Build a unique `custom:` id from a name, avoiding collisions with `taken`. */
export function makeCustomTuningId(name: string, taken: Iterable<string>): string {
  const takenSet = new Set(taken)
  const base = `${CUSTOM_TUNING_PREFIX}${slugify(name)}`
  if (!takenSet.has(base)) return base
  let n = 2
  while (takenSet.has(`${base}-${n}`)) n += 1
  return `${base}-${n}`
}

/**
 * Add a validated custom tuning to `list`, returning the new list and the
 * created record. Does not mutate `list`.
 */
export function addCustomTuning(
  list: CustomTuning[],
  input: CustomTuningInput,
): Result<{ list: CustomTuning[]; tuning: CustomTuning }> {
  const validated = validateCustomTuning(input, list)
  if (!validated.ok) return validated
  const tuning: CustomTuning = {
    id: makeCustomTuningId(
      validated.value.name,
      list.map((t) => t.id),
    ),
    ...validated.value,
  }
  return { ok: true, value: { list: [...list, tuning], tuning } }
}

/**
 * Update an existing custom tuning in place (keeping its id), returning the new
 * list and record. Does not mutate `list`.
 */
export function updateCustomTuning(
  list: CustomTuning[],
  id: string,
  input: CustomTuningInput,
): Result<{ list: CustomTuning[]; tuning: CustomTuning }> {
  if (!list.some((t) => t.id === id)) {
    return { ok: false, error: `Unknown custom tuning: "${id}".` }
  }
  const validated = validateCustomTuning(input, list, id)
  if (!validated.ok) return validated
  const tuning: CustomTuning = { id, ...validated.value }
  return {
    ok: true,
    value: { list: list.map((t) => (t.id === id ? tuning : t)), tuning },
  }
}

/** Remove a custom tuning by id, returning the new list. Does not mutate. */
export function removeCustomTuning(list: CustomTuning[], id: string): CustomTuning[] {
  return list.filter((t) => t.id !== id)
}

/**
 * Coerce arbitrary persisted data into a clean `CustomTuning[]`, silently
 * dropping any entry that is malformed or out of range. Used as the store's
 * migration/normalization path so corrupt or hand-edited storage degrades to a
 * valid subset instead of crashing.
 */
export function normalizeCustomTunings(value: unknown): CustomTuning[] {
  if (!Array.isArray(value)) return []
  const out: CustomTuning[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string' || !isCustomTuningId(r.id)) continue
    if (typeof r.name !== 'string' || !isInstrument(r.instrument)) continue
    if (!Array.isArray(r.strings)) continue
    const strings = r.strings
    const validated = validateCustomTuning(
      { name: r.name, instrument: r.instrument, strings: strings as Midi[] },
      // Validate uniqueness against what we have accepted so far.
      out,
      r.id,
    )
    if (!validated.ok) continue
    out.push({ id: r.id, ...validated.value })
  }
  return out
}

/**
 * Resolve a tuning id to a concrete `Tuning`: built-ins first, then the custom
 * list, then a safe fallback (the given `fallbackId`, itself resolved as a
 * built-in). This guarantees every tool that persisted a now-deleted custom id
 * still renders something valid.
 */
export function resolveTuning(id: string, customs: CustomTuning[], fallbackId = 'bass-4'): Tuning {
  try {
    return getTuning(id)
  } catch {
    // not a built-in — fall through
  }
  if (isCustomTuningId(id)) {
    const found = customs.find((t) => t.id === id)
    if (found) return toTuning(found)
  }
  return getTuning(fallbackId)
}

/** Custom tunings for one instrument, sorted by string count then name. */
export function customTuningsFor(
  customs: CustomTuning[],
  instrument: FrettedInstrument,
): CustomTuning[] {
  return customs
    .filter((t) => t.instrument === instrument)
    .sort((a, b) => a.strings.length - b.strings.length || a.name.localeCompare(b.name))
}

/** Build a custom-tunings store (tests pass `memoryBackend()`). */
export function createCustomTuningsStore(backend?: StorageBackend): Store<CustomTuning[]> {
  return new Store<CustomTuning[]>(
    {
      key: 'custom-tunings',
      version: 1,
      defaultValue: [],
      migrate: normalizeCustomTunings,
    },
    backend,
  )
}

/** The app-wide custom-tunings store (localStorage-backed). */
export const customTuningsStore = createCustomTuningsStore()
