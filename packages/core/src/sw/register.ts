/**
 * Service worker registration wiring. One code path for both builds:
 *
 *  - Clinical: registerType 'prompt'. onNeedRefresh flips the update gate
 *    and the UpdateBar renders; applyUpdateNow() is the ONLY thing that
 *    ever reloads, and only the user's "Update now" click calls it.
 *  - Demo: registerType 'autoUpdate'. The generated worker carries
 *    skipWaiting + clientsClaim, onNeedRefresh never fires, and the bar
 *    stays hidden; registration alone is all the demo needs.
 *
 * The virtual module is loaded through a guarded dynamic import so
 * environments without a service worker (jsdom tests, very old browsers)
 * never touch it. The worker is progressive enhancement: every failure
 * path here is silent and the app runs exactly as before.
 */
import { isAutoUpdateBuild, updateGate } from './updateGate'

/** Browsers only check on navigation; long-lived clinic tabs poll hourly. */
const UPDATE_CHECK_MS = 60 * 60 * 1000

type UpdateFn = (reloadPage?: boolean) => Promise<void>

let started = false
let updateFn: UpdateFn | null = null

/**
 * Registers the service worker once per boot. Safe to call from a mounted
 * component under StrictMode: repeats are no-ops.
 */
export function startServiceWorker(): void {
  if (started) return
  started = true
  if (typeof window === 'undefined' || !('serviceWorker' in window.navigator)) return
  void (async () => {
    try {
      const { registerSW } = await import('virtual:pwa-register')
      updateFn = registerSW({
        immediate: true,
        onNeedRefresh() {
          // The auto-update build never fires this; the guard keeps a
          // misconfigured build from ever showing the bar in the demo.
          if (!isAutoUpdateBuild()) updateGate.noteNeedRefresh()
        },
        onRegisteredSW(_url, registration) {
          if (!registration) return
          setInterval(() => {
            registration.update().catch(() => {
              /* offline is normal here */
            })
          }, UPDATE_CHECK_MS)
        },
      })
    } catch {
      /* no worker, no harm: the app is offline-first through IndexedDB */
    }
  })()
}

/**
 * The user took the update. Tells the waiting worker to activate and
 * reloads the page. Nothing else in the app may reload for an update.
 */
export async function applyUpdateNow(): Promise<void> {
  if (updateFn) await updateFn(true)
}
