/**
 * DH EMR Field boot wiring: styles, kernel identity, sync engine init, then
 * render. The root ErrorBoundary sits OUTSIDE App as the backstop; per-tab
 * boundaries live inside the shell.
 *
 * Field has no user accounts: the device is the identity, so there is no
 * session to prime before the sync engine wakes. Shared-key sync sends the
 * publishable key alone (core/sync/keys.ts).
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dh/core/styles/tokens.css'
import '@dh/core/styles/base.css'
import { App } from './App'
import { ErrorBoundary } from '@dh/core/ui/app/ErrorBoundary'
import { setCurrentDeviceId } from '@dh/core/kernel'
import { getDeviceId, syncEngine } from '@dh/core/sync'
import { DemoBanner, bootDemo } from './demo'

// Injected by vite.config define. Literal checks so production builds
// (DH_DEMO unset) compile the demo branches away entirely.
declare const __DH_DEMO__: boolean

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')
const root = createRoot(container)

async function start(): Promise<void> {
  // Demo builds seed the fictional clinic BEFORE anything renders, so the
  // app opens straight into a working clinic (no setup wizard, cloud paths
  // neutered). Blocking is fine: the seed is small and idempotent.
  if (__DH_DEMO__) {
    root.render(<div className="boot">Setting up the demo clinic…</div>)
    try {
      await bootDemo()
    } catch (e) {
      // The shell still boots; a failed seed shows as an unconfigured app
      // rather than a blank page.
      console.error('[demo] seeding failed', e)
    }
  }
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
        {/* Above the shell, so the fictional-clinic notice is visible in
            every boot state, not just the main app. */}
        {__DH_DEMO__ ? <DemoBanner /> : null}
        <App />
      </ErrorBoundary>
    </StrictMode>,
  )
}

void start()
