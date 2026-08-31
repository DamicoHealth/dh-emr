/**
 * Clinic-mode auth layer: the profile state machine, the namespaced session
 * store, the org-mode signal, and the ONE token seam in src/sync/keys.ts.
 *
 * Everything runs on injected fakes - no network, no real supabase-js
 * client. The rules under test are product rules, not plumbing:
 *  - signing in grants NOTHING until an admin approves (pending state);
 *  - revocation is a server verdict and a live answer always beats cache;
 *  - offline never stops a clinic: a cached ACTIVE profile keeps working,
 *    with a stale nudge past 7 days;
 *  - sessions are namespaced per storage suffix so demo/preview builds can
 *    never share a session with production;
 *  - engine requests carry `Authorization: Bearer <access token>` when a
 *    session exists and are byte-identical to field mode when none does.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { KV } from '../src/kernel/api'
import type { RecordsStore } from '../src/kernel/api'
import { getCurrentUserId, setCurrentUserId, storagePrefix } from '../src/kernel'
import { setAccessTokenProvider, supabaseHeaders } from '../src/sync/keys'
import { createSyncEngine } from '../src/sync/engine'
import type { Transport } from '../src/sync/transport'
import {
  createSessionManager,
  NO_CLOUD_ERROR,
  type AuthClientFactory,
  type AuthSession,
} from '../src/auth/session'
import {
  loadProfile,
  PROFILE_CACHE_KEY,
  PROFILE_STALE_MS,
  type ActiveProfile,
} from '../src/auth/profile'
import { getOrgMode, subscribeOrgMode, type OrgMode } from '../src/auth/orgMode'
import { loadCurrentProfile } from '../src/auth'
import { ensureFleetRow } from '../src/sync/device'
import { authedRequest, NO_SESSION_ERROR, postgrestErrorMessage } from '../src/auth/api'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function memKv(initial?: Record<string, unknown>): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(initial ?? {}))
  return {
    data,
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

const SESSION: AuthSession = {
  access_token: 'tok-1',
  user: { id: 'u1', email: 'grace@clinic.example' },
}

const CREDS = {
  supabaseUrl: 'https://proj.supabase.co',
  supabaseKey: 'sb_publishable_k123',
}

interface ProfileRowShape {
  id: string
  display_name: string | null
  role: string | null
  is_admin: boolean
  activated_at: string | null
  revoked_at: string | null
}

const row = (over: Partial<ProfileRowShape>): ProfileRowShape => ({
  id: 'u1',
  display_name: 'Grace N.',
  role: 'provider',
  is_admin: false,
  activated_at: null,
  revoked_at: null,
  ...over,
})

const NOW = Date.parse('2026-08-31T12:00:00.000Z')

function profileDeps(opts: {
  settings?: ReturnType<typeof memKv>
  rows?: unknown
  status?: number
  fail?: boolean
  session?: AuthSession | null
  now?: number
}) {
  const settings = opts.settings ?? memKv()
  const requests: string[] = []
  return {
    settings,
    requests,
    deps: {
      settings,
      request: async (path: string): Promise<Response> => {
        requests.push(path)
        if (opts.fail) throw new TypeError('Failed to fetch')
        return jsonRes(opts.rows ?? [], opts.status ?? 200)
      },
      getSession: async () => (opts.session === undefined ? SESSION : opts.session),
      now: () => opts.now ?? NOW,
    },
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  // The token provider is module-global in src/sync/keys.ts; a leaked one
  // would silently bearer-token every other suite's requests.
  setAccessTokenProvider(null)
})

// ---------------------------------------------------------------------------
// The token seam (src/sync/keys.ts)
// ---------------------------------------------------------------------------

describe('supabaseHeaders access-token seam', () => {
  const LEGACY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.sig'

  it('an explicit access token rides as the bearer over a publishable key', () => {
    const h = supabaseHeaders('sb_publishable_x', undefined, 'tok-9')
    expect(h.apikey).toBe('sb_publishable_x')
    expect(h.Authorization).toBe('Bearer tok-9')
  })

  it('an explicit access token beats the legacy self-bearer rule', () => {
    expect(supabaseHeaders(LEGACY, undefined, 'tok-9').Authorization).toBe('Bearer tok-9')
  })

  it('the registered provider supplies the bearer when no explicit token is given', () => {
    setAccessTokenProvider(() => 'tok-live')
    expect(supabaseHeaders('sb_publishable_x').Authorization).toBe('Bearer tok-live')
  })

  it('a provider returning null changes NOTHING - field mode stays byte-identical', () => {
    setAccessTokenProvider(() => null)
    expect(supabaseHeaders('sb_publishable_x').Authorization).toBeUndefined()
    expect(supabaseHeaders(LEGACY).Authorization).toBe(`Bearer ${LEGACY}`)
  })

  it('clearing the provider restores the original behavior', () => {
    setAccessTokenProvider(() => 'tok-live')
    setAccessTokenProvider(null)
    expect(supabaseHeaders('sb_publishable_x').Authorization).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Session manager
// ---------------------------------------------------------------------------

function fakeClientFactory(opts?: {
  signInError?: string
  persisted?: AuthSession | null
}): {
  factory: AuthClientFactory
  created: { url: string; key: string; storageKey: string }[]
  signOuts: unknown[]
} {
  const created: { url: string; key: string; storageKey: string }[] = []
  const signOuts: unknown[] = []
  const factory: AuthClientFactory = (url, key, storageKey) => {
    created.push({ url, key, storageKey })
    return {
      auth: {
        async signInWithPassword() {
          if (opts?.signInError) return { data: { session: null }, error: { message: opts.signInError } }
          return { data: { session: SESSION }, error: null }
        },
        async signUp() {
          return { data: { session: SESSION }, error: null }
        },
        async signOut(o) {
          signOuts.push(o)
          return { error: null }
        },
        async getSession() {
          return { data: { session: opts?.persisted ?? null } }
        },
        onAuthStateChange() {
          return { data: { subscription: { unsubscribe() {} } } }
        },
      },
    }
  }
  return { factory, created, signOuts }
}

describe('session manager', () => {
  it('persists the session under the NAMESPACED storage key', async () => {
    const { factory, created } = fakeClientFactory()
    const mgr = createSessionManager({ settings: memKv(CREDS), clientFactory: factory })
    expect(mgr.authStorageKey()).toBe(storagePrefix() + 'auth')
    await mgr.signIn('grace@clinic.example', 'pw')
    expect(created).toHaveLength(1)
    // Demo/preview builds change storagePrefix(), which changes this key,
    // which is exactly how they are prevented from sharing a session.
    expect(created[0]?.storageKey).toBe(storagePrefix() + 'auth')
  })

  it('signIn caches the access token for synchronous use', async () => {
    const { factory } = fakeClientFactory()
    const mgr = createSessionManager({ settings: memKv(CREDS), clientFactory: factory })
    expect(mgr.getAccessToken()).toBeNull()
    const r = await mgr.signIn('grace@clinic.example', 'pw')
    expect(r.ok).toBe(true)
    expect(mgr.getAccessToken()).toBe('tok-1')
  })

  it('surfaces the server sign-in error VERBATIM', async () => {
    const { factory } = fakeClientFactory({ signInError: 'Invalid login credentials' })
    const mgr = createSessionManager({ settings: memKv(CREDS), clientFactory: factory })
    const r = await mgr.signIn('grace@clinic.example', 'wrong')
    expect(r).toEqual({ ok: false, error: 'Invalid login credentials' })
  })

  it('refuses kindly on a device with no cloud credentials', async () => {
    const { factory, created } = fakeClientFactory()
    const mgr = createSessionManager({ settings: memKv(), clientFactory: factory })
    const r = await mgr.signIn('grace@clinic.example', 'pw')
    expect(r).toEqual({ ok: false, error: NO_CLOUD_ERROR })
    expect(created).toHaveLength(0)
  })

  it('feeds the sync-layer token provider while signed in, and stops on sign-out', async () => {
    const { factory } = fakeClientFactory()
    const mgr = createSessionManager({
      settings: memKv(CREDS),
      clientFactory: factory,
      registerTokenProvider: true,
    })
    expect(supabaseHeaders('sb_publishable_x').Authorization).toBeUndefined()
    await mgr.signIn('grace@clinic.example', 'pw')
    expect(supabaseHeaders('sb_publishable_x').Authorization).toBe('Bearer tok-1')
    await mgr.signOut()
    expect(supabaseHeaders('sb_publishable_x').Authorization).toBeUndefined()
  })

  it('sign-out is LOCAL scope and clears the cached profile', async () => {
    const { factory, signOuts } = fakeClientFactory()
    const settings = memKv(CREDS)
    settings.data.set(PROFILE_CACHE_KEY, { userId: 'u1' })
    const mgr = createSessionManager({ settings, clientFactory: factory })
    await mgr.signIn('grace@clinic.example', 'pw')
    await mgr.signOut()
    // 'local' scope: a shared clinic iPad signing out must never revoke the
    // same account's session on another device.
    expect(signOuts).toEqual([{ scope: 'local' }])
    expect(settings.data.has(PROFILE_CACHE_KEY)).toBe(false)
    expect(mgr.getAccessToken()).toBeNull()
  })

  it('init is a no-op without a persisted session (field-mode boots stay light)', async () => {
    const { factory, created } = fakeClientFactory()
    const mgr = createSessionManager({ settings: memKv(CREDS), clientFactory: factory })
    await mgr.init()
    expect(created).toHaveLength(0)
    expect(mgr.getAccessToken()).toBeNull()
  })

  it('init primes a persisted session', async () => {
    const { factory } = fakeClientFactory({ persisted: SESSION })
    const mgr = createSessionManager({ settings: memKv(CREDS), clientFactory: factory })
    localStorage.setItem(storagePrefix() + 'auth', '{"stored":"session"}')
    try {
      await mgr.init()
      expect(mgr.getAccessToken()).toBe('tok-1')
    } finally {
      localStorage.removeItem(storagePrefix() + 'auth')
    }
  })
})

// ---------------------------------------------------------------------------
// Profile state machine
// ---------------------------------------------------------------------------

describe('profile state machine', () => {
  it('signedOut when there is no session', async () => {
    const { deps, requests } = profileDeps({ session: null })
    expect(await loadProfile(deps)).toEqual({ state: 'signedOut' })
    expect(requests).toHaveLength(0)
  })

  it('pending while activated_at is null - signup grants NOTHING', async () => {
    const { deps } = profileDeps({ rows: [row({})] })
    expect(await loadProfile(deps)).toEqual({
      state: 'pending',
      displayName: 'Grace N.',
      offline: false,
    })
  })

  it('active maps role, admin flag and display name, and caches the profile', async () => {
    const { deps, settings } = profileDeps({
      rows: [row({ activated_at: '2026-08-01T00:00:00Z', role: 'nurse', is_admin: true })],
    })
    const s = await loadProfile(deps)
    expect(s.state).toBe('active')
    if (s.state !== 'active') return
    expect(s.fromCache).toBe(false)
    expect(s.stale).toBe(false)
    expect(s.profile).toEqual({
      userId: 'u1',
      displayName: 'Grace N.',
      role: 'nurse',
      isAdmin: true,
      confirmedAt: new Date(NOW).toISOString(),
    })
    expect(settings.data.get(PROFILE_CACHE_KEY)).toEqual(s.profile)
  })

  it('revoked wins even when activated_at is also set', async () => {
    const { deps } = profileDeps({
      rows: [row({ activated_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-20T00:00:00Z' })],
    })
    expect(await loadProfile(deps)).toEqual({ state: 'revoked', displayName: 'Grace N.' })
  })

  it('a LIVE pending or revoked verdict clears the cached active profile', async () => {
    const settings = memKv()
    settings.data.set(PROFILE_CACHE_KEY, { userId: 'u1', confirmedAt: new Date(NOW).toISOString() })
    const { deps } = profileDeps({ settings, rows: [row({ revoked_at: '2026-08-20T00:00:00Z' })] })
    await loadProfile(deps)
    expect(settings.data.has(PROFILE_CACHE_KEY)).toBe(false)
  })

  it('a missing profile row reads as pending (the signup trigger has not landed)', async () => {
    const { deps } = profileDeps({ rows: [] })
    expect(await loadProfile(deps)).toEqual({
      state: 'pending',
      displayName: 'grace',
      offline: false,
    })
  })

  it('401 means the server refused the session: signedOut, cache cleared', async () => {
    const settings = memKv()
    settings.data.set(PROFILE_CACHE_KEY, { userId: 'u1', confirmedAt: new Date(NOW).toISOString() })
    const { deps } = profileDeps({ settings, rows: { message: 'JWT expired' }, status: 401 })
    expect(await loadProfile(deps)).toEqual({ state: 'signedOut' })
    expect(settings.data.has(PROFILE_CACHE_KEY)).toBe(false)
  })

  it('OFFLINE BOOT: an unreachable server falls back to the cached active profile', async () => {
    const cached: ActiveProfile = {
      userId: 'u1',
      displayName: 'Grace N.',
      role: 'provider',
      isAdmin: false,
      confirmedAt: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1 hour old
    }
    const settings = memKv()
    settings.data.set(PROFILE_CACHE_KEY, cached)
    const { deps } = profileDeps({ settings, fail: true })
    expect(await loadProfile(deps)).toEqual({
      state: 'active',
      profile: cached,
      fromCache: true,
      stale: false,
    })
  })

  it('a cache older than 7 days still works but is flagged stale (the nudge)', async () => {
    const cached: ActiveProfile = {
      userId: 'u1',
      displayName: 'Grace N.',
      role: 'provider',
      isAdmin: false,
      confirmedAt: new Date(NOW - PROFILE_STALE_MS - 1000).toISOString(),
    }
    const settings = memKv()
    settings.data.set(PROFILE_CACHE_KEY, cached)
    const { deps } = profileDeps({ settings, fail: true })
    const s = await loadProfile(deps)
    expect(s.state).toBe('active')
    if (s.state === 'active') {
      expect(s.fromCache).toBe(true)
      expect(s.stale).toBe(true)
    }
  })

  it("another user's cache is IGNORED offline - a shared device never boots into someone else's access", async () => {
    const settings = memKv()
    settings.data.set(PROFILE_CACHE_KEY, {
      userId: 'someone-else',
      displayName: 'Not Grace',
      role: 'provider',
      isAdmin: true,
      confirmedAt: new Date(NOW).toISOString(),
    })
    const { deps } = profileDeps({ settings, fail: true })
    expect(await loadProfile(deps)).toEqual({
      state: 'pending',
      displayName: 'grace',
      offline: true,
    })
  })

  it('offline with no cache: pending with the offline flag - never an open door', async () => {
    const { deps } = profileDeps({ fail: true })
    expect(await loadProfile(deps)).toEqual({
      state: 'pending',
      displayName: 'grace',
      offline: true,
    })
  })

  it('a 5xx is connectivity, not a verdict: the cache keeps working', async () => {
    const cached: ActiveProfile = {
      userId: 'u1',
      displayName: 'Grace N.',
      role: 'provider',
      isAdmin: false,
      confirmedAt: new Date(NOW).toISOString(),
    }
    const settings = memKv()
    settings.data.set(PROFILE_CACHE_KEY, cached)
    const { deps } = profileDeps({ settings, rows: 'gateway timeout', status: 503 })
    const s = await loadProfile(deps)
    expect(s.state).toBe('active')
    expect(settings.data.has(PROFILE_CACHE_KEY)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Org mode
// ---------------------------------------------------------------------------

describe('org mode signal', () => {
  it('absent means field (v3 orgs upgrade in place)', async () => {
    expect(await getOrgMode(memKv())).toBe('field')
  })

  it('reads the server value shape', async () => {
    expect(await getOrgMode(memKv({ orgMode: { mode: 'clinic' } }))).toBe('clinic')
    expect(await getOrgMode(memKv({ orgMode: { mode: 'field' } }))).toBe('field')
  })

  it('garbage fails toward field, never toward locking a working clinic out', async () => {
    expect(await getOrgMode(memKv({ orgMode: 42 }))).toBe('field')
    expect(await getOrgMode(memKv({ orgMode: { mode: 'CLINIC' } }))).toBe('field')
  })

  it('subscription fires once with the current mode, again on change, silent when unchanged', async () => {
    const kv = memKv()
    let trigger: () => void = () => {}
    const seen: OrgMode[] = []
    const unsub = subscribeOrgMode((m) => seen.push(m), {
      kv,
      onConfigUpdated: (cb) => {
        trigger = cb
        return () => {}
      },
    })
    await tick()
    expect(seen).toEqual(['field'])

    await kv.set('orgMode', { mode: 'clinic' })
    trigger()
    await tick()
    expect(seen).toEqual(['field', 'clinic'])

    trigger() // config pulled again, mode unchanged: no re-fire
    await tick()
    expect(seen).toEqual(['field', 'clinic'])
    unsub()
  })
})

// ---------------------------------------------------------------------------
// authedRequest: the one bearer-token REST seam for clinic features
// ---------------------------------------------------------------------------

describe('authedRequest', () => {
  it('joins the stored project URL and sends apikey + session bearer', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = []
    const transport: Transport = async (url, options) => {
      calls.push({ url, headers: (options?.headers ?? {}) as Record<string, string> })
      return jsonRes([])
    }
    await authedRequest('/rest/v1/users_profiles?select=id', undefined, {
      transport,
      settings: memKv(CREDS),
      getAccessToken: () => 'tok-9',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://proj.supabase.co/rest/v1/users_profiles?select=id')
    expect(calls[0]?.headers.apikey).toBe(CREDS.supabaseKey)
    expect(calls[0]?.headers.Authorization).toBe('Bearer tok-9')
  })

  it('refuses without a session instead of quietly sending an anon request', async () => {
    await expect(
      authedRequest('/rest/v1/users_profiles', undefined, {
        transport: async () => jsonRes([]),
        settings: memKv(CREDS),
        getAccessToken: () => null,
      }),
    ).rejects.toThrow(NO_SESSION_ERROR)
  })

  it("postgrestErrorMessage surfaces the server's trigger strings VERBATIM", async () => {
    const res = jsonRes({ message: 'Only an administrator can approve an account.' }, 403)
    expect(await postgrestErrorMessage(res)).toBe('Only an administrator can approve an account.')
  })

  it('postgrestErrorMessage stays honest on a non-JSON body', async () => {
    const res = new Response('<html>bad gateway</html>', { status: 502 })
    expect(await postgrestErrorMessage(res)).toBe('The server refused the request (HTTP 502).')
  })
})

// ---------------------------------------------------------------------------
// Sync engine transport: bearer only while a session exists
// ---------------------------------------------------------------------------

describe('sync engine requests and the session token', () => {
  function makeEngine() {
    const requests: { url: string; headers: Record<string, string> }[] = []
    const transport: Transport = async (url, options) => {
      requests.push({ url, headers: (options?.headers ?? {}) as Record<string, string> })
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
    })
    engine.updateCredentials(CREDS.supabaseUrl, CREDS.supabaseKey)
    return { engine, requests }
  }

  it('carries Authorization: Bearer <access token> on EVERY request while signed in', async () => {
    const { engine, requests } = makeEngine()
    setAccessTokenProvider(() => 'tok-42')
    await engine.syncNow()
    expect(requests.length).toBeGreaterThan(0)
    for (const r of requests) {
      expect(r.headers.apikey).toBe(CREDS.supabaseKey)
      expect(r.headers.Authorization).toBe('Bearer tok-42')
    }
  })

  it('with no session there is ZERO change: publishable key, no bearer', async () => {
    const { engine, requests } = makeEngine()
    setAccessTokenProvider(() => null)
    await engine.syncNow()
    expect(requests.length).toBeGreaterThan(0)
    for (const r of requests) {
      expect(r.headers.apikey).toBe(CREDS.supabaseKey)
      expect(r.headers.Authorization).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// Fleet row recovery + author identity publishing (integrator fixes)
// ---------------------------------------------------------------------------

describe('ensureFleetRow', () => {
  const memKv = (): KV => {
    const m = new Map<string, unknown>()
    return {
      get: async <T,>(k: string) => (m.has(k) ? (m.get(k) as T) : null),
      set: async (k: string, v: unknown) => void m.set(k, v),
      remove: async (k: string) => void m.delete(k),
    }
  }

  it('re-asserts the device row under the signed-in role with ignore-duplicates', async () => {
    // A device that first connected while the org was already in clinic
    // mode could never register through the shared key; without this POST
    // its pushes are rejected by the records policies with no visible cause.
    const kv = memKv()
    await kv.set('deviceId', 'dev-clinic-1')
    await kv.set('deviceName', 'Reception iPad')
    const calls: Array<{ url: string; init?: RequestInit }> = []
    const transport: Transport = async (url, init) => {
      calls.push({ url, init })
      return new Response('[]', { status: 201 })
    }
    const ok = await ensureFleetRow({
      kv,
      transport,
      url: 'https://org.supabase.co',
      key: 'sb_publishable_x',
    })
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://org.supabase.co/rest/v1/devices')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['Prefer']).toBe('resolution=ignore-duplicates')
    const body = JSON.parse(String(call.init?.body)) as Record<string, unknown>
    expect(body.id).toBe('dev-clinic-1')
    expect(body.role).toBe('standard')
  })

  it('does nothing without a registered device id', async () => {
    const calls: unknown[] = []
    const transport: Transport = async (url) => {
      calls.push(url)
      return new Response('[]', { status: 201 })
    }
    const ok = await ensureFleetRow({
      kv: memKv(),
      transport,
      url: 'https://org.supabase.co',
      key: 'sb_publishable_x',
    })
    expect(ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('author identity publishing', () => {
  it('clears the kernel author id when no account is signed in', async () => {
    // Removing the publish line in loadCurrentProfile leaves a stale author
    // on the kernel after sign-out, attributing visits to an account that
    // can no longer write.
    setCurrentUserId('stale-user-id')
    const state = await loadCurrentProfile()
    expect(state.state).toBe('signedOut')
    expect(getCurrentUserId()).toBeNull()
  })
})
