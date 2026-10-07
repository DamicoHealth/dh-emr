/**
 * Join links: how a Clinic device learns its project without anyone typing
 * a project address or a key.
 *
 * An admin's device turns its own stored credentials into a URL of the form
 *
 *   https://damicohealth.com/clinic/#join=<base64url(JSON)>
 *
 * and shows it as text and as a QR code (src/lib/qr.ts). A new device opens
 * the link, the Clinic shell reads the fragment at boot, verifies the
 * project's tables, stores the credentials, registers the device and lands
 * on sign-in. Staff then create their own account, which an admin approves.
 *
 * WHAT THE LINK CARRIES, AND WHY THAT IS FINE. The payload is exactly
 * { v, url, key, orgName }: the project address, the PUBLISHABLE key (or
 * the legacy anon key) and a display name for the organization. The
 * publishable key is public by design: every device on the org holds it,
 * it reaches the browser in every request, and in clinic mode it unlocks
 * nothing on its own - the row-level rules require a signed-in, approved
 * account for every read and write (supabase/setup.sql). A stranger with
 * the link can create an account that waits, invisible, for an admin's
 * approval. Share it with staff, not the public, but it is not a secret.
 *
 * What the link must NEVER carry: a server key (service_role or sb_secret_,
 * rejected on parse with the exact SERVER_KEY_ERROR, the same gate every
 * typed-key UI uses), a password, a session token, or anything else. The
 * encoder refuses to build one from a server key, and the parser refuses
 * to accept one, so a hand-made link cannot smuggle a server key onto a
 * device either.
 *
 * The payload rides in the URL FRAGMENT on purpose: fragments never leave
 * the browser, so the key does not land in the static host's access logs
 * or in a proxy's. base64url (RFC 4648 section 5, no padding) keeps the
 * link free of characters that chat apps, mail clients and QR readers
 * mangle, and keeps the QR in byte mode with no escaping.
 */
import type { KV } from '../kernel/api'
import { settings as kernelSettings } from '../kernel'
import type { SyncEngine } from './engine'
import { syncEngine as appSyncEngine } from './engine'
import { classifySupabaseKey, normalizeSupabaseUrl } from './keys'

/** The URL fragment parameter that carries the payload. */
export const JOIN_PARAM = 'join'

/** Payload format version. Bump only with a reader-side change. */
export const JOIN_LINK_VERSION = 1

/** Longest organization name a link carries; longer is truncated on encode. */
export const ORG_NAME_MAX = 80

/** Settings key for the organization name a device learned (or typed). */
export const ORG_NAME_SETTING = 'orgName'

/** Exact copy for a link whose payload cannot be read. */
export const JOIN_LINK_MALFORMED_ERROR =
  'That join link is damaged or incomplete. Ask your admin to send it again.'

/** Exact copy for a link made by a newer app version. */
export const JOIN_LINK_VERSION_ERROR =
  'That join link was made by a newer version of DH EMR Clinic. Update this app, then open the link again.'

export interface JoinPayload {
  /** Normalized Supabase project URL (https://<ref>.supabase.co). */
  url: string
  /** The publishable key or the legacy anon key. Never a server key. */
  key: string
  /** Display name of the organization; may be empty. */
  orgName: string
}

export type JoinLinkRead =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'ok'; payload: JoinPayload }

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

function base64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function base64urlDecode(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded)) return null
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  let binary: string
  try {
    binary = atob(padded)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * The address this app is served from, without query or fragment: the
 * origin plus the path (https://damicohealth.com/clinic/ in production, the
 * preview or dev origin elsewhere). A trailing index.html is dropped so
 * the link stays canonical.
 */
export function currentAppUrl(): string {
  if (typeof window === 'undefined' || !window.location) return '/'
  const path = window.location.pathname.replace(/index\.html$/, '')
  return `${window.location.origin}${path}`
}

/**
 * Build a join link. Throws with the exact keys.ts message when the URL or
 * key would not be accepted by a typed-entry UI (a server key included),
 * so the admin screen shows the reason instead of minting a bad link.
 */
export function encodeJoinLink(
  payload: { url: string; key: string; orgName?: string },
  opts: { appUrl?: string } = {},
): string {
  const norm = normalizeSupabaseUrl(payload.url)
  if (!norm.ok) throw new Error(norm.error)
  const cls = classifySupabaseKey(payload.key)
  if (!cls.ok) throw new Error(cls.error)
  const orgName = (payload.orgName ?? '').trim().slice(0, ORG_NAME_MAX)
  const json = JSON.stringify({
    v: JOIN_LINK_VERSION,
    url: norm.url,
    key: payload.key.trim(),
    orgName,
  })
  const appUrl = (opts.appUrl ?? currentAppUrl()).replace(/[?#].*$/, '')
  return `${appUrl}#${JOIN_PARAM}=${base64urlEncode(json)}`
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/** The raw join parameter from a hash or a full URL, or null when absent. */
function extractJoinParam(hashOrHref: string): string | null {
  const s = hashOrHref ?? ''
  const hashAt = s.indexOf('#')
  // A bare fragment ('#join=...' or 'join=...') or a full href.
  const fragment = hashAt >= 0 ? s.slice(hashAt + 1) : s.includes('://') || s.startsWith('/') ? '' : s
  if (!fragment) return null
  for (const part of fragment.split('&')) {
    const eq = part.indexOf('=')
    const name = eq >= 0 ? part.slice(0, eq) : part
    if (name !== JOIN_PARAM) continue
    return eq >= 0 ? part.slice(eq + 1) : ''
  }
  return null
}

/**
 * Read a join link with the reason when it is unusable. 'none' means the
 * URL carries no join parameter at all (an ordinary open of the app);
 * 'invalid' always carries copy fit to show on the wizard.
 */
export function readJoinLink(hashOrHref: string): JoinLinkRead {
  const raw = extractJoinParam(hashOrHref)
  if (raw === null) return { kind: 'none' }
  const invalid = (error: string): JoinLinkRead => ({ kind: 'invalid', error })

  const json = base64urlDecode(raw)
  if (json === null) return invalid(JOIN_LINK_MALFORMED_ERROR)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return invalid(JOIN_LINK_MALFORMED_ERROR)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid(JOIN_LINK_MALFORMED_ERROR)
  }
  const obj = parsed as Record<string, unknown>
  // Strict shape: exactly the known fields, so nothing else can ride along.
  const allowed = new Set(['v', 'url', 'key', 'orgName'])
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return invalid(JOIN_LINK_MALFORMED_ERROR)
  }
  if (typeof obj.v !== 'number' || !Number.isInteger(obj.v)) {
    return invalid(JOIN_LINK_MALFORMED_ERROR)
  }
  if (obj.v > JOIN_LINK_VERSION) return invalid(JOIN_LINK_VERSION_ERROR)
  if (obj.v !== JOIN_LINK_VERSION) return invalid(JOIN_LINK_MALFORMED_ERROR)
  if (typeof obj.url !== 'string' || typeof obj.key !== 'string') {
    return invalid(JOIN_LINK_MALFORMED_ERROR)
  }
  if (obj.orgName !== undefined && typeof obj.orgName !== 'string') {
    return invalid(JOIN_LINK_MALFORMED_ERROR)
  }
  const norm = normalizeSupabaseUrl(obj.url)
  if (!norm.ok) return invalid(norm.error)
  // The same gate as every typed-key UI: a server key never gets on a
  // device, link or no link, and the person sees the exact same sentence.
  const cls = classifySupabaseKey(obj.key)
  if (!cls.ok) return invalid(cls.error)
  return {
    kind: 'ok',
    payload: {
      url: norm.url,
      key: obj.key.trim(),
      orgName: (obj.orgName ?? '').trim().slice(0, ORG_NAME_MAX),
    },
  }
}

/** The payload of a valid join link, or null for anything else. */
export function parseJoinLink(hashOrHref: string): JoinPayload | null {
  const r = readJoinLink(hashOrHref)
  return r.kind === 'ok' ? r.payload : null
}

/**
 * The fragment with the join parameter removed: '' when nothing else was
 * in it (so the caller can replaceState to a clean URL), otherwise the
 * remaining '#...'.
 */
export function stripJoinParam(hash: string): string {
  const s = (hash ?? '').replace(/^#/, '')
  const rest = s
    .split('&')
    .filter((part) => {
      const eq = part.indexOf('=')
      return (eq >= 0 ? part.slice(0, eq) : part) !== JOIN_PARAM && part !== ''
    })
    .join('&')
  return rest ? `#${rest}` : ''
}

/** The host part of a project URL for confirm copy ("myproject.supabase.co"). */
export function projectHost(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

// ---------------------------------------------------------------------------
// Join: configure this device from a payload
// ---------------------------------------------------------------------------

export interface JoinDeps {
  /** The sync engine whose connectToProject verifies, stores and registers. */
  engine?: Pick<SyncEngine, 'connectToProject'>
  /** Settings KV; defaults to the kernel's. */
  settings?: KV
  /** Name for this device's fleet row; defaults to defaultJoinedDeviceName(). */
  deviceName?: string
}

export type JoinResult = { ok: true } | { ok: false; error: string }

/**
 * A device name when nobody typed one: the platform plus the local date,
 * so a fleet of joined iPads is at least tellable apart by day. Rename
 * later under Settings (rename never re-registers).
 */
export function defaultJoinedDeviceName(
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  today: Date = new Date(),
): string {
  const ua = userAgent || ''
  const platform = /iPad/.test(ua)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android device'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows PC'
            : 'Device'
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
  return `${platform} joined ${date}`
}

/**
 * Configure this device from a join payload: verify the project's tables,
 * store the credentials, register the device there (connectToProject's
 * exact semantics, re-registration included when switching projects),
 * remember the organization name, and mark setup complete.
 *
 * setupComplete is written LAST, as the wizard does. The sites and
 * clinicians lists are NOT collected here: a joined device belongs to an
 * org whose admin device already pushed its lists, and the first sync after
 * the account becomes active pulls them before anyone can file a visit.
 * Until then the visit form would show the shipped placeholders, which is
 * the documented behavior of an absent (not empty) list.
 *
 * Nothing is stored when verification fails: the device stays exactly as
 * it was, and the error is copy for the wizard.
 */
export async function joinProject(payload: JoinPayload, deps: JoinDeps = {}): Promise<JoinResult> {
  const engine = deps.engine ?? appSyncEngine
  const kv = deps.settings ?? kernelSettings
  const name = deps.deviceName ?? defaultJoinedDeviceName()
  try {
    const res = await engine.connectToProject(payload.url, payload.key, name, 'standard')
    if (!res.ok) {
      return {
        ok: false,
        error: res.error
          ? `Could not join ${payload.orgName || projectHost(payload.url)}: ${res.error}`
          : `Could not join ${payload.orgName || projectHost(payload.url)}: the project could not be verified.`,
      }
    }
  } catch (e) {
    return {
      ok: false,
      error: `Could not reach ${payload.orgName || projectHost(payload.url)}. Check the device is online and open the link again. (${e instanceof Error ? e.message : String(e)})`,
    }
  }
  await kv.set(ORG_NAME_SETTING, payload.orgName)
  await kv.set('setupComplete', 'true')
  return { ok: true }
}
