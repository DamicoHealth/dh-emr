/**
 * authedRequest: the ONE place clinic features make bearer-token REST calls
 * outside the sync engine (the staff screen's approve/revoke/promote
 * actions, the profile read, future admin actions).
 *
 * Header discipline: headers come from supabaseHeaders (src/sync/keys.ts)
 * with the session access token passed explicitly - the same single home
 * for Authorization logic that tests/apiKeys.test.ts enforces on the sync
 * engine. Nothing here (or anywhere else) hand-builds a bearer header.
 *
 * Error discipline for callers: this function returns the raw Response.
 * When the server's rules triggers raise (e.g. 'Only an administrator can
 * approve an account.'), PostgREST wraps the text in a JSON body's
 * `message` field - callers surface that string VERBATIM in the UI, because
 * those strings were written to be shown to people.
 */
import { settings as kernelSettings } from '../kernel'
import type { KV } from '../kernel/api'
import { supabaseHeaders } from '../sync/keys'
import { defaultTransport, type Transport } from '../sync/transport'
import { authSession } from './session'

/** Copy for authed calls attempted with no session. */
export const NO_SESSION_ERROR = 'You are signed out. Sign in and try again.'

export interface AuthedRequestDeps {
  /** network seam; defaults to real fetch. */
  transport?: Transport
  /** settings KV holding supabaseUrl/supabaseKey. */
  settings?: KV
  /** access-token source; defaults to the app session manager. */
  getAccessToken?: () => string | null
}

/**
 * Perform an authenticated Supabase REST call. `path` starts with '/'
 * (e.g. '/rest/v1/users_profiles?...') and is appended to the stored
 * project URL. Throws when the device has no cloud credentials or no
 * session - callers gate on both before offering the action.
 */
export async function authedRequest(
  path: string,
  init: RequestInit = {},
  deps: AuthedRequestDeps = {},
): Promise<Response> {
  const settings = deps.settings ?? kernelSettings
  const transport = deps.transport ?? defaultTransport
  const getAccessToken = deps.getAccessToken ?? (() => authSession.getAccessToken())

  const url = await settings.get<string>('supabaseUrl')
  const key = await settings.get<string>('supabaseKey')
  if (!url || !key) {
    throw new Error('This device is not connected to a cloud project.')
  }
  const token = getAccessToken()
  if (!token) {
    throw new Error(NO_SESSION_ERROR)
  }
  return transport(`${url}${path}`, {
    ...init,
    headers: supabaseHeaders(key, init.headers as Record<string, string> | undefined, token),
  })
}

/**
 * Read the human-facing error out of a PostgREST error response. Trigger
 * RAISE strings arrive in `message`; they are returned verbatim so the UI
 * can show exactly what the server said.
 */
export async function postgrestErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; hint?: string }
    if (body && typeof body.message === 'string' && body.message) return body.message
  } catch {
    /* not JSON */
  }
  return `The server refused the request (HTTP ${res.status}).`
}
