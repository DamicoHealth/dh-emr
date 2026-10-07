/**
 * Locking and cross-tab coordination. Two layers, because neither alone is
 * enough, and the order is fixed: cross-tab (navigator.locks) OUTSIDE, the
 * per-tab promise mutex INSIDE.
 *
 *  1. navigator.locks 'dh-emr-records' - a real mutex shared by every tab on
 *     the origin, held around the whole read-modify-write.
 *  2. BroadcastChannel 'dh-emr-records-changed' - after any write, tell the
 *     other tabs to drop their stale in-memory cache. Without this, tab A's
 *     next save still starts from a snapshot taken before tab B's write,
 *     even with the lock held.
 *
 * Where navigator.locks is missing the app degrades to per-tab behaviour and
 * detectOtherTabs() drives a visible warning instead.
 */

const LOCK_NAME = 'dh-emr-records'
const CHANNEL = 'dh-emr-records-changed'
const PRESENCE_CHANNEL = 'dh-emr-presence'

// ---------------------------------------------------------------------------
// Per-tab promise mutex. The chain NEVER poisons: fn runs whether the
// previous op resolved or rejected (`.then(fn, fn)`), a rejection propagates
// to its own caller but the next writer still runs.
// ---------------------------------------------------------------------------

let tabChain: Promise<unknown> = Promise.resolve()

export function withTabLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = tabChain.then(fn, fn)
  tabChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------------------------------------------------------------------------
// Cross-tab broadcast + lock
// ---------------------------------------------------------------------------

type Listener = () => void

const listeners = new Set<Listener>()
let channel: BroadcastChannel | null = null
/** Suppress the echo of our own broadcast. */
let selfWriting = false
/** The records store registers its cache invalidation here (no import cycle). */
let cacheInvalidator: Listener = () => {}

export function registerCacheInvalidator(fn: Listener): void {
  cacheInvalidator = fn
}

/** Node's BroadcastChannel would otherwise hold the event loop open in tests. */
function unrefChannel(ch: BroadcastChannel): void {
  ;(ch as unknown as { unref?: () => void }).unref?.()
}

function chan(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel
  channel = new BroadcastChannel(CHANNEL)
  unrefChannel(channel)
  channel.onmessage = () => {
    if (selfWriting) return
    // Another tab changed the store. Our cached copy is now a stale snapshot
    // and MUST NOT become the base of the next write.
    try {
      cacheInvalidator()
    } catch {
      /* kernel not up yet */
    }
    listeners.forEach((l) => {
      try {
        l()
      } catch {
        /* a listener must not break the rest */
      }
    })
  }
  return channel
}

/** Notified when another tab writes. Returns an unsubscribe. */
export function onExternalWrite(cb: Listener): () => void {
  chan()
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Announce that this tab just wrote, so other tabs drop their caches. */
export function announceWrite(): void {
  const c = chan()
  if (!c) return
  selfWriting = true
  try {
    c.postMessage({ t: Date.now() })
  } finally {
    selfWriting = false
  }
}

/** True when this browser can actually serialise writes between tabs. */
export function hasCrossTabLock(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.locks?.request
}

/**
 * Run fn while holding the cross-tab records lock. Falls back to running it
 * directly where the Web Locks API is unavailable - the caller is still
 * inside the kernel's per-tab mutex either way. Invalidate on lock ENTRY
 * (our cache may predate another tab's write that happened while we queued);
 * announce AFTER the mutation, still inside the lock.
 */
export async function withCrossTabLock<T>(fn: () => Promise<T> | T): Promise<T> {
  if (!hasCrossTabLock()) return await fn()
  return (await navigator.locks.request(LOCK_NAME, async () => {
    try {
      cacheInvalidator()
    } catch {
      /* kernel not up yet */
    }
    const out = await fn()
    announceWrite()
    return out
  })) as T
}

/**
 * Detect a second live tab, for the browsers that cannot serialise writes.
 * Resolves true when another tab answers the ping within the timeout. The
 * probe channel stays open afterwards so this instance answers later pings.
 */
export function detectOtherTabs(timeoutMs = 400): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const probe = new BroadcastChannel(PRESENCE_CHANNEL)
    unrefChannel(probe)
    let found = false
    probe.onmessage = (e: MessageEvent) => {
      const data = (e as MessageEvent<{ kind?: string }>).data
      if (data?.kind === 'pong') {
        found = true
      }
      if (data?.kind === 'ping') probe.postMessage({ kind: 'pong' })
    }
    probe.postMessage({ kind: 'ping' })
    setTimeout(() => {
      resolve(found) /* keep the channel open to answer later pings */
    }, timeoutMs)
  })
}
