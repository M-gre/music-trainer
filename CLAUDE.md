# Music Trainer

A fully static, client-side practice site for **bass** (primary) and **piano**
(secondary): note/chord/scale learning, note reading, ear training, dexterity
drills, metronome, and drum + chord-progression play-alongs.

Live site: https://m-gre.github.io/music-trainer/
Deployed automatically from `main` via `.github/workflows/deploy.yml`.

## Commands

- `npm run dev` — dev server
- `npm run check` — typecheck + tests + build. **Must pass before every commit.**
- `npm run test` / `npm run test:watch` — vitest
- `npm run typecheck` — `tsc --noEmit`

## Hard security constraints (do not violate)

The whole point of this site's security posture is having ~zero attack surface:

- **Static only.** No backend, no serverless functions, no forms posting anywhere.
- **No runtime network requests.** No CDNs, no third-party scripts/fonts/analytics,
  no fetch to external hosts. The CSP meta tag in `index.html` enforces this —
  never loosen it.
- **No accounts, no cross-user features.** All state lives in `localStorage`.
- **Minimal dependencies.** Runtime deps are `react` + `react-dom` only. Do not
  add a runtime dependency without a strong reason; prefer writing the code
  (audio synthesis, SVG rendering, music theory) in-repo. Dev deps: keep lean,
  keep `package-lock.json` committed.
- All audio is **synthesized with the Web Audio API** — no bundled samples
  unless unavoidable, never fetched remotely.

## Architecture

- Vite + React + TypeScript (strict). No router library: `src/router.ts` is a
  tiny hash router (`#/route`) — hash routing is required for GitHub Pages
  deep links.
- `src/App.tsx` holds the `TOOLS` registry: every tool has a route, title,
  description, tags, and (once implemented) a `page` component. Adding a tool =
  new page under `src/pages/` + registry entry.
- `src/lib/theory/` — pure, framework-free music theory (notes, intervals,
  scales, chords, spelling, instruments). **Everything musical builds on this;
  keep it pure and fully unit-tested.** Pitches are midi numbers; pitch classes
  are 0–11 (C = 0). Note *spelling* (C# vs Db) is context-dependent — use
  `spell.ts`, don't hardcode sharp names in UI.
- `src/lib/audio/` (to be created) — Web Audio engine: synth voices, drum
  synthesis, scheduler/sequencer (use the lookahead-scheduler pattern, not
  setInterval-per-note), metronome.
- Shared instrument views (to be created): `src/components/Fretboard.tsx` and
  `src/components/Keyboard.tsx` as **SVG** components, reused by all tools —
  render-prop/props-driven (highlighted notes, labels, click handlers), no
  tool-specific logic inside.
- User settings/progress: `localStorage` under keys prefixed `mt:`, via a small
  typed wrapper (to be created in `src/lib/storage.ts`).

## Conventions

- TypeScript strict; no `any`. `noUncheckedIndexedAccess` is on — handle it.
- Pure logic (theory, sequencing, exercise generation, scoring) goes in
  `src/lib/` with vitest coverage; components stay thin. Tests for lib code are
  mandatory; component tests optional.
- Test environment is `node` — lib code must not touch `window`/`document`.
  (Audio code: isolate Web Audio behind an interface so scheduling logic stays
  testable.)
- Mobile matters: tools should be usable on a phone stand next to an amp.
  Test layouts at narrow widths.
- Keep the dark theme and CSS-variable palette in `src/styles.css`.

## Workflow for autonomous sessions

`ROADMAP.md` is the work queue. Each session: pick the next unchecked item
(top to bottom unless instructed otherwise), implement it **completely** —
lib code + tests + UI + registry entry + roadmap checkbox — run
`npm run check`, then commit with a conventional message (`feat: …`, `fix: …`)
and push to `main` (which deploys). One roadmap item per commit. If an item is
too big for one session, split it into sub-items in ROADMAP.md first.
