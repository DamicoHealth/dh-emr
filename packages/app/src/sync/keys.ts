/**
 * Supabase API key handling: classification, entry-point rejection, and the
 * ONE place request headers are built.
 *
 * Two kinds of client key exist and the difference is load-bearing. The
 * legacy anon key is a JWT and PostgREST accepts it in either header. The
 * current publishable key (sb_publishable_...) is NOT a JWT, and sending it
 * as `Authorization: Bearer` makes PostgREST try to parse it as one and
 * reject the request.
 *
 * This matters beyond tidiness: rotating a leaked legacy key means rotating
 * the project's JWT secret, which invalidates service_role at the same time.
 * Moving to a publishable key lets a compromised key be deleted on its own.
 *
 * tests/apiKeys.test.ts also enforces that NO other file in src/sync builds
 * an Authorization header by hand - every call site routes through
 * supabaseHeaders, or one forgotten fetch breaks key rotation on a path
 * nobody exercises until it matters.
 */

/** Prefixed keys are not JWTs and must never be sent as a bearer token. */
const PREFIXED_KEY = /^sb_(publishable|secret)_/

/**
 * Exact rejection copy for server keys. Every key-entry UI (setup wizard,
 * admin connect) shows this verbatim.
 */
export const SERVER_KEY_ERROR =
  'That is a server key (service_role or sb_secret). It bypasses every database security rule and must never go on a field device. Use the Publishable key, or the legacy anon key.'

/** Exact copy for an empty key at entry. */
export const EMPTY_KEY_ERROR = 'Paste the project anon key.'

/** Exact copy for a URL that is not a Supabase project URL. */
export const BAD_URL_ERROR =
  'That does not look like a Supabase project URL. It should look like https://yourproject.supabase.co'

export type SupabaseKeyKind = 'legacy-anon' | 'publishable'

export type KeyClassification =
  | { ok: true; kind: SupabaseKeyKind }
  | { ok: false; error: string }

/**
 * Classify a pasted key, REJECTING anything that must never live on a field
 * device. service_role JWTs and sb_secret_ keys bypass RLS entirely; the only
 * acceptable client keys are the legacy anon JWT and sb_publishable_.
 */
export function classifySupabaseKey(rawKey: string): KeyClassification {
  const k = (rawKey || '').trim()
  if (!k) return { ok: false, error: EMPTY_KEY_ERROR }
  if (/service_role/i.test(k) || /^sb_secret_/i.test(k)) {
    return { ok: false, error: SERVER_KEY_ERROR }
  }
  if (/^sb_publishable_/i.test(k)) return { ok: true, kind: 'publishable' }
  return { ok: true, kind: 'legacy-anon' }
}

/**
 * Normalize and validate a project URL: trailing slashes stripped, and the
 * shape must be https://<ref>.supabase.co exactly.
 */
export function normalizeSupabaseUrl(
  rawUrl: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const url = (rawUrl || '').trim().replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)) {
    return { ok: false, error: BAD_URL_ERROR }
  }
  return { ok: true, url }
}

// ---------------------------------------------------------------- sessions

/**
 * Clinic mode: the signed-in user's access token rides as the Authorization
 * bearer on every request, while the publishable key stays in `apikey`.
 *
 * The token is supplied through this provider hook rather than threaded
 * through every call site: the auth layer (src/auth/session.ts) registers a
 * provider when it manages a session, supabaseHeaders consults it per
 * request, and the sync engine needs zero changes. When no provider is
 * registered, or it returns null (no session), behavior is byte-identical
 * to the field-mode rules above - which is exactly why the hook lives HERE:
 * tests/apiKeys.test.ts forbids the word Bearer anywhere else in src/sync,
 * so this file stays the one place an Authorization header is ever built.
 */
export type AccessTokenProvider = () => string | null

let accessTokenProvider: AccessTokenProvider | null = null

/** Register (or clear, with null) the session access-token source. */
export function setAccessTokenProvider(provider: AccessTokenProvider | null): void {
  accessTokenProvider = provider
}

/**
 * Headers for a Supabase REST call. Always `apikey`. The Authorization
 * bearer is, in order of precedence:
 *   1. an explicit accessToken argument (clinic-feature calls that already
 *      hold the session token),
 *   2. the registered access-token provider (the signed-in session, so the
 *      sync engine's requests carry it without knowing about auth),
 *   3. the key itself, ONLY for the legacy anon JWT (see module header).
 * Caller-supplied extra headers pass through unchanged.
 */
export function supabaseHeaders(
  key: string | null | undefined,
  extra?: Record<string, string>,
  accessToken?: string | null,
): Record<string, string> {
  const k = key || ''
  const headers: Record<string, string> = { apikey: k, ...(extra || {}) }
  const token = accessToken ?? (accessTokenProvider ? accessTokenProvider() : null)
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  } else if (k && !PREFIXED_KEY.test(k)) {
    headers['Authorization'] = `Bearer ${k}`
  }
  return headers
}
