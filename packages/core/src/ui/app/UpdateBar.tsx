/**
 * User-gated update banner. Mounting it starts service worker registration;
 * when a new worker is waiting (clinical builds only - the demo auto-updates
 * and this bar never renders there) it shows a calm banner with the one
 * honest warning that matters: updating reloads the app.
 *
 * It NEVER reloads on its own. "Update now" is the single reload path;
 * "Not now" hides the bar for this session only, and a still-pending update
 * asks again on the next boot (the gate keeps dismissal in memory only).
 */
import { useEffect, useSyncExternalStore } from 'react'
import { applyUpdateNow, startServiceWorker } from '../../sw/register'
import { updateGate } from '../../sw/updateGate'

export function UpdateBar() {
  useEffect(() => {
    startServiceWorker()
  }, [])

  const show = useSyncExternalStore(updateGate.subscribe, () => updateGate.shouldShowBar())

  if (!show) return null
  return (
    <div className="banner banner-info" role="status">
      <strong>A new version of DH EMR is ready.</strong>
      <p>
        Updating reloads the app, so finish and save any open visit first. Saved records are
        not affected.
      </p>
      <div className="btn-row">
        <button
          className="btn"
          onClick={() => {
            void applyUpdateNow()
          }}
        >
          Update now
        </button>
        <button className="btn btn-ghost" onClick={() => updateGate.dismiss()}>
          Not now
        </button>
      </div>
    </div>
  )
}
