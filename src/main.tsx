import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the service worker for offline use. Guarded to production builds
// only: in dev, public/sw.js still has its precache placeholder unfilled
// (see vite.config.ts / src/lib/build/precache.ts), so registering it there
// would just install an empty, effectively inert worker for no benefit.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline support is a progressive enhancement — a registration
      // failure (e.g. an unsupported browser) should never break the app.
    })
  })
}
