# Roadmap

Work queue for autonomous sessions. Rules: work top to bottom; one item = one
commit; check items off (`[x]`) in the same commit that implements them; keep
`npm run check` green. Split items that are too large before starting them.
When adding ideas, add them as unchecked items in the right milestone.

## M0 — Foundation

- [x] Project scaffold: Vite + React + TS, hash router, tool registry, home grid, CSP, Pages deploy
- [x] Theory core: notes, intervals, scales, chords, diatonic triads, spelling, tunings for bass and guitar (`src/lib/theory/`)
- [x] `src/lib/storage.ts`: typed localStorage wrapper (`mt:` prefix, JSON, versioned, safe on parse errors) with tests
- [x] `Fretboard` SVG component: takes any `Tuning` (bass 4/5-string, guitar 6/7-string, drop tunings) & fret range, note dots with labels, click handler, highlight sets (e.g. scale tones vs root), responsive width
- [ ] Shared instrument picker UI: instrument (bass/guitar) → string count → tuning, persisted as global default via storage lib, used by every fretboard tool
- [ ] `Keyboard` SVG component: configurable octave range, key highlighting with labels, click handler, responsive
- [ ] Audio engine core (`src/lib/audio/`): AudioContext wrapper, simple synth voice (poly, ADSR), `playNote(midi, dur)`, master volume; scheduling logic kept pure/testable
- [ ] Lookahead scheduler for sequencing (tempo, beats, swing-ready), unit-tested with a mock clock
- [ ] Metronome tool page: tempo, time signature, accent on 1, subdivisions, tap tempo

## M1 — Note learning

- [ ] Fretboard Note Trainer: "find note X on string Y" and "name the highlighted fret" quiz modes, fret-range and string filters, score streak, uses Fretboard component with the selected instrument/tuning (bass or guitar)
- [ ] Keyboard Note Trainer: same quiz modes on the Keyboard component
- [ ] Progress stats per note (accuracy, response time) persisted via storage lib; weakest-notes-first question picking
- [ ] Note Reading: render single notes on a staff (SVG, bass + treble clef), answer via fretboard/keyboard/name buttons, ledger lines, key-signature-aware naming
- [ ] Note Reading: timed streak mode and range/clef settings

## M2 — Chords, scales & theory

- [ ] Scales & Modes explorer: pick root + scale, see it on fretboard AND keyboard with degrees/intervals, play ascending/descending audio
- [ ] Chord Explorer: pick root + quality, tones shown on both instruments, arpeggio playback, inversions on keyboard
- [ ] Circle of Fifths: interactive SVG circle — key signatures, relative minors, click a key to see its scale and diatonic chords
- [ ] Diatonic chords view: for a key, show I–vii° with numerals, play them
- [ ] Theory quiz: key signatures, "which chord is the V of X", interval naming

## M3 — Ear training

- [ ] Interval recognition: play interval (melodic/harmonic, asc/desc), multiple choice, per-interval stats, selectable interval set
- [ ] Chord quality recognition: triads + sevenths, root position first, inversions as harder setting
- [ ] Scale/mode recognition quiz
- [ ] Melodic echo: app plays a short diatonic phrase, user plays it back on the on-screen fretboard/keyboard
- [ ] Progressive difficulty levels bundling the above (Level 1: P4/P5/P8 … etc.)

## M4 — Rhythm & play-along

- [ ] Drum synthesis: kick, snare, hi-hat (closed/open), ride via Web Audio (noise + filters + envelopes)
- [ ] Groove engine: pattern format (16-step grid per drum voice), grooves: rock 8ths, rock 16ths, funk, swing/shuffle, bossa, 12/8 blues, half-time
- [ ] Play-Along page: groove picker, tempo slider, count-in, per-voice mute
- [ ] Chord progression accompaniment: pick key + progression (1-5-6-4, 2-5-1, 12-bar blues, custom degree input), synth pad/comping voice, bars-per-chord setting, current-chord display with next-chord preview
- [ ] Progression display shows chord tones on fretboard (for bass lines) while playing
- [ ] Tempo trainer: auto-increase BPM every N bars

## M5 — Dexterity

- [ ] Exercise engine: patterns as fret/finger sequences, rendered on Fretboard with numbered order + metronome sync
- [ ] Bass/guitar exercises: spider walk (1-2-3-4 permutations), string crossing, position shifts — tuning-aware so they render on any fretted instrument
- [ ] Permutation generator: all 24 finger orderings, random daily set
- [ ] Piano exercises: 5-finger patterns, scale fingerings with correct finger numbers displayed on Keyboard

## M6 — Polish

- [ ] Practice dashboard: streaks, per-tool stats, suggested daily routine
- [ ] Spaced repetition for all quiz tools (shared lib)
- [ ] PWA manifest + service worker for full offline use (self-contained, CSP-compatible)
- [ ] Keyboard shortcuts for quiz answering; accessibility pass (focus, ARIA, contrast)
- [ ] Settings page: default instrument/tuning (bass & guitar, all string counts), left-handed fretboard flip, sharps/flats preference, volume
- [ ] Custom tuning editor: define and save arbitrary tunings (name + per-string pitch) alongside the built-ins
