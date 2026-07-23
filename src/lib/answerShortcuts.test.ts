import { describe, expect, it } from 'vitest'
import { keyToOptionIndex, MAX_SHORTCUT_OPTIONS, shortcutLabel } from './answerShortcuts.ts'

describe('keyToOptionIndex', () => {
  it('maps digits 1–9 to zero-based indices when in range', () => {
    expect(keyToOptionIndex('1', 9)).toBe(0)
    expect(keyToOptionIndex('2', 9)).toBe(1)
    expect(keyToOptionIndex('9', 9)).toBe(8)
  })

  it('returns null for an index at or beyond the option count', () => {
    expect(keyToOptionIndex('5', 4)).toBeNull() // index 4, count 4
    expect(keyToOptionIndex('1', 0)).toBeNull()
    expect(keyToOptionIndex('4', 3)).toBeNull() // index 3, count 3
  })

  it('accepts the last in-range digit', () => {
    expect(keyToOptionIndex('3', 3)).toBe(2) // index 2 is the last valid for 3
    expect(keyToOptionIndex('4', 4)).toBe(3)
  })

  it('ignores 0 and non-digit keys', () => {
    expect(keyToOptionIndex('0', 9)).toBeNull()
    expect(keyToOptionIndex('Enter', 9)).toBeNull()
    expect(keyToOptionIndex('a', 9)).toBeNull()
    expect(keyToOptionIndex(' ', 9)).toBeNull()
    expect(keyToOptionIndex('', 9)).toBeNull()
    expect(keyToOptionIndex('12', 9)).toBeNull()
  })

  it('never maps past nine options even when more exist', () => {
    // '9' is the highest bound key; a 12-option quiz still tops out at index 8.
    expect(keyToOptionIndex('9', 12)).toBe(8)
    expect(MAX_SHORTCUT_OPTIONS).toBe(9)
  })
})

describe('shortcutLabel', () => {
  it('renders a 1-based label for the first nine options', () => {
    expect(shortcutLabel(0)).toBe('1')
    expect(shortcutLabel(8)).toBe('9')
  })

  it('is empty beyond the bound range or for negative indices', () => {
    expect(shortcutLabel(9)).toBe('')
    expect(shortcutLabel(11)).toBe('')
    expect(shortcutLabel(-1)).toBe('')
  })
})
