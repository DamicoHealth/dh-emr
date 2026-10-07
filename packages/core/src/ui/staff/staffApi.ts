/**
 * Staff management API (clinic mode) plus the org-mode master switch.
 *
 * Every network call goes through authedRequest (src/auth/api.ts) - the ONE
 * bearer-token REST seam for clinic features - injected here as a
 * fetch-shaped dep so tests drive the whole protocol with zero network.
 *
 * THE SERVER IS THE AUTHORITY. The rules trigger on users_profiles
 * (supabase/setup.sql section 4) decides who may approve, revoke, promote;
 * its RAISE strings were written to be shown to people and are surfaced
 * VERBATIM ('Only an administrator can approve an account.', 'You are the
 * only administrator. Make someone else an admin first.'). The UI disables
 * controls with reasons as a courtesy, never as the enforcement.
 *
 * HONEST OFFLINE LIMIT: none of these actions work offline, and none of
 * them reach a device that is offline. An approved account starts working
 * when its device next talks to the server; a revoked account keeps its
 * cached access until its device reconnects, at which point every request
 * fails server-side and the app lands on the revoked screen. Nothing
 * client-side can enforce it sooner, so nothing here pretends to.
 */
import { authedRequest, postgrestErrorMessage } from '../../auth/api'
import type { OrgMode } from '../../auth/orgMode'
import { ROLES } from '../../config/roles'
import { config as kernelConfig } from '../../kernel'
import type { KV } from '../../kernel/api'

// ---------------------------------------------------------------------------
// Types and copy
// ---------------------------------------------------------------------------

/** The users_profiles columns the staff screen works with. */
export interface StaffRow {
  id: string
  display_name: string
  role: string
  is_admin: boolean
  activated_at: string | null
  revoked_at: string | null
  created_at: string | null
}

export type StaffStatus = 'pending' | 'active' | 'revoked'

/**
 * The station roles offered by the role select: the fixed Clinic roles
 * (src/config/roles.ts). role is TEXT on the server by design (the client
 * enforces the list, like devices.role); a row whose role is outside this
 * list (the pre-split 'nurse', for one) still renders - the select adds it
 * as an extra option rather than lying about the stored value.
 */
export const STATION_ROLES = ROLES

/** Reason shown on every disabled control when the viewer is not an admin. */
export const NOT_ADMIN_REASON = 'Only an administrator can manage staff accounts.'

/**
 * Reason shown on the sole admin's own Revoke / Remove admin controls.
 * Deliberately the EXACT string the server's trigger raises, so the person
 * reads the same sentence whether the UI catches it first or the server does.
 */
export const LAST_ADMIN_REASON =
  'You are the only administrator. Make someone else an admin first.'

/**
 * A PATCH that matches zero rows is a silent 200 with an empty
 * representation, not an error: RLS USING quietly filters rows the caller
 * may not update (a non-admin patching someone else's account lands exactly
 * here). Refusing to pretend it worked is the client half of non-admin
 * gating; the trigger errors are the server half.
 */
export const NOT_APPLIED_ERROR =
  'The server did not apply the change. Your account may not have permission to change this account.'

// ---------------------------------------------------------------------------
// Request seam
// ---------------------------------------------------------------------------

export type StaffRequest = (path: string, init?: RequestInit) => Promise<Response>

export interface StaffApiDeps {
  /** The authed REST call; defaults to the app's real authedRequest. */
  request?: StaffRequest
}

const defaultRequest: StaffRequest = (path, init) => authedRequest(path, init)

function normalizeRow(r: Partial<StaffRow> & { id: string }): StaffRow {
  return {
    id: r.id,
    display_name: r.display_name ?? '',
    role: r.role ?? 'provider',
    is_admin: r.is_admin === true,
    activated_at: r.activated_at ?? null,
    revoked_at: r.revoked_at ?? null,
    created_at: r.created_at ?? null,
  }
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

const STAFF_SELECT = 'id,display_name,role,is_admin,activated_at,revoked_at,created_at'

/** The whole roster, oldest account first (active staff see every row). */
export async function listStaff(deps: StaffApiDeps = {}): Promise<StaffRow[]> {
  const request = deps.request ?? defaultRequest
  const res = await request(
    `/rest/v1/users_profiles?select=${STAFF_SELECT}&order=created_at.asc`,
  )
  if (!res.ok) throw new Error(await postgrestErrorMessage(res))
  const rows = (await res.json()) as Partial<StaffRow>[]
  return rows
    .filter((r): r is Partial<StaffRow> & { id: string } => typeof r.id === 'string')
    .map(normalizeRow)
}

// ---------------------------------------------------------------------------
// Row actions. All PATCH via the one seam, all errors verbatim.
// ---------------------------------------------------------------------------

async function patchStaff(
  id: string,
  patch: Record<string, unknown>,
  deps: StaffApiDeps,
): Promise<StaffRow> {
  const request = deps.request ?? defaultRequest
  const res = await request(`/rest/v1/users_profiles?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  })
  if (!res.ok) throw new Error(await postgrestErrorMessage(res))
  let rows: unknown
  try {
    rows = await res.json()
  } catch {
    throw new Error(NOT_APPLIED_ERROR)
  }
  const row = Array.isArray(rows) ? (rows[0] as Partial<StaffRow> | undefined) : undefined
  if (!row || typeof row.id !== 'string') throw new Error(NOT_APPLIED_ERROR)
  return normalizeRow(row as Partial<StaffRow> & { id: string })
}

/**
 * Approve a pending account. 'now' is the Postgres special timestamptz
 * input, evaluated by the SERVER when it parses the value - the approval
 * time never comes from a device clock, which field hardware has taught
 * this project not to trust. The returned representation carries the real
 * stamped value.
 */
export function approveStaff(id: string, deps: StaffApiDeps = {}): Promise<StaffRow> {
  return patchStaff(id, { activated_at: 'now' }, deps)
}

/** Revoke: the kill switch. Server-stamped, same 'now' rule as approve. */
export function revokeStaff(id: string, deps: StaffApiDeps = {}): Promise<StaffRow> {
  return patchStaff(id, { revoked_at: 'now' }, deps)
}

/** Restore a revoked account (admin only; the trigger enforces it). */
export function restoreStaff(id: string, deps: StaffApiDeps = {}): Promise<StaffRow> {
  return patchStaff(id, { revoked_at: null }, deps)
}

/** Change an account's station role (reception | triage | provider | lab | pharmacy). */
export function setStationRole(
  id: string,
  role: string,
  deps: StaffApiDeps = {},
): Promise<StaffRow> {
  return patchStaff(id, { role }, deps)
}

/** Grant or remove the admin flag. The server guards the last admin. */
export function setAdmin(
  id: string,
  isAdmin: boolean,
  deps: StaffApiDeps = {},
): Promise<StaffRow> {
  return patchStaff(id, { is_admin: isAdmin }, deps)
}

// ---------------------------------------------------------------------------
// Pure helpers (the screen's gating and chips; deterministic, no I/O)
// ---------------------------------------------------------------------------

/** Revoked wins over everything; then pending; else active. */
export function staffStatus(row: Pick<StaffRow, 'activated_at' | 'revoked_at'>): StaffStatus {
  if (row.revoked_at) return 'revoked'
  if (!row.activated_at) return 'pending'
  return 'active'
}

/**
 * How many accounts await approval. The tab-badge datum: the shell's tab
 * definitions are plain labels today, so nothing consumes this from there
 * yet; the staff screen itself surfaces the count.
 */
export function pendingCount(rows: readonly StaffRow[]): number {
  return rows.filter((r) => staffStatus(r) === 'pending').length
}

/** Admins who can actually act: flagged, activated, not revoked. */
export function activeAdminCount(rows: readonly StaffRow[]): number {
  return rows.filter((r) => r.is_admin && staffStatus(r) === 'active').length
}

/**
 * True when userId is the ONLY active admin - the case where the UI
 * disables self-demotion and self-revocation with LAST_ADMIN_REASON instead
 * of letting the server refuse. The server still guards (two admins
 * removing themselves at the same moment race past any client check).
 */
export function isLastActiveAdmin(rows: readonly StaffRow[], userId: string): boolean {
  const self = rows.find((r) => r.id === userId)
  if (!self || !self.is_admin || staffStatus(self) !== 'active') return false
  return activeAdminCount(rows) === 1
}

// ---------------------------------------------------------------------------
// The org-mode master switch
// ---------------------------------------------------------------------------

export interface OrgModeSwitchDeps {
  request?: StaffRequest
  /** Local config KV to mirror into on success; defaults to the kernel's. */
  configKv?: KV
}

/**
 * Flip the organization's mode by upserting the 'orgMode' config row
 * DIRECTLY through authedRequest - deliberately NOT through the sync
 * engine's CONFIG_PUSH_KEYS path. orgMode is the master switch, not list
 * config: it must hit the server immediately so the config rules trigger
 * (setup.sql section 8) vets the caller RIGHT NOW and refuses loudly, not
 * minutes later inside a background push that swallows failures.
 *
 * The local config KV is mirrored ONLY after the server accepts, so a
 * refused switch leaves this device believing the truth. Other devices
 * learn the new mode on their next config pull; a field device that is
 * offline keeps working until it reconnects and discovers the closed
 * surface - which is exactly why the UI quotes the drain rule before
 * flipping.
 */
export async function switchOrgMode(
  mode: OrgMode,
  deps: OrgModeSwitchDeps = {},
): Promise<void> {
  const request = deps.request ?? defaultRequest
  const kv = deps.configKv ?? kernelConfig
  const res = await request('/rest/v1/config', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([{ key: 'orgMode', value: { mode } }]),
  })
  if (!res.ok) throw new Error(await postgrestErrorMessage(res))
  await kv.set('orgMode', { mode })
}
