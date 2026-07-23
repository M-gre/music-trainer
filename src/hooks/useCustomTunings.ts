/**
 * React binding for the user's custom tunings (`src/lib/customTunings.ts`).
 * Reads the persisted list once, exposes it, and offers add/update/remove
 * operations that validate, persist, and update the snapshot.
 *
 * Kept thin: all validation/CRUD logic lives in `customTunings.ts` (pure, fully
 * unit-tested); this hook only wires those helpers to the store and React
 * state. Each hook instance holds its own snapshot — custom tunings only change
 * on the settings page, and other pages re-read the store on mount.
 */

import { useCallback, useState } from 'react'
import {
  addCustomTuning,
  customTuningsStore,
  removeCustomTuning,
  updateCustomTuning,
  type CustomTuning,
  type CustomTuningInput,
  type Result,
} from '../lib/customTunings.ts'

export interface UseCustomTunings {
  /** The current custom-tuning list. */
  tunings: CustomTuning[]
  /** Validate and add a tuning; returns the created record or an error. */
  add: (input: CustomTuningInput) => Result<CustomTuning>
  /** Validate and update a tuning by id; returns the record or an error. */
  update: (id: string, input: CustomTuningInput) => Result<CustomTuning>
  /** Remove a tuning by id. */
  remove: (id: string) => void
}

export function useCustomTunings(): UseCustomTunings {
  const [tunings, setTunings] = useState<CustomTuning[]>(() => customTuningsStore.get())

  const add = useCallback((input: CustomTuningInput): Result<CustomTuning> => {
    const result = addCustomTuning(customTuningsStore.get(), input)
    if (!result.ok) return result
    customTuningsStore.set(result.value.list)
    setTunings(result.value.list)
    return { ok: true, value: result.value.tuning }
  }, [])

  const update = useCallback((id: string, input: CustomTuningInput): Result<CustomTuning> => {
    const result = updateCustomTuning(customTuningsStore.get(), id, input)
    if (!result.ok) return result
    customTuningsStore.set(result.value.list)
    setTunings(result.value.list)
    return { ok: true, value: result.value.tuning }
  }, [])

  const remove = useCallback((id: string) => {
    const next = removeCustomTuning(customTuningsStore.get(), id)
    customTuningsStore.set(next)
    setTunings(next)
  }, [])

  return { tunings, add, update, remove }
}
