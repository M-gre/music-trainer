import { useEffect } from 'react'
import { useHashRoute } from './router.ts'
import { recordToolVisit } from './lib/recentTools.ts'
import { Home } from './pages/Home.tsx'
import { NotFound } from './pages/NotFound.tsx'
import { Metronome } from './pages/Metronome.tsx'
import { FretboardNoteTrainer } from './pages/FretboardNoteTrainer.tsx'
import { KeyboardNoteTrainer } from './pages/KeyboardNoteTrainer.tsx'
import { CircleOfFifths } from './pages/CircleOfFifths.tsx'
import { DiatonicChords } from './pages/DiatonicChords.tsx'
import { TheoryQuiz } from './pages/TheoryQuiz.tsx'
import { NoteReading } from './pages/NoteReading.tsx'
import { ScalesExplorer } from './pages/ScalesExplorer.tsx'
import { ChordExplorer } from './pages/ChordExplorer.tsx'
import { EarTraining } from './pages/EarTraining.tsx'
import { Dexterity } from './pages/Dexterity.tsx'
import { PlayAlong } from './pages/PlayAlong.tsx'
import { PracticeDashboard } from './pages/PracticeDashboard.tsx'
import { SettingsPage } from './pages/SettingsPage.tsx'

/**
 * Home-page grouping. Tools without a section (dashboard, settings) never
 * appear as grid tiles: the dashboard is surfaced as the streak strip and
 * Settings lives in the header gear icon.
 */
export type ToolSection = 'learn' | 'train' | 'play'

export interface Tool {
  route: string
  title: string
  description: string
  /** Which instrument(s) the tool targets, shown as badges. */
  tags: string[]
  /** Which home-page group this tool belongs to; omitted = not shown in grid. */
  section?: ToolSection
  /** Set when the page component exists; undefined renders a "coming soon" card. */
  page?: () => React.ReactNode
}

/** Home-page sections in render order, with their display headings. */
export const TOOL_SECTIONS: Array<{ id: ToolSection; title: string; blurb: string }> = [
  { id: 'learn', title: 'Learn', blurb: 'Explore how notes, scales and chords fit together.' },
  { id: 'train', title: 'Train', blurb: 'Drill your recall, reading and ear.' },
  { id: 'play', title: 'Play', blurb: 'Grooves, progressions and a metronome to play over.' },
]

/**
 * Registry of all tools. To add a tool: create a page component under
 * src/pages/, register it here, and it appears on the home grid and router.
 */
export const TOOLS: Tool[] = [
  {
    route: '/dashboard',
    title: 'Practice Dashboard',
    description: 'Your streak, per-tool stats, and a suggested daily routine.',
    tags: ['progress'],
    page: () => <PracticeDashboard />,
  },
  {
    route: '/fretboard-notes',
    title: 'Fretboard Note Trainer',
    description: 'Learn every note on the fretboard with quiz modes, for any bass or guitar tuning.',
    tags: ['bass', 'guitar'],
    section: 'train',
    page: () => <FretboardNoteTrainer />,
  },
  {
    route: '/keyboard-notes',
    title: 'Keyboard Note Trainer',
    description: 'Learn the keys and their names across octaves.',
    tags: ['piano'],
    section: 'train',
    page: () => <KeyboardNoteTrainer />,
  },
  {
    route: '/chords',
    title: 'Chord Explorer',
    description: 'Chord shapes and voicings on fretboard and keyboard.',
    tags: ['bass', 'guitar', 'piano'],
    section: 'learn',
    page: () => <ChordExplorer />,
  },
  {
    route: '/scales',
    title: 'Scales & Modes',
    description: 'Visualize scales and modes on fretboard and keyboard.',
    tags: ['bass', 'guitar', 'piano', 'theory'],
    section: 'learn',
    page: () => <ScalesExplorer />,
  },
  {
    route: '/circle-of-fifths',
    title: 'Circle of Fifths',
    description: 'Interactive circle with key signatures and relative keys.',
    tags: ['theory'],
    section: 'learn',
    page: () => <CircleOfFifths />,
  },
  {
    route: '/diatonic-chords',
    title: 'Diatonic Chords',
    description: 'Every chord that lives in a key, with roman numerals.',
    tags: ['theory', 'piano', 'bass', 'guitar'],
    section: 'learn',
    page: () => <DiatonicChords />,
  },
  {
    route: '/theory-quiz',
    title: 'Theory Quiz',
    description: 'Key signatures, diatonic chords, and intervals.',
    tags: ['theory'],
    section: 'train',
    page: () => <TheoryQuiz />,
  },
  {
    route: '/note-reading',
    title: 'Note Reading',
    description: 'Sight-reading drills in bass and treble clef.',
    tags: ['bass', 'piano'],
    section: 'train',
    page: () => <NoteReading />,
  },
  {
    route: '/ear-training',
    title: 'Ear Training',
    description: 'Intervals, chord qualities, and melodies by ear.',
    tags: ['ear'],
    section: 'train',
    page: () => <EarTraining />,
  },
  {
    route: '/play-along',
    title: 'Play-Along',
    description: 'Drum grooves plus chord progressions in any key and tempo.',
    tags: ['bass', 'piano', 'rhythm'],
    section: 'play',
    page: () => <PlayAlong />,
  },
  {
    route: '/dexterity',
    title: 'Dexterity Exercises',
    description: 'Spider walks, permutations, and finger independence drills.',
    tags: ['bass', 'guitar', 'piano'],
    section: 'train',
    page: () => <Dexterity />,
  },
  {
    route: '/metronome',
    title: 'Metronome',
    description: 'Accents, subdivisions, and tempo trainer.',
    tags: ['rhythm'],
    section: 'play',
    page: () => <Metronome />,
  },
  {
    route: '/settings',
    title: 'Settings',
    description: 'Default instrument, left-handed fretboard, note spelling, and volume.',
    tags: ['settings'],
    page: () => <SettingsPage />,
  },
]

export default function App() {
  const route = useHashRoute()

  // Record a visit whenever we land on a real tool page, so the home grid can
  // float recently-used tools to the top of their section.
  useEffect(() => {
    if (TOOLS.some((t) => t.route === route && t.page)) recordToolVisit(route)
  }, [route])

  let content: React.ReactNode
  if (route === '/') {
    content = <Home />
  } else {
    const tool = TOOLS.find((t) => t.route === route)
    content = tool?.page ? tool.page() : <NotFound route={route} known={!!tool} />
  }

  return (
    <div className="app">
      <header className="app-header">
        <a href="#/" className="app-title">
          ♩ Music Trainer
        </a>
        <a href="#/settings" className="app-gear" aria-label="Settings" title="Settings">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"
            />
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.4 13a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V19a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H5a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H11a1.7 1.7 0 0 0 1.03-1.56V5a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V11a1.7 1.7 0 0 0 1.56 1.03H23a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z"
            />
          </svg>
        </a>
      </header>
      <main className="app-main">{content}</main>
    </div>
  )
}
