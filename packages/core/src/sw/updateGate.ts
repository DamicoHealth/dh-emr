/**
 * Update gate: the state machine behind the "Update now" bar.
 *
 * Two service-worker stories (REBUILD-HANDOFF sections 7 and 8):
 *
 *  - Clinical build: updates are USER-GATED. A waiting worker only ever
 *    surfaces as a calm banner; the app NEVER reloads on its own, because a
 *    reload mid-encounter would eat a part-typed visit. An unannounced
 *    release sitting untaken is the accepted cost of that guarantee.
 *  - Demo build (__DH_DEMO__): auto-update (skipWaiting + clientsClaim in
 *    the worker itself). The bar never shows; the gate is permanently quiet.
 *
 * Dismissal is deliberately IN-MEMORY ONLY - never written to any storage.
 * "Not now" silences the bar for the rest of this running session; the next
 * boot builds a fresh gate, so a still-pending update asks again.
 */

/** Injected by vite.config define; typeof-guarded like every other consumer. */
declare const __DH_DEMO__: boolean | undefined

/**
 * Normalizes the raw define into the auto-update decision. Only the literal
 * boolean true selects the auto path: an undefined define (a build that
 * never set it) or any truthy stray value stays on the safe, user-gated
 * clinical path.
 */
export function autoUpdateFlag(demoDefine: unknown): boolean {
  return demoDefine === true
}

/** True when this build auto-updates (demo); false = user-gated (clinical). */
export function isAutoUpdateBuild(): boolean {
  return autoUpdateFlag(typeof __DH_DEMO__ === 'boolean' ? __DH_DEMO__ : false)
}

export interface UpdateGateState {
  /** A new service worker is installed and waiting. */
  needRefresh: boolean
  /** The user said "Not now" this session. */
  dismissed: boolean
}

export interface UpdateGate {
  /** Snapshot of the raw state (stable reference between transitions). */
  state(): UpdateGateState
  /** The one question the UI asks: render the banner right now? */
  shouldShowBar(): boolean
  /** Wire to onNeedRefresh. Idempotent: repeat calls do not re-notify. */
  noteNeedRefresh(): void
  /** "Not now": hide for this session only. No-op unless the bar is up. */
  dismiss(): void
  /** Change notifications; returns the unsubscribe. */
  subscribe(fn: () => void): () => void
}

export function createUpdateGate(autoUpdate: boolean): UpdateGate {
  let state: UpdateGateState = { needRefresh: false, dismissed: false }
  const listeners = new Set<() => void>()

  function set(next: UpdateGateState): void {
    state = next
    for (const fn of [...listeners]) fn()
  }

  return {
    state: () => state,
    shouldShowBar: () => !autoUpdate && state.needRefresh && !state.dismissed,
    noteNeedRefresh(): void {
      if (state.needRefresh) return
      set({ ...state, needRefresh: true })
    },
    dismiss(): void {
      // Only a visible bar can be dismissed: on the auto path, or before an
      // update is pending, there is nothing to silence and no notification
      // to fire.
      if (autoUpdate || !state.needRefresh || state.dismissed) return
      set({ ...state, dismissed: true })
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** The app-wide gate, built once per boot from the build flag. */
export const updateGate: UpdateGate = createUpdateGate(isAutoUpdateBuild())
