import { describe, expect, it } from 'vitest'
import { bpmFromTaps, MAX_TAPS, registerTap, TAP_RESET_GAP_MS } from './tapTempo.ts'

describe('bpmFromTaps', () => {
  it('returns null with fewer than two taps', () => {
    expect(bpmFromTaps([])).toBeNull()
    expect(bpmFromTaps([1000])).toBeNull()
  })

  it('converts a steady 500ms interval to 120 BPM', () => {
    expect(bpmFromTaps([0, 500, 1000, 1500])).toBe(120)
  })

  it('averages uneven intervals', () => {
    // intervals 400 and 600 -> avg 500 -> 120 BPM
    expect(bpmFromTaps([0, 400, 1000])).toBe(120)
  })

  it('returns null for non-positive average interval (duplicate timestamps)', () => {
    expect(bpmFromTaps([1000, 1000])).toBeNull()
  })
})

describe('registerTap', () => {
  it('does not produce a tempo from the first tap', () => {
    const result = registerTap([], 1000)
    expect(result.taps).toEqual([1000])
    expect(result.bpm).toBeNull()
  })

  it('estimates tempo from a running sequence', () => {
    const result = registerTap([0, 500], 1000)
    expect(result.taps).toEqual([0, 500, 1000])
    expect(result.bpm).toBe(120)
  })

  it('does not mutate the input array', () => {
    const previous = [0, 500]
    registerTap(previous, 1000)
    expect(previous).toEqual([0, 500])
  })

  it('keeps only the most recent MAX_TAPS taps', () => {
    const taps = [0, 100, 200, 300, 400, 500]
    const result = registerTap(taps, 600)
    expect(result.taps.length).toBe(MAX_TAPS)
    expect(result.taps).toEqual([200, 300, 400, 500, 600])
  })

  it('resets after a gap longer than the reset threshold', () => {
    const previous = [0, 500, 1000]
    const result = registerTap(previous, 1000 + TAP_RESET_GAP_MS + 1)
    expect(result.taps).toEqual([1000 + TAP_RESET_GAP_MS + 1])
    expect(result.bpm).toBeNull()
  })

  it('continues when the gap equals the reset threshold exactly', () => {
    const result = registerTap([1000], 1000 + TAP_RESET_GAP_MS)
    expect(result.taps).toEqual([1000, 1000 + TAP_RESET_GAP_MS])
    expect(result.bpm).not.toBeNull()
  })

  it('honours a custom maxTaps and resetGapMs', () => {
    const result = registerTap([0, 100, 200], 300, { maxTaps: 2, resetGapMs: 50 })
    // gap 100 > 50 -> reset to a single tap
    expect(result.taps).toEqual([300])
    expect(result.bpm).toBeNull()
  })
})
