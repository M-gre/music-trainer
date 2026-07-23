# Music Trainer

Practice tools for **bass**, **guitar**, and **piano** that run entirely in
your browser — no account, no tracking, no server, works offline once loaded.

**Live site: https://m-gre.github.io/music-trainer/**

## Tools

| Tool | What it does |
| --- | --- |
| Fretboard Note Trainer | Learn every note on the neck — find-the-note, name-the-note, and find-all-instances quiz modes, any tuning, per-note progress stats with weakest-first questions |
| Keyboard Note Trainer | The same quiz modes on a piano keyboard |
| Note Reading | Sight-reading drills on a real staff (bass & treble clef), answer on the fretboard, keyboard, or by name; practice and timed streak modes |
| Chord Explorer | Any chord across the whole neck and as keyboard voicings with inversions, chord and arpeggio playback |
| Scales & Modes | Every scale/mode on fretboard and keyboard with note names or degrees, ascending/descending playback |
| Circle of Fifths | Interactive circle with key signatures, relative minors, spelled scales, diatonic chords, and instrument views |
| Diatonic Chords | All seven chords of a key with roman numerals, playable, plus common progressions |
| Theory Quiz | Key signatures, "what's the V of X", and interval naming |
| Ear Training | Interval, chord-quality, and scale recognition plus melodic echo — with per-question stats |
| Play-Along | Seven synthesized drum grooves with tempo, count-in, per-voice mute, and chord-progression accompaniment (pick a key and a progression like 1-5-6-4, or type your own) |
| Dexterity | Spider walks, string-crossing and position-shift drills with finger numbers on the fretboard, metronome-synced, daily finger-permutation sets |
| Metronome | Four click sounds, subdivisions, tap tempo, and a per-beat accent editor |

Everything is playable on a phone next to an amp: touch-sized controls,
responsive layouts, dark theme.

## Design principles

- **Zero attack surface.** Fully static site: no backend, no accounts, no
  analytics, no external requests of any kind (enforced by a strict CSP).
  All state lives in your browser's localStorage.
- **Everything synthesized.** All audio — instrument tones, drum kit,
  metronome clicks — is generated live with the Web Audio API. No samples,
  nothing fetched.
- **Minimal dependencies.** React is the only runtime dependency; music
  theory, notation rendering, and audio synthesis are implemented in-repo
  and unit-tested (900+ tests).

## Development

```sh
npm ci
npm run dev     # dev server
npm run check   # typecheck + tests + build — must be green before commits
```

Vite + React + TypeScript (strict). Pure logic lives in `src/lib/` with
vitest coverage; shared SVG instrument views in `src/components/`; each tool
is a page in `src/pages/` registered in `src/App.tsx`. See `CLAUDE.md` for
conventions and `ROADMAP.md` for what's planned next. Deployment to GitHub
Pages is automatic on push to `main`.

## License

[MIT](LICENSE). The clef glyph outlines embedded in the staff renderer are
public-domain shapes from Wikimedia Commons.
