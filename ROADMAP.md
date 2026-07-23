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
- [x] Shared instrument picker UI: instrument (bass/guitar) → string count → tuning, persisted as global default via storage lib, used by every fretboard tool
- [x] `Keyboard` SVG component: configurable octave range, key highlighting with labels, click handler, responsive
- [x] Audio engine core (`src/lib/audio/`): AudioContext wrapper, simple synth voice (poly, ADSR), `playNote(midi, dur)`, master volume; scheduling logic kept pure/testable
- [x] Lookahead scheduler for sequencing (tempo, beats, swing-ready), unit-tested with a mock clock
- [x] Metronome tool page: tempo, time signature, accent on 1, subdivisions, tap tempo

## M1 — Note learning

- [x] Fretboard Note Trainer: "find note X on string Y" and "name the highlighted fret" quiz modes, fret-range and string filters, score streak, uses Fretboard component with the selected instrument/tuning (bass or guitar)
- [x] Keyboard Note Trainer: same quiz modes on the Keyboard component
- [x] Note trainer expansion (fretboard + keyboard): freely adjustable quiz range (custom fret span min/max on fretboard, custom key range on keyboard — not just presets); new quiz mode "find ALL instances": every position matching the prompted note in the selected range must be clicked, found ones stay marked, complete when all are found (fretboard: all strings/frets in range; keyboard: all octaves in range)
- [x] Progress stats per note (accuracy, response time) persisted via storage lib; weakest-notes-first question picking
- [x] Note Reading: render single notes on a staff (SVG, bass + treble clef), answer via fretboard/keyboard/name buttons, ledger lines, key-signature-aware naming
- [x] Note Reading: timed streak mode and range/clef settings

## M2 — Chords, scales & theory

- [x] Scales & Modes explorer: pick root + scale, see it on fretboard AND keyboard with degrees/intervals, play ascending/descending audio
- [x] Chord Explorer: pick root + quality, tones shown on both instruments, arpeggio playback, inversions on keyboard
- [x] Circle of Fifths: interactive SVG circle — key signatures, relative minors, click a key to see its scale and diatonic chords
- [x] Circle of Fifths instrument views: when a key is selected, show its scale on the Fretboard (global tuning) and Keyboard components inside the detail panel — reuse the Scales explorer's marker building; toggle major scale / relative minor; keeps the circle usable as a fretboard/keyboard learning hub
- [x] Diatonic chords view: for a key, show I–vii° with numerals, play them
- [x] Theory quiz: key signatures, "which chord is the V of X", interval naming
- [x] Extend built-in tunings: bass (BEAD, D standard, half-step down, tenor EADG+5th) and guitar (Eb/half-step down, D standard, drop C, open G, open D, open E, 8-string); keep picker grouping by string count sensible as the list grows

## M3 — Ear training

- [x] Interval recognition: play interval (melodic/harmonic, asc/desc), multiple choice, per-interval stats, selectable interval set
- [x] Chord quality recognition: triads + sevenths, root position first, inversions as harder setting
- [x] Scale/mode recognition quiz
- [x] Melodic echo: app plays a short diatonic phrase, user plays it back on the on-screen fretboard/keyboard
- [x] Progressive difficulty levels bundling the above (Level 1: P4/P5/P8 … etc.)

## M4 — Rhythm & play-along

- [x] Metronome sound & accent upgrade: selectable click sounds synthesized via Web Audio (e.g. soft woodblock, sine blip, rim tick, classic beep — current square click is harsh), volume-balanced presets; per-beat accent editor — tap a beat dot to cycle its accent level (off / low / mid / high), persisted with the other metronome settings
- [x] Drum synthesis: kick, snare, hi-hat (closed/open), ride via Web Audio (noise + filters + envelopes)
- [x] Groove engine: pattern format (16-step grid per drum voice), grooves: rock 8ths, rock 16ths, funk, swing/shuffle, bossa, 12/8 blues, half-time
- [x] Play-Along page: groove picker, tempo slider, count-in, per-voice mute
- [x] Chord progression accompaniment: pick key + progression (1-5-6-4, 2-5-1, 12-bar blues, custom degree input), synth pad/comping voice, bars-per-chord setting, current-chord display with next-chord preview
- [x] Progression display shows chord tones on fretboard (for bass lines) while playing
- [x] Tempo trainer: auto-increase BPM every N bars

## M5 — Dexterity

- [x] Exercise engine: patterns as fret/finger sequences, rendered on Fretboard with numbered order + metronome sync
- [x] Bass/guitar exercises: spider walk (1-2-3-4 permutations), string crossing, position shifts — tuning-aware so they render on any fretted instrument
- [x] Permutation generator: all 24 finger orderings, random daily set
- [x] Scale-sequence drills: run any scale through sequence patterns (diatonic 3rds and 4ths, groups-of-3, groups-of-4, up-and-back) in a position, rendered with fingering and metronome sync
- [x] Arpeggio drills: triad and 7th-chord arpeggios across strings and positions (root position + inversions), tuning-aware
- [x] Rhythm variation layer: apply rhythm patterns to any exercise — straight, triplets, gallop (1e&a variants), dotted, offbeat starts — plus accent-every-N-notes displacement drills
- [x] Dexterity UX audit & rework: the page is verbose relative to how few distinct exercises it offers — the pattern list is a wall of paragraph-length cards, and the "Daily permutations" panel occupies a whole column duplicating what is really a spider-walk parameter. Rework the information architecture: (1) selection becomes compact — one-line entries (name + short tagline), full description shown only for the currently selected drill; (2) fold the five hand-picked spider-walk variants and the permutations panel into ONE "Spider walk" drill with a finger-order parameter (dropdown of all 24 orderings, "today's 4" surfaced as suggested chips, keep the daily-set rotation logic); (3) dedupe/merge drills that differ only by parameters, so the catalog reads as a small number of exercise TYPES, each with parameters; (4) group the settings controls (instrument/fret/tempo/rhythm/accent/direction/auto-advance) into a tighter, collapsible or two-row layout — currently seven loose boxes; (5) verify at 390px. While reworking, add one or two genuinely new exercise TYPES not covered elsewhere in this milestone (e.g. finger rolls — same fret rolled across adjacent strings, great for bass — and trill/burst drills — rapid two-finger alternation per string pair); keep the existing exercise-engine/lib code and its tests, this is primarily a UI/IA rework plus new pattern definitions; migrate dexteritySettings if stored fields change
- [x] Stretch & finger-independence drills: wide-stretch patterns (1-2-4, 1-3-4, 5-fret spans), hold-anchor-finger drills, legato patterns (hammer-on/pull-off sequences shown with slur marking)
- [x] Warm-up routine builder: compose a timed daily routine from selected exercises (per-exercise duration/loops, auto-advance to the next exercise, total time display), persist favorite routines
- [ ] Piano exercises: 5-finger patterns, scale fingerings with correct finger numbers displayed on Keyboard

## M6 — Polish

- [x] Practice dashboard: streaks, per-tool stats, suggested daily routine
- [x] Spaced repetition: shared lib (`src/lib/spacedRepetition.ts`, SM-2-style scheduler) + wire into the note trainers (fretboard + keyboard)
- [x] Spaced repetition: wire into ear-training modes (interval, chord quality, scale recognition)
- [x] Spaced repetition: wire into note reading + theory quiz
- [x] PWA manifest + service worker for full offline use (self-contained, CSP-compatible)
- [x] Keyboard shortcuts + accessibility pass for the quiz tools (Ear Training, Theory Quiz, Note Reading, Fretboard/Keyboard Note Trainers) and Home: number-key answer selection via `useAnswerShortcuts` + `src/lib/answerShortcuts.ts`, global `:focus-visible` ring, `aria-live` feedback, `aria-label`/`aria-pressed` on controls; dim-text contrast verified against WCAG AA
- [x] Accessibility pass for the explorers & remaining pages (Scales, Chord Explorer, Circle of Fifths, Diatonic Chords, Metronome, Play-Along, Dexterity, Practice Dashboard, Settings): focus, ARIA, contrast — plus ARIA on the shared Fretboard/Keyboard/Staff SVG components (focusable hit targets, roles/labels)
- [ ] Sound audit: replace the plain dual-oscillator synth with more natural instrument voices — evaluate Karplus-Strong string synthesis for bass/guitar pluck, FM or additive synthesis for a piano-like tone, per-tool voice selection (which tool uses which voice), and consistent levels across voices; self-hosted tiny samples only as a last resort (must stay offline/CSP-clean, no CDN or runtime fetching)
- [ ] Mobile/touch audit: 44px minimum tap targets on fretboard/keyboard hit areas, remove hover-only affordances, touch-action on controls, verify each tool at 390px width
- [x] Visual overlap audit: screenshot every tool (desktop + 390px) and fix overlapping/colliding elements — known offenders: fretboard marker dots covering fret numbers and inlay dots, keyboard octave labels (C3/C4…) hidden behind marker dots on white keys; establish spacing rules (labels never under markers, numbers in reserved gutters) in the shared components so all tools inherit the fix
- [x] Settings page: default instrument/tuning (bass & guitar, all string counts), left-handed fretboard flip, sharps/flats preference, volume
- [ ] Apply sharps/flats preference in remaining tools (currently only default Fretboard/Keyboard note-name labels honor it; tools that pass explicit spelled labels — scales, chords, note reading, etc. — still ignore the global preference)
- [ ] Front-page rework: the home grid has grown to 14 uniform tiles — group tools into sections (e.g. Learn / Train / Play / Reference), surface the practice dashboard's streak + suggested routine at the top, show recently-used tools first within their group, give Settings a distinct low-key placement (e.g. header gear icon), keep it scannable on a phone (390px)
- [x] Custom tuning editor: define and save arbitrary tunings (name + per-string pitch) alongside the built-ins
