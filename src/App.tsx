import { useHashRoute } from './router.ts'
import { Home } from './pages/Home.tsx'
import { NotFound } from './pages/NotFound.tsx'

export interface Tool {
  route: string
  title: string
  description: string
  /** Which instrument(s) the tool targets, shown as badges. */
  tags: string[]
  /** Set when the page component exists; undefined renders a "coming soon" card. */
  page?: () => React.ReactNode
}

/**
 * Registry of all tools. To add a tool: create a page component under
 * src/pages/, register it here, and it appears on the home grid and router.
 */
export const TOOLS: Tool[] = [
  {
    route: '/fretboard-notes',
    title: 'Fretboard Note Trainer',
    description: 'Learn every note on the bass fretboard with quiz modes.',
    tags: ['bass'],
  },
  {
    route: '/keyboard-notes',
    title: 'Keyboard Note Trainer',
    description: 'Learn the keys and their names across octaves.',
    tags: ['piano'],
  },
  {
    route: '/chords',
    title: 'Chord Explorer',
    description: 'Chord shapes and voicings on fretboard and keyboard.',
    tags: ['bass', 'piano'],
  },
  {
    route: '/scales',
    title: 'Scales & Modes',
    description: 'Visualize scales and modes on both instruments.',
    tags: ['bass', 'piano', 'theory'],
  },
  {
    route: '/circle-of-fifths',
    title: 'Circle of Fifths',
    description: 'Interactive circle with key signatures and relative keys.',
    tags: ['theory'],
  },
  {
    route: '/note-reading',
    title: 'Note Reading',
    description: 'Sight-reading drills in bass and treble clef.',
    tags: ['bass', 'piano'],
  },
  {
    route: '/ear-training',
    title: 'Ear Training',
    description: 'Intervals, chord qualities, and melodies by ear.',
    tags: ['ear'],
  },
  {
    route: '/play-along',
    title: 'Play-Along',
    description: 'Drum grooves plus chord progressions in any key and tempo.',
    tags: ['bass', 'piano', 'rhythm'],
  },
  {
    route: '/dexterity',
    title: 'Dexterity Exercises',
    description: 'Spider walks, permutations, and finger independence drills.',
    tags: ['bass', 'piano'],
  },
  {
    route: '/metronome',
    title: 'Metronome',
    description: 'Accents, subdivisions, and tempo trainer.',
    tags: ['rhythm'],
  },
]

export default function App() {
  const route = useHashRoute()

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
      </header>
      <main className="app-main">{content}</main>
    </div>
  )
}
