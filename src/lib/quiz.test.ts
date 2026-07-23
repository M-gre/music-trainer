import { describe, expect, it } from 'vitest'
import { emptyStats, FindAllSession, pickAvoiding, QuizSession, type Rng } from './quiz.ts'

/** Deterministic rng returning the supplied values in order, then looping. */
function seq(...values: number[]): Rng {
  let i = 0
  return () => {
    const v = values[i % values.length]!
    i += 1
    return v
  }
}

/** Deterministic clock advancing by `step` ms per call, starting at `start`. */
function fakeClock(start: number, step: number): () => number {
  let t = start
  return () => {
    const now = t
    t += step
    return now
  }
}

describe('pickAvoiding', () => {
  it('throws on an empty list', () => {
    expect(() => pickAvoiding([], null, seq(0))).toThrow()
  })

  it('picks by index from rng when nothing to avoid', () => {
    expect(pickAvoiding(['a', 'b', 'c'], null, seq(0))).toBe('a')
    expect(pickAvoiding(['a', 'b', 'c'], null, seq(0.5))).toBe('b')
    expect(pickAvoiding(['a', 'b', 'c'], null, seq(0.99))).toBe('c')
  })

  it('never returns the avoided item when an alternative exists', () => {
    // rng 0 would normally pick index 0 ('a'); with 'a' filtered out it picks 'b'.
    expect(pickAvoiding(['a', 'b', 'c'], 'a', seq(0))).toBe('b')
  })

  it('returns the avoided item when it is the only choice', () => {
    expect(pickAvoiding(['a'], 'a', seq(0))).toBe('a')
  })

  it('uses a custom equality for avoidance', () => {
    const items = [{ id: 1 }, { id: 2 }]
    const eq = (a: { id: number }, b: { id: number }) => a.id === b.id
    expect(pickAvoiding(items, { id: 1 }, seq(0), eq)).toEqual({ id: 2 })
  })

  it('clamps an rng value of 1 to the last index', () => {
    expect(pickAvoiding(['a', 'b'], null, seq(1))).toBe('b')
  })
})

describe('emptyStats', () => {
  it('is all zero with no average', () => {
    expect(emptyStats()).toEqual({
      answered: 0,
      correct: 0,
      incorrect: 0,
      streak: 0,
      bestStreak: 0,
      averageResponseMs: null,
    })
  })

  it('returns a fresh object each call', () => {
    expect(emptyStats()).not.toBe(emptyStats())
  })
})

describe('QuizSession', () => {
  // A trivial number quiz: questions are the numbers 1,2,3,...; the correct
  // answer equals the question. `generate` avoids repeating the previous.
  function numberSession(rng: Rng, clock?: () => number) {
    let n = 0
    return new QuizSession<number, number>({
      generate: (previous) => {
        n += 1
        return previous === n ? n + 1 : n
      },
      check: (q, a) => q === a,
      rng,
      clock,
    })
  }

  it('starts with no current question and empty stats', () => {
    const s = numberSession(seq(0))
    expect(s.current).toBeNull()
    expect(s.lastResult).toBeNull()
    expect(s.stats).toEqual(emptyStats())
  })

  it('throws if answered before next()', () => {
    const s = numberSession(seq(0))
    expect(() => s.answer(1)).toThrow()
  })

  it('presents a question on next()', () => {
    const s = numberSession(seq(0))
    expect(s.next()).toBe(1)
    expect(s.current).toBe(1)
    expect(s.isAnswered).toBe(false)
  })

  it('grades a correct answer and increments streak', () => {
    const s = numberSession(seq(0))
    s.next()
    const result = s.answer(1)
    expect(result.correct).toBe(true)
    expect(s.stats).toMatchObject({ answered: 1, correct: 1, incorrect: 0, streak: 1, bestStreak: 1 })
    expect(s.isAnswered).toBe(true)
  })

  it('grades an incorrect answer and resets streak', () => {
    const s = numberSession(seq(0))
    s.next()
    s.answer(1) // correct -> streak 1
    s.next()
    const result = s.answer(999) // wrong
    expect(result.correct).toBe(false)
    expect(s.stats).toMatchObject({ answered: 2, correct: 1, incorrect: 1, streak: 0, bestStreak: 1 })
  })

  it('tracks best streak across a reset of the current streak', () => {
    const s = numberSession(seq(0))
    for (let i = 0; i < 3; i++) {
      const q = s.next()
      s.answer(q) // 3 correct
    }
    expect(s.stats.streak).toBe(3)
    expect(s.stats.bestStreak).toBe(3)
    s.next()
    s.answer(-1) // wrong
    expect(s.stats.streak).toBe(0)
    expect(s.stats.bestStreak).toBe(3)
  })

  it('is idempotent: answering the current question twice does not re-grade', () => {
    const s = numberSession(seq(0))
    s.next()
    const first = s.answer(1) // correct
    const second = s.answer(999) // ignored
    expect(second).toBe(first)
    expect(s.stats).toMatchObject({ answered: 1, correct: 1, streak: 1 })
  })

  it('captures response time from the injected clock', () => {
    const s = numberSession(seq(0), fakeClock(1000, 250))
    s.next() // presentedAt = 1000
    const result = s.answer(1) // clock -> 1250
    expect(result.responseMs).toBe(250)
    expect(s.stats.averageResponseMs).toBe(250)
  })

  it('reports null response time without a clock', () => {
    const s = numberSession(seq(0))
    s.next()
    expect(s.answer(1).responseMs).toBeNull()
    expect(s.stats.averageResponseMs).toBeNull()
  })

  it('averages response time over graded answers', () => {
    // Scripted clock: present=1000, answer=1100 (100ms); present=1200,
    // answer=1500 (300ms). Mean = 200ms.
    const times = [1000, 1100, 1200, 1500]
    let i = 0
    const clock = () => times[i++]!
    const s = numberSession(seq(0), clock)
    s.next()
    s.answer(1)
    s.next()
    s.answer(-1)
    expect(s.stats.averageResponseMs).toBe(200)
  })

  it('avoids an immediate repeat via the generator', () => {
    // generate() bumps n each call; passing previous lets it skip a repeat.
    const s = numberSession(seq(0))
    const q1 = s.next()
    const q2 = s.next()
    expect(q2).not.toBe(q1)
  })

  it('reset() clears stats and current question', () => {
    const s = numberSession(seq(0))
    s.next()
    s.answer(1)
    s.reset()
    expect(s.current).toBeNull()
    expect(s.lastResult).toBeNull()
    expect(s.stats).toEqual(emptyStats())
  })
})

describe('FindAllSession', () => {
  // Each question is a pitch class 0..2; its targets are the string keys with
  // that class in a fixed board: pc 0 -> ['a','b'], pc 1 -> ['c'], pc 2 -> ['d'].
  const targets: Record<number, string[]> = { 0: ['a', 'b'], 1: ['c'], 2: ['d'] }
  function pcSession(rng: Rng) {
    let n = -1
    return new FindAllSession<number, string>({
      generate: (previous) => {
        n = (n + 1) % 3
        return previous === n ? (n + 1) % 3 : n
      },
      targetsOf: (q) => targets[q]!,
      keyOf: (a) => a,
      rng,
    })
  }

  it('starts empty and presents a question with its targets on next()', () => {
    const s = pcSession(seq(0))
    expect(s.current).toBeNull()
    expect(s.stats).toEqual(emptyStats())
    expect(s.next()).toBe(0)
    expect(s.progress).toEqual({ found: 0, total: 2, mistakes: 0, complete: false })
    expect(s.foundKeys).toEqual([])
  })

  it('throws if submit is called before next()', () => {
    const s = pcSession(seq(0))
    expect(() => s.submit('a')).toThrow()
  })

  it('marks a newly found target and tracks progress', () => {
    const s = pcSession(seq(0))
    s.next() // pc 0, targets a,b
    const res = s.submit('a')
    expect(res.outcome).toBe('found')
    expect(res.justCompleted).toBe(false)
    expect(res.progress).toEqual({ found: 1, total: 2, mistakes: 0, complete: false })
    expect(s.foundKeys).toEqual(['a'])
  })

  it('treats an already-found target as a no-op', () => {
    const s = pcSession(seq(0))
    s.next()
    s.submit('a')
    const again = s.submit('a')
    expect(again.outcome).toBe('already')
    expect(again.progress.found).toBe(1)
    expect(again.progress.mistakes).toBe(0)
  })

  it('counts a non-target click as a mistake without un-finding anything', () => {
    const s = pcSession(seq(0))
    s.next()
    s.submit('a')
    const wrong = s.submit('z')
    expect(wrong.outcome).toBe('wrong')
    expect(wrong.progress).toEqual({ found: 1, total: 2, mistakes: 1, complete: false })
  })

  it('completes the round and flags justCompleted only once', () => {
    const s = pcSession(seq(0))
    s.next() // pc 0, targets a,b
    expect(s.submit('a').justCompleted).toBe(false)
    const done = s.submit('b')
    expect(done.justCompleted).toBe(true)
    expect(done.progress.complete).toBe(true)
    expect(s.isComplete).toBe(true)
    // Extra clicks after completion neither re-complete nor add mistakes.
    const after = s.submit('z')
    expect(after.justCompleted).toBe(false)
    expect(after.progress.mistakes).toBe(0)
  })

  it('counts a clean round toward the streak', () => {
    const s = pcSession(seq(0))
    s.next()
    s.submit('a')
    s.submit('b')
    expect(s.stats).toMatchObject({ answered: 1, correct: 1, incorrect: 0, streak: 1, bestStreak: 1 })
  })

  it('a round with any mistake completes but breaks the streak', () => {
    const s = pcSession(seq(0))
    s.next() // pc 0
    s.submit('a')
    s.submit('b') // clean -> streak 1
    s.next() // pc 1, target c
    s.submit('z') // mistake
    s.submit('c') // completes with a mistake
    expect(s.stats).toMatchObject({ answered: 2, correct: 1, incorrect: 1, streak: 0, bestStreak: 1 })
  })

  it('a single-target round completes in one correct click', () => {
    const s = pcSession(seq(0))
    s.next() // pc 0
    s.submit('a')
    s.submit('b')
    s.next() // pc 1, single target c
    const done = s.submit('c')
    expect(done.justCompleted).toBe(true)
  })

  it('reset() clears rounds and current question', () => {
    const s = pcSession(seq(0))
    s.next()
    s.submit('a')
    s.reset()
    expect(s.current).toBeNull()
    expect(s.foundKeys).toEqual([])
    expect(s.stats).toEqual(emptyStats())
  })
})
