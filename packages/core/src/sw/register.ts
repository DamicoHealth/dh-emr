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

/**
 * Browsers re-check a registered worker's script on navigation at most once
 * a day, so a device that opens the app every morning could sit on a stale
 * build for 24 hours after a release. Registration therefore asks for an
 * update CHECK right away on every load, and long-lived clinic tabs poll
 * hourly after that. A check is not an update: the clinical builds still
 * only surface a waiting worker as the user-gated bar, and the demos (auto
 * update) reload once, early, instead of a day late.
 */
const UPDATE_CHECK_MS = 60 * 60 * 1000

type UpdateFn = (reloadPage?: boolean) => Promise<void>

/** The virtual:pwa-register module's registerSW, as the loader resolves it. */
export type RegisterSW = (options: {
  immediate?: boolean
  onNeedRefresh?: () => void
  onRegisteredSW?: (url: string, registration: ServiceWorkerRegistration | undefined) => void
}) => UpdateFn

type Loader = () => Promise<{ registerSW: RegisterSW }>

const defaultLoader: Loader = () => import('virtual:pwa-register')

let started = false
let updateFn: UpdateFn | null = null

/**
 * Registers the service worker once per boot. Safe to call from a mounted
 * component under StrictMode: repeats are no-ops. `load` exists for the
 * tests, which cannot resolve the Vite virtual module.
 */
export function startServiceWorker(load: Loader = defaultLoader): void {
  if (started) return
  started = true
  if (typeof window === 'undefined' || !('serviceWorker' in window.navigator)) return
  void (async () => {
    try {
      const { registerSW } = await load()
      updateFn = registerSW({
        immediate: true,
        onNeedRefresh() {
          // The auto-update build never fires this; the guard keeps a
          // misconfigured build from ever showing the bar in the demo.
          if (!isAutoUpdateBuild()) updateGate.noteNeedRefresh()
        },
        onRegisteredSW(_url, registration) {
          if (!registration) return
          const check = (): void => {
            registration.update().catch(() => {
              /* offline is normal here */
            })
          }
          check()
          setInterval(check, UPDATE_CHECK_MS)
        },
      })
    } catch {
      /* no worker, no harm: the app is offline-first through IndexedDB */
    }
  })()
}

/** Tests only: forget the once-per-boot guard. */
export function resetServiceWorkerForTests(): void {
  started = false
  updateFn = null
}

/**
 * The user took the update. Tells the waiting worker to activate and
 * reloads the page. Nothing else in the app may reload for an update.
 */
export async function applyUpdateNow(): Promise<void> {
  if (updateFn) await updateFn(true)
}
