/**
 * The live board's two legs: the realtime TRIGGER and the auto-sync FLOOR.
 *
 * Everything runs on injected fakes: a fake channel factory stands in for
 * supabase-js (no WebSocket, no network), the engine is either a counting
 * fake or the real engine over a fake transport, and the clock is faked.
 * The rules under test (REBUILD-HANDOFF section 4.2):
 *  - realtime is a trigger only: any event, on either table, calls
 *    onRemoteChange exactly once and the payload is never applied;
 *  - a burst collapses into ONE full cycle through the engine's debounce;
 *  - the channel carries the session token (setAuth) when one exists;
 *  - channel errors reconnect with exponential backoff capped at 60 s,
 *    SUBSCRIBED resets it, and a (re)subscribe fires one catch-up trigger;
 *  - 'offline' tears down and waits, 'online' and tab wake resubscribe,
 *    stop unsubscribes and silences late callbacks;
 *  - 'live' means SUBSCRIBED right now, and the chip only says Live then;
 *  - auto-sync runs the full cycle on its cadence, pauses offline, resumes
 *    on 'online', never overlaps a running cycle, skips without a cloud.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { KV, RecordsStore } from '../src/kernel/api'
import { CLINIC_AUTO_SYNC_INTERVAL_MS, createSyncEngine, syncEngine } from '../src/sync/engine'
import type { Transport } from '../src/sync/transport'
import {
  LIVE_LABEL,
  REALTIME_BACKOFF_BASE_MS,
  REALTIME_BACKOFF_CAP_MS,
  REALTIME_CHANNEL_TOPIC,
  createRealtimeTrigger,
  type PostgresChangesFilter,
  type RealtimeChannelLike,
  type RealtimeClientFactory,
  type RealtimeStatus,
  type RealtimeSubscribeStatus,
} from '../src/sync/realtime'
import { SyncChip } from '../src/ui/app/SyncChip'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const URL_ = 'https://proj.supabase.co'
const KEY = 'sb_publishable_k123'

function memKv(): KV {
  const data = new Map<string, unknown>()
  return {
    async get<T>(key: string): Promise<T | null> {
      return data.has(key) ? (data.get(key) as T) : null
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value)
    },
    async remove(key: string): Promise<void> {
      data.delete(key)
    },
  }
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

interface FakeChannel extends RealtimeChannelLike {
  bindings: { filter: PostgresChangesFilter; cb: (payload: unknown) => void }[]
  statusCb: ((s: RealtimeSubscribeStatus, err?: Error) => void) | null
  /** Fire a postgres_changes event for a table, with whatever payload. */
  emit(table: string, payload?: unknown): void
  /** The server's verdict on the subscription. */
  report(s: RealtimeSubscribeStatus, err?: Error): void
}

function makeFakeClient() {
  const channels: FakeChannel[] = []
  const removed: FakeChannel[] = []
  const authTokens: string[] = []
  const created: { url: string; key: string; getAccessToken: () => string | null }[] = []
  let failChannel = false

  const factory: RealtimeClientFactory = (url, key, getAccessToken) => {
    created.push({ url, key, getAccessToken })
    return {
      channel: (topic) => {
        if (failChannel) throw new Error('channel refused')
        expect(topic).toBe(REALTIME_CHANNEL_TOPIC)
        const ch: FakeChannel = {
          bindings: [],
          statusCb: null,
          on(type, filter, cb) {
            expect(type).toBe('postgres_changes')
            ch.bindings.push({ filter, cb })
            return ch
          },
          subscribe(cb) {
            ch.statusCb = cb
            return ch
          },
          emit(table, payload = { eventType: 'UPDATE', new: { id: 'x' } }) {
            for (const b of ch.bindings) if (b.filter.table === table) b.cb(payload)
          },
          report(s, err) {
            ch.statusCb?.(s, err)
          },
        }
        channels.push(ch)
        return ch
      },
      removeChannel: async (ch) => {
        removed.push(ch as FakeChannel)
        return 'ok'
      },
      setAuth: async (token) => {
        authTokens.push(token)
      },
    }
  }

  const last = (): FakeChannel => {
    const ch = channels[channels.length - 1]
    if (!ch) throw new Error('no channel yet')
    return ch
  }
  return {
    factory,
    channels,
    removed,
    authTokens,
    created,
    last,
    setFailChannel: (v: boolean) => {
      failChannel = v
    },
  }
}

function makeFakeEngine(creds: { url: string | null; key: string | null } = { url: URL_, key: KEY }) {
  const calls: unknown[][] = []
  return {
    calls,
    onRemoteChange(...args: unknown[]) {
      calls.push(args)
    },
    getCredentials: () => creds,
  }
}

/** Real engine over a fake transport; cycles() counts started cycles. */
function makeEngine(opts: { creds?: boolean; debounceMs?: number } = {}) {
  const requests: string[] = []
  let hold: Promise<void> | null = null
  let release: (() => void) | null = null
  const transport: Transport = async (url) => {
    requests.push(url)
    if (hold) await hold
    return jsonRes([])
  }
  const store = {
    getAll: async () => [],
    invalidate: () => {},
  } as unknown as RecordsStore
  const engine = createSyncEngine({
    transport,
    store,
    settings: memKv(),
    config: memKv(),
    getDeviceId: () => 'dev-1',
    sleep: async () => {},
    ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
  })
  if (opts.creds !== false) engine.updateCredentials(URL_, KEY)
  return {
    engine,
    requests,
    // pullConfig is the first request of every cycle.
    cycles: () => requests.filter((u) => u.includes('/rest/v1/config?')).length,
    holdNext: () => {
      hold = new Promise<void>((r) => {
        release = r
      })
    },
    releaseAll: () => {
      release?.()
      hold = null
      release = null
    },
  }
}

// Browser signals. jsdom's navigator.onLine and document.visibilityState are
// prototype getters; an instance property shadows them and a delete restores.
function setOnline(v: boolean): void {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => v })
}
function restoreOnline(): void {
  delete (window.navigator as unknown as Record<string, unknown>).onLine
}
function setVisibility(v: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v })
}
function restoreVisibility(): void {
  delete (document as unknown as Record<string, unknown>).visibilityState
}
const fireOnline = (): void => {
  window.dispatchEvent(new Event('online'))
}
const fireOffline = (): void => {
  window.dispatchEvent(new Event('offline'))
}
const fireVisibility = (): void => {
  document.dispatchEvent(new Event('visibilitychange'))
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms)

// ---------------------------------------------------------------------------
// The realtime trigger
// ---------------------------------------------------------------------------

describe('realtime trigger', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.useFakeTimers()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    restoreOnline()
    restoreVisibility()
    warn.mockRestore()
    vi.useRealTimers()
  })

  function setup(engine = makeFakeEngine()) {
    const fake = makeFakeClient()
    const trigger = createRealtimeTrigger({ engine, clientFactory: fake.factory })
    const statuses: RealtimeStatus[] = []
    trigger.onStatus((s) => statuses.push(s))
    return { fake, trigger, engine, statuses }
  }

  it('start subscribes ONE channel bound to records and config (public, every event)', () => {
    const { fake, trigger } = setup()
    expect(trigger.getStatus()).toBe('off')
    trigger.start()
    expect(trigger.getStatus()).toBe('connecting')
    expect(fake.created).toHaveLength(1)
    expect(fake.created[0]?.url).toBe(URL_)
    expect(fake.created[0]?.key).toBe(KEY)
    expect(fake.channels).toHaveLength(1)
    expect(fake.last().bindings.map((b) => b.filter)).toEqual([
      { event: '*', schema: 'public', table: 'records' },
      { event: '*', schema: 'public', table: 'config' },
    ])
    expect(fake.last().statusCb).not.toBeNull()
    trigger.stop()
  })

  it('without cloud credentials start stays off and builds no client', () => {
    const { fake, trigger } = setup(makeFakeEngine({ url: null, key: null }))
    trigger.start()
    expect(trigger.getStatus()).toBe('off')
    expect(fake.created).toHaveLength(0)
    expect(fake.channels).toHaveLength(0)
    trigger.stop()
  })

  it('SUBSCRIBED means live, and fires exactly one catch-up trigger', () => {
    const { fake, trigger, engine } = setup()
    trigger.start()
    expect(engine.calls).toHaveLength(0)
    fake.last().report('SUBSCRIBED')
    expect(trigger.getStatus()).toBe('live')
    expect(engine.calls).toHaveLength(1)
    trigger.stop()
  })

  it('ANY event on either table calls onRemoteChange exactly once, with no payload', () => {
    const { fake, trigger, engine } = setup()
    trigger.start()
    fake.last().report('SUBSCRIBED')
    engine.calls.length = 0

    fake.last().emit('records', { eventType: 'INSERT', new: { id: 'r1', mrn: 'ABC' } })
    expect(engine.calls).toHaveLength(1)
    fake.last().emit('config', { eventType: 'UPDATE', new: { key: 'sites' } })
    expect(engine.calls).toHaveLength(2)
    fake.last().emit('records', { eventType: 'DELETE', old: { id: 'r1' } })
    expect(engine.calls).toHaveLength(3)
    // The trigger hands the engine NOTHING: the payload cannot be applied.
    for (const args of engine.calls) expect(args).toEqual([])
    trigger.stop()
  })

  it('a burst of events collapses into ONE full cycle through the engine debounce', async () => {
    const real = makeEngine({ debounceMs: 50 })
    const fake = makeFakeClient()
    const trigger = createRealtimeTrigger({ engine: real.engine, clientFactory: fake.factory })
    trigger.start()
    fake.last().report('SUBSCRIBED') // the catch-up trigger
    for (let i = 0; i < 5; i++) fake.last().emit('records')
    for (let i = 0; i < 3; i++) fake.last().emit('config')
    expect(real.cycles()).toBe(0) // nothing before the debounce elapses
    await tick(50)
    expect(real.cycles()).toBe(1)
    // The cycle is the proven one: config pull, records pull, device role.
    expect(real.requests.some((u) => u.includes('/rest/v1/config?'))).toBe(true)
    expect(real.requests.some((u) => u.includes('/rest/v1/records?'))).toBe(true)
    expect(real.requests.some((u) => u.includes('/rest/v1/devices?'))).toBe(true)
    // A later event, after the window, is one more cycle.
    fake.last().emit('records')
    await tick(50)
    expect(real.cycles()).toBe(2)
    trigger.stop()
  })

  it('the session token rides the channel through setAuth; none without a session', () => {
    const { fake, trigger } = setup()
    trigger.start({ getAccessToken: () => 'tok-42' })
    expect(fake.authTokens).toEqual(['tok-42'])
    // The client factory also got the live getter (heartbeat refresh).
    expect(fake.created[0]?.getAccessToken()).toBe('tok-42')
    trigger.stop()

    const anon = setup()
    anon.trigger.start()
    expect(anon.fake.authTokens).toEqual([])
    expect(anon.fake.created[0]?.getAccessToken()).toBeNull()
    anon.trigger.stop()
  })

  it('a resubscribe re-reads the token, so a refreshed session reaches the channel', () => {
    const { fake, trigger } = setup()
    let token = 'tok-1'
    trigger.start({ getAccessToken: () => token })
    fake.last().report('SUBSCRIBED')
    token = 'tok-2'
    fireOnline()
    expect(fake.authTokens).toEqual(['tok-1', 'tok-2'])
    trigger.stop()
  })

  it('channel errors reconnect with exponential backoff, capped at 60 s', async () => {
    const { fake, trigger } = setup()
    trigger.start()
    expect(REALTIME_BACKOFF_BASE_MS).toBe(1_000)
    expect(REALTIME_BACKOFF_CAP_MS).toBe(60_000)
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]
    for (let i = 0; i < expected.length; i++) {
      const delay = expected[i] as number
      const before = fake.channels.length
      fake.last().report('CHANNEL_ERROR', new Error('boom'))
      expect(trigger.getStatus()).toBe('reconnecting')
      // The failed channel is dropped at once, never left to rejoin on its own.
      expect(fake.removed).toHaveLength(i + 1)
      expect(trigger.reconnectAttempts()).toBe(i + 1)
      await tick(delay - 1)
      expect(fake.channels).toHaveLength(before)
      await tick(1)
      expect(fake.channels).toHaveLength(before + 1)
    }
    trigger.stop()
  })

  it('SUBSCRIBED after retries resets the backoff to the base', async () => {
    const { fake, trigger } = setup()
    trigger.start()
    fake.last().report('CHANNEL_ERROR')
    await tick(1_000)
    fake.last().report('TIMED_OUT')
    await tick(2_000)
    expect(fake.channels).toHaveLength(3)
    fake.last().report('SUBSCRIBED')
    expect(trigger.getStatus()).toBe('live')
    expect(trigger.reconnectAttempts()).toBe(0)
    // Next failure waits the base delay again, not 4 s.
    fake.last().report('CHANNEL_ERROR')
    await tick(999)
    expect(fake.channels).toHaveLength(3)
    await tick(1)
    expect(fake.channels).toHaveLength(4)
    trigger.stop()
  })

  it('TIMED_OUT and a CLOSED we did not ask for both reconnect', async () => {
    const { fake, trigger } = setup()
    trigger.start()
    fake.last().report('TIMED_OUT')
    expect(trigger.getStatus()).toBe('reconnecting')
    await tick(1_000)
    expect(fake.channels).toHaveLength(2)
    fake.last().report('SUBSCRIBED')
    fake.last().report('CLOSED')
    expect(trigger.getStatus()).toBe('reconnecting')
    await tick(1_000)
    expect(fake.channels).toHaveLength(3)
    trigger.stop()
  })

  it('a client that cannot even build a channel is retried, not fatal', async () => {
    const { fake, trigger } = setup()
    fake.setFailChannel(true)
    trigger.start()
    expect(trigger.getStatus()).toBe('reconnecting')
    fake.setFailChannel(false)
    await tick(1_000)
    expect(fake.channels).toHaveLength(1)
    trigger.stop()
  })

  it('stop unsubscribes, cancels the pending retry, goes off, and ignores late callbacks', async () => {
    const { fake, trigger, engine } = setup()
    trigger.start()
    const first = fake.last()
    first.report('CHANNEL_ERROR')
    expect(trigger.getStatus()).toBe('reconnecting')
    trigger.stop()
    expect(trigger.getStatus()).toBe('off')
    expect(fake.removed).toContain(first)
    await tick(REALTIME_BACKOFF_CAP_MS * 2)
    expect(fake.channels).toHaveLength(1) // the retry never fired
    // The dead channel's late verdicts and events mean nothing now.
    engine.calls.length = 0
    first.report('SUBSCRIBED')
    first.emit('records')
    expect(trigger.getStatus()).toBe('off')
    expect(engine.calls).toHaveLength(0)
    // And its browser listeners are gone: online does not resubscribe.
    fireOnline()
    expect(fake.channels).toHaveLength(1)
    // stop is idempotent.
    trigger.stop()
    expect(trigger.getStatus()).toBe('off')
  })

  it('a live channel is unsubscribed on stop, so the chip can never say Live afterwards', () => {
    const { fake, trigger, statuses } = setup()
    trigger.start()
    fake.last().report('SUBSCRIBED')
    trigger.stop()
    expect(fake.removed).toEqual([fake.channels[0]])
    expect(statuses).toEqual(['connecting', 'live', 'off'])
  })

  it("'offline' tears the channel down and waits; 'online' resubscribes at once with a fresh backoff", async () => {
    const { fake, trigger, engine } = setup()
    trigger.start()
    fake.last().report('SUBSCRIBED')
    fake.last().report('CHANNEL_ERROR')
    fake.last().report('CHANNEL_ERROR') // (ignored: already dropped)
    await tick(1_000)
    fake.last().report('CHANNEL_ERROR')
    expect(trigger.reconnectAttempts()).toBe(2)

    setOnline(false)
    fireOffline()
    expect(trigger.getStatus()).toBe('reconnecting')
    const n = fake.channels.length
    await tick(REALTIME_BACKOFF_CAP_MS * 2)
    expect(fake.channels).toHaveLength(n) // no retries while offline

    setOnline(true)
    engine.calls.length = 0
    fireOnline()
    expect(fake.channels).toHaveLength(n + 1)
    expect(trigger.reconnectAttempts()).toBe(0)
    fake.last().report('SUBSCRIBED')
    expect(trigger.getStatus()).toBe('live')
    // Catch-up: whatever changed while offline is pulled now.
    expect(engine.calls).toHaveLength(1)
    trigger.stop()
  })

  it('started while the browser is offline, it waits for online instead of failing', () => {
    setOnline(false)
    const { fake, trigger } = setup()
    trigger.start()
    expect(trigger.getStatus()).toBe('reconnecting')
    expect(fake.channels).toHaveLength(0)
    setOnline(true)
    fireOnline()
    expect(fake.channels).toHaveLength(1)
    trigger.stop()
  })

  it('a failure while offline does not schedule a retry; online does the work', async () => {
    const { fake, trigger } = setup()
    trigger.start()
    setOnline(false)
    fake.last().report('CHANNEL_ERROR')
    expect(trigger.getStatus()).toBe('reconnecting')
    await tick(REALTIME_BACKOFF_CAP_MS)
    expect(fake.channels).toHaveLength(1)
    setOnline(true)
    fireOnline()
    expect(fake.channels).toHaveLength(2)
    trigger.stop()
  })

  it('tab wake (visibilitychange to visible) resubscribes and catches up; hidden does nothing', () => {
    const { fake, trigger, engine } = setup()
    trigger.start()
    fake.last().report('SUBSCRIBED')
    engine.calls.length = 0

    setVisibility('hidden')
    fireVisibility()
    expect(fake.channels).toHaveLength(1)
    expect(trigger.getStatus()).toBe('live')

    setVisibility('visible')
    fireVisibility()
    expect(fake.channels).toHaveLength(2)
    expect(fake.removed).toEqual([fake.channels[0]])
    expect(trigger.getStatus()).toBe('reconnecting')
    fake.last().report('SUBSCRIBED')
    expect(trigger.getStatus()).toBe('live')
    expect(engine.calls).toHaveLength(1)
    trigger.stop()
  })

  it('status transitions are observable in order, and listeners can leave', () => {
    const { fake, trigger, statuses } = setup()
    const mine: RealtimeStatus[] = []
    const off = trigger.onStatus((s) => mine.push(s))
    trigger.start()
    fake.last().report('SUBSCRIBED')
    fake.last().report('CHANNEL_ERROR')
    off()
    trigger.stop()
    expect(statuses).toEqual(['connecting', 'live', 'reconnecting', 'off'])
    expect(mine).toEqual(['connecting', 'live', 'reconnecting'])
  })

  it('start is idempotent: a second start never bounces a live channel', () => {
    const { fake, trigger } = setup()
    trigger.start()
    fake.last().report('SUBSCRIBED')
    trigger.start()
    expect(fake.channels).toHaveLength(1)
    expect(fake.removed).toHaveLength(0)
    expect(trigger.getStatus()).toBe('live')
    trigger.stop()
  })

  it('the real client factory is only built on start, and refuses without WebSocket', () => {
    // Importable and constructible under jsdom with no factory injected...
    const trigger = createRealtimeTrigger({ engine: makeFakeEngine() })
    expect(trigger.getStatus()).toBe('off')
    // ...and where WebSocket is missing, start lands on 'off' instead of
    // throwing or opening anything.
    vi.stubGlobal('WebSocket', undefined)
    try {
      expect(() => trigger.start()).not.toThrow()
      expect(trigger.getStatus()).toBe('off')
      expect(warn).toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      trigger.stop()
    }
  })
})

// ---------------------------------------------------------------------------
// Auto-sync: the floor under the trigger
// ---------------------------------------------------------------------------

describe('auto-sync cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    restoreOnline()
    vi.useRealTimers()
  })

  it('the Clinic cadence is 20 s', () => {
    expect(CLINIC_AUTO_SYNC_INTERVAL_MS).toBe(20_000)
  })

  it('runs a full cycle at start and then one per interval', async () => {
    const { engine, cycles } = makeEngine()
    expect(engine.autoSyncActive()).toBe(false)
    engine.startAutoSync({ intervalMs: 20_000 })
    expect(engine.autoSyncActive()).toBe(true)
    await tick(0)
    expect(cycles()).toBe(1)
    expect(engine.getStatus()).toBe('synced')
    await tick(19_999)
    expect(cycles()).toBe(1)
    await tick(1)
    expect(cycles()).toBe(2)
    await tick(40_000)
    expect(cycles()).toBe(4)
    engine.stopAutoSync()
  })

  it('immediate: false waits a whole interval first', async () => {
    const { engine, cycles } = makeEngine()
    engine.startAutoSync({ intervalMs: 20_000, immediate: false })
    await tick(0)
    expect(cycles()).toBe(0)
    await tick(20_000)
    expect(cycles()).toBe(1)
    engine.stopAutoSync()
  })

  it("pauses while the browser is offline and resumes the moment 'online' fires", async () => {
    const { engine, cycles } = makeEngine()
    engine.startAutoSync({ intervalMs: 20_000 })
    await tick(0)
    expect(cycles()).toBe(1)

    setOnline(false)
    await tick(100_000)
    expect(cycles()).toBe(1) // five ticks, none ran

    setOnline(true)
    fireOnline()
    await tick(0)
    expect(cycles()).toBe(2) // straight away, not an interval later
    await tick(20_000)
    expect(cycles()).toBe(3)
    engine.stopAutoSync()
  })

  it('never overlaps a running cycle: a slow cycle skips ticks instead of queueing them', async () => {
    const { engine, cycles, holdNext, releaseAll } = makeEngine()
    holdNext()
    engine.startAutoSync({ intervalMs: 20_000 })
    await tick(0)
    expect(cycles()).toBe(1)
    expect(engine.getStatus()).toBe('syncing')
    await tick(60_000) // three ticks while the first cycle hangs
    expect(cycles()).toBe(1)
    releaseAll()
    await tick(0)
    expect(engine.getStatus()).toBe('synced')
    expect(cycles()).toBe(1) // no backlog drained
    await tick(20_000)
    expect(cycles()).toBe(2)
    engine.stopAutoSync()
  })

  it('never overlaps a MANUAL cycle either (the chip, Settings)', async () => {
    const { engine, cycles, holdNext, releaseAll } = makeEngine()
    engine.startAutoSync({ intervalMs: 20_000, immediate: false })
    holdNext()
    const manual = engine.syncNow()
    await tick(0)
    expect(cycles()).toBe(1)
    await tick(40_000)
    expect(cycles()).toBe(1)
    releaseAll()
    await manual
    await tick(20_000)
    expect(cycles()).toBe(2)
    engine.stopAutoSync()
  })

  it('a tick never throws out of the timer, and the next tick still runs', async () => {
    const requests: string[] = []
    let fail = true
    const transport: Transport = async (url) => {
      requests.push(url)
      if (fail) throw new Error('network down')
      return jsonRes([])
    }
    const engine = createSyncEngine({
      transport,
      store: { getAll: async () => [], invalidate: () => {} } as unknown as RecordsStore,
      settings: memKv(),
      config: memKv(),
      getDeviceId: () => 'dev-1',
      sleep: async () => {},
    })
    engine.updateCredentials(URL_, KEY)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    engine.startAutoSync({ intervalMs: 20_000 })
    await tick(0)
    expect(engine.getStatus()).toBe('error')
    fail = false
    await tick(20_000)
    expect(engine.getStatus()).toBe('synced')
    engine.stopAutoSync()
    err.mockRestore()
  })

  it('does nothing without a cloud, then picks up once credentials exist', async () => {
    const { engine, cycles } = makeEngine({ creds: false })
    engine.startAutoSync({ intervalMs: 20_000 })
    await tick(60_000)
    expect(cycles()).toBe(0)
    expect(engine.getStatus()).toBe('disabled')
    engine.updateCredentials(URL_, KEY)
    await tick(20_000)
    expect(cycles()).toBe(1)
    engine.stopAutoSync()
  })

  it("stopAutoSync ends the cadence and the 'online' listener", async () => {
    const { engine, cycles } = makeEngine()
    engine.startAutoSync({ intervalMs: 20_000 })
    await tick(0)
    engine.stopAutoSync()
    expect(engine.autoSyncActive()).toBe(false)
    await tick(100_000)
    expect(cycles()).toBe(1)
    fireOnline()
    await tick(0)
    expect(cycles()).toBe(1)
    // stop is idempotent
    engine.stopAutoSync()
  })

  it('a second startAutoSync replaces the cadence, never doubles it', async () => {
    const { engine, cycles } = makeEngine()
    engine.startAutoSync({ intervalMs: 20_000, immediate: false })
    engine.startAutoSync({ intervalMs: 20_000, immediate: false })
    await tick(20_000)
    expect(cycles()).toBe(1)
    await tick(20_000)
    expect(cycles()).toBe(2)
    engine.stopAutoSync()
  })
})

// ---------------------------------------------------------------------------
// The chip: "Live" is the channel's word, never the engine's
// ---------------------------------------------------------------------------

describe('SyncChip live indicator', () => {
  const h = React.createElement
  const noop = (): void => {}

  beforeEach(() => {
    syncEngine.updateCredentials(URL_, KEY) // 'idle': connected, not synced yet
  })
  afterEach(() => {
    cleanup()
    restoreOnline()
    syncEngine.updateCredentials(null, null)
  })

  it('says Live only when told the channel is live', () => {
    render(h(SyncChip, { standalone: false, onSynced: noop, live: true }))
    const chip = screen.getByRole('button')
    expect(chip.textContent).toContain('Live')
    expect(chip.title).toBe(LIVE_LABEL.hint)
    expect(chip.className).toContain('sync-ok')
  })

  it('without the live flag it reports the engine status as before', () => {
    render(h(SyncChip, { standalone: false, onSynced: noop }))
    const chip = screen.getByRole('button')
    expect(chip.textContent).toContain('Connected')
    expect(chip.textContent).not.toContain('Live')
  })

  it('offline beats Live: the browser signal still wins', () => {
    setOnline(false)
    render(h(SyncChip, { standalone: false, onSynced: noop, live: true }))
    const chip = screen.getByRole('button')
    expect(chip.textContent).toContain('Offline')
    expect(chip.textContent).not.toContain('Live')
  })
})
