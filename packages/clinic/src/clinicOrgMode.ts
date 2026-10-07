/**
 * The Clinic product's automatic org-mode write.
 *
 * A Clinic org IS clinic mode: the shell gates on accounts unconditionally
 * and nothing in either product offers a mode switch. The server still
 * carries the orgMode row as defense in depth (supabase/setup.sql: anon
 * policies close, per-user policies open, only when the row says clinic),
 * so SOMETHING must write it. That used to be a manual SQL-editor step
 * (SETUP.md section 4 step 6). Here it happens on the first ACTIVE ADMIN
 * sign-in, through the same switchOrgMode path the Staff screen used: a
 * direct authed config upsert the server's config rules trigger vets right
 * now, with the local mirror updated only after the server accepted.
 *
 * Silent on purpose. A refusal or a dead network is logged, never shown:
 * the admin did nothing wrong and can do nothing about it from here. The
 * shell retries on the next gate evaluation (sign-in, token refresh), and a
 * device whose local mirror has not pulled yet simply re-sends the same
 * idempotent upsert once.
 */
import { getOrgMode } from '@dh/core/auth'
import type { ActiveProfile } from '@dh/core/auth'
import { config as kernelConfig } from '@dh/core/kernel'
import type { KV } from '@dh/core/kernel/api'
import { switchOrgMode, type StaffRequest } from '@dh/core/ui/staff/staffApi'

export interface EnsureClinicOrgModeDeps {
  /** Local config KV (the orgMode mirror); defaults to the kernel's. */
  configKv?: KV
  /** The authed REST call; defaults to the app's real authedRequest. */
  request?: StaffRequest
  /** Where a silent failure is noted; defaults to console.warn. */
  log?: (message: string, error: unknown) => void
}

export type EnsureClinicOrgModeResult =
  | { ok: true; switched: boolean }
  | { ok: false; error: string }

const defaultLog = (message: string, error: unknown): void => {
  console.warn(message, error)
}

/**
 * Make sure the org's server-side mode is clinic. Only an active admin
 * account can (the server refuses everyone else, so nobody else tries).
 * Never throws: the result says what happened.
 */
export async function ensureClinicOrgMode(
  profile: Pick<ActiveProfile, 'isAdmin'>,
  deps: EnsureClinicOrgModeDeps = {},
): Promise<EnsureClinicOrgModeResult> {
  if (!profile.isAdmin) return { ok: true, switched: false }
  const kv = deps.configKv ?? kernelConfig
  if ((await getOrgMode(kv)) === 'clinic') return { ok: true, switched: false }
  try {
    await switchOrgMode('clinic', { request: deps.request, configKv: kv })
    return { ok: true, switched: true }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    ;(deps.log ?? defaultLog)('[clinic] could not set the organization to clinic mode', e)
    return { ok: false, error }
  }
}
