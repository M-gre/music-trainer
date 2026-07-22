import { LETTER_PC, LETTERS, mod12, type Letter, type PitchClass } from './notes.ts'
import { majorKeySignature } from './scales.ts'

/**
 * Key-aware note spelling. A 7-note scale is spelled with consecutive
 * letters (C D E F G A B rotated to the root), each adjusted with the
 * accidentals needed to hit the right pitch class. This produces correct
 * enharmonics, e.g. F major = F G A Bb C D E (not A#).
 */

/** Spell a single pitch class given a preferred letter. */
function spellWithLetter(pc: PitchClass, letter: Letter): string {
  // Signed distance from the letter's natural pc, in range [-6, 5].
  let diff = mod12(pc - LETTER_PC[letter])
  if (diff > 6) diff -= 12
  const accidental = diff >= 0 ? '#'.repeat(diff) : 'b'.repeat(-diff)
  return letter + accidental
}

/**
 * Spell the notes of a 7-note scale with consecutive letters.
 * `rootLetter` disambiguates enharmonic roots (e.g. F# vs Gb major).
 * If omitted, the letter requiring the simplest root spelling is chosen,
 * preferring flats for flat-side keys.
 */
export function spellScale(rootPc: PitchClass, intervals: number[], rootLetter?: Letter): string[] {
  if (intervals.length !== 7) {
    throw new Error(`spellScale requires 7 intervals, got ${intervals.length}`)
  }
  const letter = rootLetter ?? defaultRootLetter(rootPc)
  const startIndex = LETTERS.indexOf(letter)
  return intervals.map((interval, i) => {
    const noteLetter = LETTERS[(startIndex + i) % 7]!
    return spellWithLetter(mod12(rootPc + interval), noteLetter)
  })
}

/** Choose a sensible letter for a root pitch class (Bb over A#, F# over Gb). */
function defaultRootLetter(pc: PitchClass): Letter {
  // Natural letters spell as themselves.
  const natural = LETTERS.find((l) => LETTER_PC[l] === pc)
  if (natural) return natural
  // Black keys: use flat spelling except F# (pc 6), matching common key names
  // Db Eb F# Ab Bb.
  const flatLetter = LETTERS.find((l) => mod12(LETTER_PC[l] - 1) === pc)!
  const sharpLetter = LETTERS.find((l) => mod12(LETTER_PC[l] + 1) === pc)!
  return pc === 6 ? sharpLetter : flatLetter
}

/**
 * Whether a major key is conventionally written with flats. Used to pick
 * sharp vs flat display names outside of full scale spelling.
 */
export function prefersFlats(majorRoot: PitchClass): boolean {
  return majorKeySignature(majorRoot) < 0
}
