/**
 * Boot wiring: styles, kernel identity, sync engine init, then render. The
 * root ErrorBoundary sits OUTSIDE App as the backstop; per-tab boundaries
 * live inside the shell.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import { App } from './App'
import { ErrorBoundary } from './ui/app/ErrorBoundary'
import { setCurrentDeviceId } from './kernel'
import { getDeviceId, syncEngine } from './sync'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')
const root = createRoot(container)

async function start(): Promise<void> {
  // Publish the stored device identity so record saves and the first sync
  // cycle see it. A missing id just means an unregistered device.
  try {
    const id = await getDeviceId()
    if (id) setCurrentDeviceId(id)
  } catch {
    /* unregistered */
  }
  try {
    await syncEngine.init()
  } catch (e) {
    // The shell still boots; the chip will show the true (disabled) state.
    console.warn('[boot] sync engine init failed', e)
  }
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void start()
