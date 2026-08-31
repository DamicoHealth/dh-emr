/**
 * Clinic-mode session management over Supabase Auth (email + password only).
 *
 * Scope rules, each one deliberate:
 *  - ONLY supabase-js's auth surface is used. Records and config traffic
 *    stays with the sync engine's proven transport; adopting the postgrest
 *    client here would create a second, unproven replication path.
 *  - Session persistence is NAMESPACED per storage suffix (the storageKey
 *    option below is storagePrefix() + 'auth', e.g. dhemr_auth in
 *    production, dhemr-demo_auth in the demo build), so a demo or preview
 *    build on the same origin can never share a session with production.
 *  - OFFLINE NEVER STOPS WORKING. A signed-in device that loses
 *    connectivity keeps functioning on its persisted session and the cached
 *    profile (src/auth/profile.ts). This is an honest limit, not an
 *    oversight: the server cannot be asked about a token it cannot see, so
 *    revocation is enforced server-side the moment the device reconnects -
 *    every authed request then fails and the profile reload lands on the
 *    revoked screen. The alternative (locking the app when the token cannot
 *    be refreshed) would take a clinic offline mid-day.
 *  - The access token is published to src/sync/keys.ts through
 *    setAccessTokenProvider, so every sync-engine request carries
 *    `Authorization: Bearer <access token>` while a session exists and is
 *    byte-identical to field mode when none does.
 */
import { createClient } from '@supabase/supabase-js'
import type { KV } from '../kernel/api'
import { settings as kernelSettings, storagePrefix } from '../kernel'
import { setAccessTokenProvider } from '../sync/keys'
import { clearCachedProfile } from './profile'

/**
 * The slice of a Supabase session this app uses. supabase-js's Session is
 * structurally assignable to it; fakes in tests implement just this.
 */
export interface AuthSession {
  access_token: string
  user: { id: string; email?: string | null }
}

/** The slice of the supabase-js auth client this module calls. */
export interface AuthClientAuth {
  signInWithPassword(creds: {
    email: string
    password: string
  }): Promise<{ data: { session: AuthSession | null }; error: { message: string } | null }>
  signUp(creds: {
    email: string
    password: string
    options?: { data?: Record<string, unknown> }
  }): Promise<{ data: { session: AuthSession | null }; error: { message: string } | null }>
  signOut(opts?: {
    scope?: 'local' | 'global' | 'others'
  }): Promise<{ error: { message: string } | null }>
  getSession(): Promise<{ data: { session: AuthSession | null } }>
  onAuthStateChange(cb: (event: string, session: AuthSession | null) => void): {
    data: { subscription: { unsubscribe(): void } }
  }
}

export interface AuthClientLike {
  auth: AuthClientAuth
}

export type AuthClientFactory = (url: string, key: string, storageKey: string) => AuthClientLike

/**
 * The real client. detectSessionInUrl is off (no OAuth redirects in this
 * app); autoRefreshToken keeps a long clinic day signed in. The cast is a
 * narrowing to the slice above, not a widening: supabase-js's auth client
 * implements every method with compatible shapes.
 */
const defaultClientFactory: AuthClientFactory = (url, key, storageKey) =>
  createClient(url, key, {
    auth: {
      storageKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }) as unknown as AuthClientLike

export type SignInResult = { ok: true } | { ok: false; error: string }
export type SignUpResult =
  | { ok: true; needsSignIn: boolean }
  | { ok: false; error: string }

export interface SessionManager {
  /**
   * Prime a persisted session at boot, cheaply: when no cloud credentials
   * or no persisted session exist this touches nothing (field-mode boots
   * stay free of auth work). Errors never propagate; boot must not break.
   */
  init(): Promise<void>
  signIn(email: string, password: string): Promise<SignInResult>
  /** displayName lands in raw_user_meta_data; the server's signup trigger copies it into the profile row. */
  signUp(email: string, password: string, displayName: string): Promise<SignUpResult>
  /** Local sign-out (works offline) plus cached-profile clear. */
  signOut(): Promise<void>
  getSession(): Promise<AuthSession | null>
  /** Synchronous last-known token; what the header provider serves. */
  getAccessToken(): string | null
  onAuthChange(cb: (session: AuthSession | null) => void): () => void
  /** The namespaced supabase-js storage key this manager persists under. */
  authStorageKey(): string
}

export interface SessionManagerDeps {
  settings?: KV
  clientFactory?: AuthClientFactory
  /**
   * Publish this manager's token to src/sync/keys.ts. Exactly ONE manager
   * (the app-wide singleton below) should do this; test instances opt in
   * explicitly and must reset the provider afterwards.
   */
  registerTokenProvider?: boolean
}

/** Copy for auth attempts on a device with no cloud project configured. */
export const NO_CLOUD_ERROR =
  'This device is not connected to a cloud project yet. Set that up in Settings first.'

export function createSessionManager(deps: SessionManagerDeps = {}): SessionManager {
  const settings = deps.settings ?? kernelSettings
  const clientFactory = deps.clientFactory ?? defaultClientFactory

  const storageKey = storagePrefix() + 'auth'

  let client: AuthClientLike | null = null
  let clientCreds = ''
  let currentSession: AuthSession | null = null
  const listeners = new Set<(s: AuthSession | null) => void>()

  if (deps.registerTokenProvider) {
    setAccessTokenProvider(() => (currentSession ? currentSession.access_token : null))
  }

  function adopt(session: AuthSession | null): void {
    currentSession = session
    listeners.forEach((cb) => {
      try {
        cb(session)
      } catch {
        /* a listener must not break the session layer */
      }
    })
  }

  async function getClient(): Promise<AuthClientLike | null> {
    const url = await settings.get<string>('supabaseUrl')
    const key = await settings.get<string>('supabaseKey')
    if (!url || !key) return null
    const creds = `${url}\n${key}`
    if (client && clientCreds === creds) return client
    client = clientFactory(url, key, storageKey)
    clientCreds = creds
    // Keep the cached session in step with refreshes and sign-outs that
    // happen inside supabase-js (auto refresh, another tab via storage).
    client.auth.onAuthStateChange((_event, session) => {
      adopt(session)
    })
    return client
  }

  async function init(): Promise<void> {
    try {
      const url = await settings.get<string>('supabaseUrl')
      const key = await settings.get<string>('supabaseKey')
      if (!url || !key) return
      // No persisted session under our namespaced key means nothing to
      // prime; skip client creation so field-mode-shaped boots stay light.
      let persisted: string | null = null
      try {
        persisted = localStorage.getItem(storageKey)
      } catch {
        /* storage unavailable; let getSession decide */
      }
      if (persisted === null) return
      const c = await getClient()
      if (!c) return
      const { data } = await c.auth.getSession()
      adopt(data.session)
    } catch {
      /* boot must not break on auth plumbing */
    }
  }

  async function signIn(email: string, password: string): Promise<SignInResult> {
    const c = await getClient()
    if (!c) return { ok: false, error: NO_CLOUD_ERROR }
    try {
      const { data, error } = await c.auth.signInWithPassword({ email, password })
      // Server error strings surface VERBATIM: the caller shows them as-is.
      if (error) return { ok: false, error: error.message }
      adopt(data.session)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function signUp(
    email: string,
    password: string,
    displayName: string,
  ): Promise<SignUpResult> {
    const c = await getClient()
    if (!c) return { ok: false, error: NO_CLOUD_ERROR }
    try {
      const { data, error } = await c.auth.signUp({
        email,
        password,
        options: { data: { display_name: displayName } },
      })
      if (error) return { ok: false, error: error.message }
      // With email confirmation off (SETUP.md section 4) a session comes
      // back immediately and the profile gate will show "awaiting approval".
      // With confirmation on (misconfigured org) there is no session yet.
      adopt(data.session)
      return { ok: true, needsSignIn: data.session === null }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async function signOut(): Promise<void> {
    // scope 'local': clear THIS device's session. It works offline, and a
    // shared clinic iPad signing out must never revoke the same account's
    // session on someone else's device.
    try {
      const c = await getClient()
      if (c) await c.auth.signOut({ scope: 'local' })
    } catch {
      /* the local clear below still runs */
    }
    adopt(null)
    // A signed-out device must not boot into the previous user's cached
    // profile.
    await clearCachedProfile(settings)
  }

  async function getSession(): Promise<AuthSession | null> {
    const c = await getClient()
    if (!c) return null
    try {
      const { data } = await c.auth.getSession()
      if (data.session) {
        currentSession = data.session
        return data.session
      }
      // Honest offline limit: supabase-js can report null mid-refresh
      // hiccup; the last-known session keeps an offline clinic working and
      // the server re-arbitrates the moment a request reaches it.
      return currentSession
    } catch {
      return currentSession
    }
  }

  return {
    init,
    signIn,
    signUp,
    signOut,
    getSession,
    getAccessToken: () => (currentSession ? currentSession.access_token : null),
    onAuthChange: (cb) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    authStorageKey: () => storageKey,
  }
}

/**
 * The app-wide session manager: real kernel settings, real supabase-js,
 * and the ONE registration of the sync-layer token provider.
 */
export const authSession: SessionManager = createSessionManager({ registerTokenProvider: true })
