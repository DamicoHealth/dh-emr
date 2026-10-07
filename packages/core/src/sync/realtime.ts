/**
 * Supabase Realtime as a TRIGGER ONLY (REBUILD-HANDOFF section 4.2).
 *
 * One channel, postgres_changes on public.records and public.config. Every
 * notification, whatever its table or payload, does exactly one thing: it
 * calls engine.onRemoteChange(), which debounces and then runs the full
 * hardened sync cycle. Payloads are NEVER applied to the store. Every byte
 * still arrives through the one proven replication path; the worst a bad,
 * partial or RLS-filtered notification can do is cause one extra cycle.
 * That is also why the cursor-based pull makes catch-up free: whenever the
 * channel (re)subscribes it fires one catch-up trigger, so anything that
 * changed while the socket was dead (tab in the background, signal gap)
 * is pulled the moment the channel is live again, with no gap between
 * "pull done" and "channel listening" for a change to fall into.
 *
 * Lifecycle, owned by the app shell: start once the account gate is
 * active, stop on sign-out. On its own the trigger resubscribes on the
 * browser's 'online' event and when the document becomes visible again
 * (iOS kills background sockets without telling anyone), tears down on
 * 'offline' instead of burning retries, and reconnects after channel
 * errors with exponential backoff capped at 60 s.
 *
 * Status is for the chip and must stay honest: 'live' means the channel
 * is SUBSCRIBED right now, nothing less. The periodic auto-sync in the
 * engine is the floor under all of this; a device whose channel never
 * comes up still converges on the cadence.
 *
 * The client is injectable (RealtimeClientFactory), so the whole state
 * machine runs under jsdom with a fake channel. The real factory is only
 * built on start(), never at import, and refuses to run where WebSocket
 * does not exist.
 */
import { createClient } from '@supabase/supabase-js'
import { syncEngine, type SyncEngine, type SyncLabel } from './engine'

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type RealtimeStatus = 'off' | 'connecting' | 'live' | 'reconnecting'

/**
 * What the chip shows while the channel is live and the engine is at rest.
 * Same shape as SYNC_LABELS so the chip can swap it in.
 */
export const LIVE_LABEL: SyncLabel = {
  label: 'Live',
  hint: 'Connected live. Changes from other devices arrive within seconds.',
  tone: 'ok',
}

/** The tables the channel listens on; both are in the realtime publication (setup.sql). */
export const REALTIME_TABLES: readonly string[] = ['records', 'config']
export const REALTIME_CHANNEL_TOPIC = 'dh-emr-changes'
/** First retry after 1 s, doubling to the cap. */
export const REALTIME_BACKOFF_BASE_MS = 1_000
export const REALTIME_BACKOFF_CAP_MS = 60_000

/** The subscribe statuses realtime-js reports (REALTIME_SUBSCRIBE_STATES). */
export type RealtimeSubscribeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR'

export interface PostgresChangesFilter {
  event: '*'
  schema: 'public'
  table: string
}

/** The slice of a realtime-js channel this module calls. Fakes implement just this. */
export interface RealtimeChannelLike {
  on(
    type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: (payload: unknown) => void,
  ): RealtimeChannelLike
  subscribe(callback: (status: RealtimeSubscribeStatus, err?: Error) => void): RealtimeChannelLike
}

/** The slice of a supabase-js client this module calls. */
export interface RealtimeClientLike {
  channel(topic: string): RealtimeChannelLike
  removeChannel(channel: RealtimeChannelLike): Promise<unknown> | unknown
  /** supabase.realtime.setAuth: the session token rides the channel join. */
  setAuth(token: string): Promise<void> | void
}

export type RealtimeClientFactory = (
  url: string,
  key: string,
  getAccessToken: () => string | null,
) => RealtimeClientLike

export interface RealtimeTriggerDeps {
  engine: Pick<SyncEngine, 'onRemoteChange' | 'getCredentials'>
  clientFactory?: RealtimeClientFactory
  backoffBaseMs?: number
  backoffCapMs?: number
}

export interface RealtimeStartOptions {
  /**
   * The signed-in session's access token, consulted at every (re)subscribe
   * and by the client's own refresh. Absent (or null) means the publishable
   * key alone, which under the clinic policies receives nothing - the chip
   * then never says Live, which is the honest answer.
   */
  getAccessToken?: () => string | null
}

export interface RealtimeTrigger {
  /** Idempotent. Without cloud credentials the status stays 'off'. */
  start(opts?: RealtimeStartOptions): void
  /** Idempotent. Unsubscribes, drops every timer and listener, status 'off'. */
  stop(): void
  getStatus(): RealtimeStatus
  onStatus(cb: (s: RealtimeStatus) => void): () => void
  /** Consecutive failed (re)subscribes so far; 0 once live. */
  reconnectAttempts(): number
}

// ---------------------------------------------------------------------------
// The real client
// ---------------------------------------------------------------------------

/**
 * A supabase-js client used ONLY for its realtime surface. The accessToken
 * option replaces the client's own auth with our session's token: no second
 * GoTrue instance, no storage key, and realtime-js re-reads the callback on
 * every heartbeat, so an hourly token refresh reaches the channel without a
 * bounce. With no session the publishable key itself rides as the token
 * (what realtime-js does for an anonymous client).
 */
const defaultClientFactory: RealtimeClientFactory = (url, key, getAccessToken) => {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Realtime needs WebSocket, which this environment lacks')
  }
  const client = createClient(url, key, {
    accessToken: async () => getAccessToken() ?? key,
  })
  type RealChannel = ReturnType<typeof client.channel>
  return {
    channel: (topic) => client.channel(topic) as unknown as RealtimeChannelLike,
    removeChannel: (ch) => client.removeChannel(ch as unknown as RealChannel),
    setAuth: (token) => client.realtime.setAuth(token),
  }
}

// ---------------------------------------------------------------------------
// The trigger
// ---------------------------------------------------------------------------

export function createRealtimeTrigger(deps: RealtimeTriggerDeps): RealtimeTrigger {
  const clientFactory = deps.clientFactory ?? defaultClientFactory
  const backoffBase = deps.backoffBaseMs ?? REALTIME_BACKOFF_BASE_MS
  const backoffCap = deps.backoffCapMs ?? REALTIME_BACKOFF_CAP_MS

  let status: RealtimeStatus = 'off'
  const listeners = new Set<(s: RealtimeStatus) => void>()
  let started = false
  let getAccessToken: () => string | null = () => null

  let client: RealtimeClientLike | null = null
  let clientCreds = ''
  let channel: RealtimeChannelLike | null = null
  /** Bumped on every teardown so a dead channel's late callbacks are ignored. */
  let generation = 0
  let attempts = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  function setStatus(s: RealtimeStatus): void {
    if (s === status) return
    status = s
    listeners.forEach((cb) => {
      try {
        cb(s)
      } catch {
        /* a listener must not break the trigger */
      }
    })
  }

  function browserOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false
  }

  function getClient(): RealtimeClientLike | null {
    const { url, key } = deps.engine.getCredentials()
    if (!url || !key) return null
    const creds = `${url}\n${key}`
    if (client && clientCreds === creds) return client
    client = clientFactory(url, key, () => getAccessToken())
    clientCreds = creds
    return client
  }

  function clearReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  /** Drop the current channel; its callbacks become no-ops from here on. */
  function dropChannel(): void {
    generation++
    const ch = channel
    channel = null
    if (ch && client) {
      try {
        void Promise.resolve(client.removeChannel(ch)).catch(() => {})
      } catch {
        /* a failing removal is still a removal from our side */
      }
    }
  }

  function scheduleReconnect(): void {
    if (!started) return
    dropChannel()
    if (reconnectTimer !== null) return
    setStatus('reconnecting')
    if (browserOffline()) return // 'online' restarts us; retrying offline is noise
    const delay = Math.min(backoffCap, backoffBase * 2 ** attempts)
    attempts++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      subscribe(false)
    }, delay)
  }

  function subscribe(initial: boolean): void {
    dropChannel()
    clearReconnect()
    let c: RealtimeClientLike | null
    try {
      c = getClient()
    } catch (e) {
      // No WebSocket here, or the client refused to build: nothing to retry.
      console.warn('[realtime] unavailable:', e instanceof Error ? e.message : String(e))
      setStatus('off')
      return
    }
    if (!c) {
      setStatus('off')
      return
    }
    if (browserOffline()) {
      setStatus('reconnecting')
      return
    }
    setStatus(initial ? 'connecting' : 'reconnecting')
    const gen = generation
    const token = getAccessToken()
    if (token) {
      try {
        void Promise.resolve(c.setAuth(token)).catch(() => {})
      } catch {
        /* the join still carries whatever the client holds */
      }
    }
    try {
      let ch = c.channel(REALTIME_CHANNEL_TOPIC)
      for (const table of REALTIME_TABLES) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => {
          // Trigger only. The payload is deliberately ignored.
          if (gen === generation) deps.engine.onRemoteChange()
        })
      }
      channel = ch
      ch.subscribe((s, err) => {
        if (gen !== generation) return
        if (s === 'SUBSCRIBED') {
          attempts = 0
          setStatus('live')
          // Catch up on whatever happened while we were not listening.
          deps.engine.onRemoteChange()
          return
        }
        // TIMED_OUT, CHANNEL_ERROR, or a CLOSED we did not ask for (our own
        // teardown bumps the generation first, so it never lands here).
        if (err) console.warn(`[realtime] channel ${s}:`, err.message)
        scheduleReconnect()
      })
    } catch (e) {
      console.warn('[realtime] subscribe failed:', e instanceof Error ? e.message : String(e))
      scheduleReconnect()
    }
  }

  // ------------------------------------------------------- browser signals

  const onOnline = (): void => {
    if (!started) return
    attempts = 0
    subscribe(false)
  }
  const onOffline = (): void => {
    if (!started || status === 'off') return
    dropChannel()
    clearReconnect()
    setStatus('reconnecting')
  }
  const onVisibility = (): void => {
    if (!started) return
    if (typeof document === 'undefined' || document.visibilityState !== 'visible') return
    attempts = 0
    subscribe(false)
  }

  function addListeners(): void {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline)
      window.addEventListener('offline', onOffline)
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility)
    }
  }

  function removeListeners(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }

  // ------------------------------------------------------------ lifecycle

  function start(opts: RealtimeStartOptions = {}): void {
    getAccessToken = opts.getAccessToken ?? (() => null)
    if (started) return
    started = true
    attempts = 0
    addListeners()
    subscribe(true)
  }

  function stop(): void {
    if (!started) return
    started = false
    removeListeners()
    clearReconnect()
    dropChannel()
    attempts = 0
    setStatus('off')
  }

  return {
    start,
    stop,
    getStatus: () => status,
    onStatus: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    reconnectAttempts: () => attempts,
  }
}

/**
 * The app-wide trigger, bound to the app-wide engine and the real client.
 * The shell that wants a live board starts it (with the session's token
 * getter) once its account gate is active and stops it on sign-out.
 */
export const realtimeTrigger: RealtimeTrigger = createRealtimeTrigger({ engine: syncEngine })
