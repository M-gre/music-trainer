/**
 * Pure key→option-index mapping for the quiz keyboard shortcuts. Number keys
 * 1–9 select multiple-choice answers by position; anything else is ignored.
 * All DOM concerns (attaching the keydown listener, ignoring keystrokes aimed
 * at form fields) live in the `useAnswerShortcuts` hook — this module stays
 * framework- and DOM-free so it is unit-testable in the node test env.
 */

/** The most option shortcuts we bind: the 1–9 number-row keys. */
export const MAX_SHORTCUT_OPTIONS = 9

/**
 * Map a `KeyboardEvent.key` to a zero-based option index, or `null` when the
 * key is not a digit 1–9 or the resulting index is outside the available
 * options. `'1'` → 0, `'2'` → 1, … `'9'` → 8.
 */
export function keyToOptionIndex(key: string, optionCount: number): number | null {
  if (key.length !== 1 || key < '1' || key > '9') return null
  const index = key.charCodeAt(0) - '1'.charCodeAt(0)
  return index < optionCount ? index : null
}

/**
 * The 1-based label to show on the option at `index`, or `''` when the option
 * is beyond the keys we bind (so callers can hide the hint on later options).
 */
export function shortcutLabel(index: number): string {
  return index >= 0 && index < MAX_SHORTCUT_OPTIONS ? String(index + 1) : ''
}
