/**
 * Binds number-key (1–9) and Enter shortcuts for quiz answering. The pure
 * key→index mapping lives in `src/lib/answerShortcuts.ts`; this hook owns only
 * the DOM wiring: a window `keydown` listener (with cleanup) that ignores
 * keystrokes aimed at form fields and modified chords, then delegates.
 *
 * Callers pass the live option count plus callbacks. When `enabled` is false
 * (or the count is 0 with no `onNext`) no listener is attached, so pages can
 * turn shortcuts off while an answer is locked / a control is focused.
 */

import { useEffect } from 'react'
import { keyToOptionIndex } from '../lib/answerShortcuts.ts'

export interface AnswerShortcutsOptions {
  /** Number of selectable options; keys 1..min(N,9) map to indices 0..N-1. */
  optionCount: number
  /** Called with the chosen option index when a digit key matches. */
  onSelect: (index: number) => void
  /** Optional Enter handler, e.g. advance to the next question. */
  onNext?: () => void
  /** Attach listeners only while true (default true). */
  enabled?: boolean
}

/** True when the event targets a form control we must not hijack. */
function isFormFieldTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

export function useAnswerShortcuts({
  optionCount,
  onSelect,
  onNext,
  enabled = true,
}: AnswerShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (isFormFieldTarget(event.target)) return
      if (event.key === 'Enter') {
        if (onNext) {
          event.preventDefault()
          onNext()
        }
        return
      }
      const index = keyToOptionIndex(event.key, optionCount)
      if (index !== null) {
        event.preventDefault()
        onSelect(index)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [optionCount, onSelect, onNext, enabled])
}
