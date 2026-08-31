/**
 * The account state machine for clinic mode.
 *
 * The server (users_profiles + RLS, supabase/setup.sql) is the authority:
 * signing up grants NOTHING, every profile starts pending, and only an
 * admin can activate or revoke. This module just asks the server where the
 * caller stands and answers in four states:
 *
 *   signedOut  no session on this device
 *   pending    profile row exists (or is not yet visible) with
 *              activated_at null - awaiting admin approval
 *   revoked    revoked_at is set - the kill switch
 *   active     activated, not revoked (+ role, isAdmin, displayName)
 *
 * OFFLINE-FIRST RULE: the last-known ACTIVE profile is cached in kernel
 * settings with a confirmation timestamp. When the profile read cannot
 * reach the server, a device with a matching cached profile keeps working -
 * a clinic must not stop because the wifi did. A cache older than
 * PROFILE_STALE_MS (7 days) is still honored but flagged stale so the shell
 * can show a "reconnect to confirm your account" nudge. This is an honest
 * limit: revocation is enforced server-side the moment the device
 * reconnects (every request then fails and the next profile load lands on
 * the revoked screen); nothing client-side can enforce it sooner.
 *
 * A LIVE server answer always wins over the cache, in both directions:
 * pending/revoked/missing clears the cached profile immediately.
 */
import type { KV } from '../kernel/api'
import { settings as kernelSettings } from '../kernel'
import type { AuthSession } from './session'

/** Settings key holding the cached last-known-active profile. */
export const PROFILE_CACHE_KEY = 'authProfile'

/** Cache age past which the shell nudges "reconnect to confirm your account". */
export const PROFILE_STALE_MS = 7 * 24 * 60 * 60 * 1000

export interface ActiveProfile {
  userId: string
  displayName: string
  /** Clinical station role (reception | nurse | provider | pharmacy | org-defined). */
  role: string
  isAdmin: boolean
  /** ISO timestamp of the last LIVE server confirmation of this profile. */
  confirmedAt: string
}

export type ProfileState =
  | { state: 'signedOut' }
  | {
      state: 'pending'
      displayName: string
      /** True when the answer is a guess because the server was unreachable. */
      offline: boolean
    }
  | { state: 'revoked'; displayName: string }
  | {
      state: 'active'
      profile: ActiveProfile
      /** True when served from the offline cache, not a live server read. */
      fromCache: boolean
      /** True when the cache is older than PROFILE_STALE_MS. */
      stale: boolean
    }

/** The users_profiles columns this module reads. */
interface ProfileRow {
  id?: string
  display_name?: string | null
  role?: string | null
  is_admin?: boolean
  activated_at?: string | null
  revoked_at?: string | null
}

/**
 * Fetch-shaped seam for the authed profile read; the default wiring
 * (src/auth/index.ts) plugs in authedRequest. Kept injectable so the state
 * machine is testable with zero network.
 */
export type ProfileRequest = (path: string) => Promise<Response>

export interface ProfileDeps {
  /** kernel settings KV (cache home). */
  settings?: KV
  /** The authed REST call. REQUIRED; see loadProfile in index.ts for the app wiring. */
  request: ProfileRequest
  /** Session source. */
  getSession: () => Promise<AuthSession | null>
  /** Clock, injectable for staleness tests. */
  now?: () => number
}

export async function clearCachedProfile(settings: KV = kernelSettings): Promise<void> {
  await settings.remove(PROFILE_CACHE_KEY)
}

function displayNameFrom(row: ProfileRow | null, session: AuthSession): string {
  if (row?.display_name) return row.display_name
  const email = session.user.email || ''
  return email.includes('@') ? (email.split('@')[0] ?? '') : email
}

/**
 * Where does the signed-in caller stand? One authed read of the caller's
 * own users_profiles row (RLS always allows reading your own row, even
 * pending or revoked - the server design depends on it so this screen can
 * exist).
 */
export async function loadProfile(deps: ProfileDeps): Promise<ProfileState> {
  const settings = deps.settings ?? kernelSettings
  const now = deps.now ?? Date.now

  const session = await deps.getSession()
  if (!session) return { state: 'signedOut' }
  const uid = session.user.id

  let res: Response
  try {
    res = await deps.request(
      `/rest/v1/users_profiles?id=eq.${encodeURIComponent(uid)}` +
        `&select=id,display_name,role,is_admin,activated_at,revoked_at&limit=1`,
    )
  } catch {
    return cacheFallback(settings, session, now)
  }

  if (res.status === 401 || res.status === 403) {
    // The server SAW the token and refused it. That is not connectivity -
    // it is the server saying this session no longer stands, so the cache
    // must not keep the door open.
    await clearCachedProfile(settings)
    return { state: 'signedOut' }
  }
  if (!res.ok) {
    // 5xx and other surprises are treated as unreachable, not as a verdict.
    return cacheFallback(settings, session, now)
  }

  let rows: ProfileRow[]
  try {
    rows = (await res.json()) as ProfileRow[]
  } catch {
    return cacheFallback(settings, session, now)
  }

  const row = rows[0] ?? null
  if (!row) {
    // The signup trigger creates the row, so a missing one means it has not
    // landed (or was removed). Functionally identical to awaiting approval:
    // the account grants nothing yet. A live answer, so the cache clears.
    await clearCachedProfile(settings)
    return { state: 'pending', displayName: displayNameFrom(null, session), offline: false }
  }

  if (row.revoked_at) {
    await clearCachedProfile(settings)
    return { state: 'revoked', displayName: displayNameFrom(row, session) }
  }

  if (!row.activated_at) {
    await clearCachedProfile(settings)
    return { state: 'pending', displayName: displayNameFrom(row, session), offline: false }
  }

  const profile: ActiveProfile = {
    userId: uid,
    displayName: displayNameFrom(row, session),
    role: row.role || 'provider',
    isAdmin: row.is_admin === true,
    confirmedAt: new Date(now()).toISOString(),
  }
  await settings.set(PROFILE_CACHE_KEY, profile)
  return { state: 'active', profile, fromCache: false, stale: false }
}

/** The server was unreachable: fall back to the cached ACTIVE profile. */
async function cacheFallback(
  settings: KV,
  session: AuthSession,
  now: () => number,
): Promise<ProfileState> {
  const cached = await settings.get<ActiveProfile>(PROFILE_CACHE_KEY)
  // The cache must belong to THIS session's user: a shared device where a
  // different person signed in must never boot into the previous user's
  // access.
  if (cached && cached.userId === session.user.id && cached.confirmedAt) {
    const age = now() - Date.parse(cached.confirmedAt)
    return {
      state: 'active',
      profile: cached,
      fromCache: true,
      stale: !(age < PROFILE_STALE_MS), // NaN-safe: an unparsable stamp reads stale
    }
  }
  // Signed in, unreachable server, no usable cache: the account has never
  // been confirmed active from this device, so nothing may open. Pending
  // with the offline flag lets the screen say so kindly.
  return { state: 'pending', displayName: displayNameFrom(null, session), offline: true }
}
