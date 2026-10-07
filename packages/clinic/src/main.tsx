/**
 * DH EMR Clinic boot wiring: styles, kernel identity, auth session, sync
 * engine init, then render. The root ErrorBoundary sits OUTSIDE App as the
 * backstop; per-tab boundaries live inside the shell.
 *
 * Demo builds (DH_DEMO=1) take a different road, entirely behind the
 * build-time literal: the demo module is loaded with a dynamic import
 * inside that branch, so a production build carries none of it. The demo
 * seeds a fictional clinic day, hands the shell a simulated account
 * (src/demo/gate.ts) and wraps it in the demo chrome; the auth session and
 * the sync engine are never started in it (demo safety law 4: the demo can
 * never sync).
 */
import { StrictMode, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@dh/core/styles/tokens.css'
import '@dh/core/styles/base.css'
import { App } from './App'
import { ErrorBoundary } from '@dh/core/ui/app/ErrorBoundary'
import { setCurrentDeviceId } from '@dh/core/kernel'
import { getDeviceId, syncEngine } from '@dh/core/sync'
import { authSession } from '@dh/core/auth'
import type { DemoAppHooks } from './demo/gate'

// Injected by vite.config define. Literal checks so production builds
// (DH_DEMO unset) compile the demo branches away entirely.
declare const __DH_DEMO__: boolean

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')
const root = createRoot(container)

interface DemoBoot {
  hooks: DemoAppHooks
  Shell: ComponentType<{ children: ReactNode }>
}

async function start(): Promise<void> {
  let demo: DemoBoot | null = null
  if (__DH_DEMO__) {
    // Demo builds neuter every cloud path and seed the fictional clinic day
    // BEFORE anything renders, so the app opens straight into a working
    // clinic as the simulated seat (no setup wizard, no sign-in).
    root.render(<div className="boot">Setting up the demo clinic…</div>)
    try {
      const mod = await import('./demo')
      await mod.bootDemo()
      demo = { hooks: mod.createDemoAppHooks(), Shell: mod.DemoShell }
    } catch (e) {
      // The shell still boots; a failed demo boot shows as an unconfigured
      // app (whose cloud paths the guard refuses) rather than a blank page.
      console.error('[demo] boot failed', e)
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
  if (__DH_DEMO__ && demo) {
    const Shell = demo.Shell
    const hooks = demo.hooks
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <Shell>
            <App demo={hooks} />
          </Shell>
        </ErrorBoundary>
      </StrictMode>,
    )
    return
  }
  // Prime a persisted session BEFORE the sync engine wakes, so the first
  // sync cycle already carries the user's bearer token. init never throws
  // (a boot must not break on auth plumbing).
  await authSession.init()
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
