/**
 * Staff management + org-mode switch (src/ui/staff/staffApi.ts).
 *
 * Everything runs on injected fetch-shaped fakes - no network, no real
 * authedRequest. The rules under test are product rules:
 *  - admin actions are plain PATCHes through the one authed seam, with
 *    Prefer: return=representation and SERVER-stamped timestamps ('now' is
 *    the Postgres special input, never the device clock);
 *  - the server's trigger refusals surface VERBATIM, because those strings
 *    were written to be shown to people;
 *  - non-admin gating is honest on both halves: a zero-row PATCH (RLS
 *    silently filtering rows the caller may not touch) is an error, never a
 *    silent "it worked";
 *  - the org-mode switch is a DIRECT config upsert vetted by the server,
 *    and the local mirror updates only after the server accepted.
 */
import { describe, expect, it } from 'vitest'
import type { KV } from '../src/kernel/api'
import {
  LAST_ADMIN_REASON,
  NOT_APPLIED_ERROR,
  STATION_ROLES,
  activeAdminCount,
  approveStaff,
  isLastActiveAdmin,
  listStaff,
  pendingCount,
  restoreStaff,
  revokeStaff,
  setAdmin,
  setStationRole,
  staffStatus,
  switchOrgMode,
  type StaffRow,
} from '../src/ui/staff/staffApi'

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

interface Call {
  path: string
  init: RequestInit | undefined
}

function fakeRequest(opts: { rows?: unknown; status?: number } = {}) {
  const calls: Call[] = []
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, init })
    return jsonRes(opts.rows ?? [], opts.status ?? 200)
  }
  return { calls, request }
}

const headersOf = (c: Call | undefined): Record<string, string> =>
  (c?.init?.headers ?? {}) as Record<string, string>

const bodyOf = (c: Call | undefined): unknown => JSON.parse(String(c?.init?.body))

const staff = (over: Partial<StaffRow> = {}): StaffRow => ({
  id: 'u1',
  display_name: 'Grace N.',
  role: 'provider',
  is_admin: false,
  activated_at: null,
  revoked_at: null,
  created_at: '2026-08-01T00:00:00Z',
  ...over,
})

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

describe('listStaff', () => {
  it('reads exactly the profile columns the screen shows, oldest first', async () => {
    const { calls, request } = fakeRequest({ rows: [staff()] })
    await listStaff({ request })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe(
      '/rest/v1/users_profiles?select=id,display_name,role,is_admin,activated_at,revoked_at,created_at&order=created_at.asc',
    )
    expect(calls[0]?.init).toBeUndefined()
  })

  it('normalizes sparse rows instead of crashing the screen on them', async () => {
    const { request } = fakeRequest({
      rows: [{ id: 'u9' }, { display_name: 'no id, dropped' }],
    })
    const rows = await listStaff({ request })
    expect(rows).toEqual([
      {
        id: 'u9',
        display_name: '',
        role: 'provider',
        is_admin: false,
        activated_at: null,
        revoked_at: null,
        created_at: null,
      },
    ])
  })

  it('surfaces a server refusal verbatim', async () => {
    const { request } = fakeRequest({
      rows: { message: 'permission denied for table users_profiles' },
      status: 403,
    })
    await expect(listStaff({ request })).rejects.toThrow(
      'permission denied for table users_profiles',
    )
  })
})

// ---------------------------------------------------------------------------
// PATCH shapes. The server's rules trigger is the authority; the client's
// whole job is to send the right minimal patch and repeat what came back.
// ---------------------------------------------------------------------------

describe('staff PATCH shapes', () => {
  it('approve PATCHes activated_at with the SERVER-evaluated special input, never a device timestamp', async () => {
    const { calls, request } = fakeRequest({
      rows: [staff({ id: 'u2', activated_at: '2026-08-31T09:00:00Z' })],
    })
    const updated = await approveStaff('u2', { request })
    expect(calls[0]?.path).toBe('/rest/v1/users_profiles?id=eq.u2')
    expect(calls[0]?.init?.method).toBe('PATCH')
    expect(headersOf(calls[0])).toEqual({
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    })
    expect(bodyOf(calls[0])).toEqual({ activated_at: 'now' })
    // The representation carries what the server actually stamped.
    expect(updated.activated_at).toBe('2026-08-31T09:00:00Z')
  })

  it('revoke and restore PATCH revoked_at, nothing else', async () => {
    const a = fakeRequest({ rows: [staff({ id: 'u2', revoked_at: '2026-08-31T10:00:00Z' })] })
    await revokeStaff('u2', { request: a.request })
    expect(bodyOf(a.calls[0])).toEqual({ revoked_at: 'now' })

    const b = fakeRequest({ rows: [staff({ id: 'u2' })] })
    await restoreStaff('u2', { request: b.request })
    expect(bodyOf(b.calls[0])).toEqual({ revoked_at: null })
  })

  it('station role and admin flag are single-field PATCHes', async () => {
    const a = fakeRequest({ rows: [staff({ id: 'u2', role: 'nurse' })] })
    await setStationRole('u2', 'nurse', { request: a.request })
    expect(bodyOf(a.calls[0])).toEqual({ role: 'nurse' })

    const b = fakeRequest({ rows: [staff({ id: 'u2', is_admin: true })] })
    await setAdmin('u2', true, { request: b.request })
    expect(bodyOf(b.calls[0])).toEqual({ is_admin: true })

    const c = fakeRequest({ rows: [staff({ id: 'u2' })] })
    await setAdmin('u2', false, { request: c.request })
    expect(bodyOf(c.calls[0])).toEqual({ is_admin: false })
  })

  it('encodes the id into the filter', async () => {
    const { calls, request } = fakeRequest({ rows: [staff({ id: 'u 2&x' })] })
    await approveStaff('u 2&x', { request })
    expect(calls[0]?.path).toBe('/rest/v1/users_profiles?id=eq.u%202%26x')
  })
})

// ---------------------------------------------------------------------------
// Server refusals: the trigger's words, verbatim
// ---------------------------------------------------------------------------

describe('server error strings surface verbatim', () => {
  it("non-admin approve: the trigger's exact sentence", async () => {
    const { request } = fakeRequest({
      rows: { message: 'Only an administrator can approve an account.' },
      status: 403,
    })
    await expect(approveStaff('u2', { request })).rejects.toThrow(
      'Only an administrator can approve an account.',
    )
  })

  it("non-admin revoke: the trigger's exact sentence", async () => {
    const { request } = fakeRequest({
      rows: { message: 'Only an administrator can revoke or restore an account.' },
      status: 403,
    })
    await expect(revokeStaff('u2', { request })).rejects.toThrow(
      'Only an administrator can revoke or restore an account.',
    )
  })

  it('the last-admin guard arrives verbatim, and the UI reason is the SAME sentence', async () => {
    const { request } = fakeRequest({
      rows: { message: 'You are the only administrator. Make someone else an admin first.' },
      status: 403,
    })
    await expect(setAdmin('u1', false, { request })).rejects.toThrow(
      'You are the only administrator. Make someone else an admin first.',
    )
    expect(LAST_ADMIN_REASON).toBe(
      'You are the only administrator. Make someone else an admin first.',
    )
  })

  it('a zero-row PATCH is refused, never reported as success (non-admin RLS is a silent filter)', async () => {
    // A non-admin PATCHing someone else's row matches nothing: HTTP 200,
    // empty representation. Pretending that worked would hide every
    // permission problem the trigger never even saw.
    const { request } = fakeRequest({ rows: [] })
    await expect(approveStaff('u2', { request })).rejects.toThrow(NOT_APPLIED_ERROR)
  })
})

// ---------------------------------------------------------------------------
// Gating helpers (pure)
// ---------------------------------------------------------------------------

describe('gating helpers', () => {
  it('status: revoked beats active beats pending', () => {
    expect(staffStatus(staff())).toBe('pending')
    expect(staffStatus(staff({ activated_at: '2026-08-01T00:00:00Z' }))).toBe('active')
    expect(
      staffStatus(staff({ activated_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-02T00:00:00Z' })),
    ).toBe('revoked')
  })

  it('pendingCount counts only accounts awaiting approval', () => {
    const rows = [
      staff({ id: 'a' }),
      staff({ id: 'b', activated_at: '2026-08-01T00:00:00Z' }),
      staff({ id: 'c', revoked_at: '2026-08-02T00:00:00Z' }),
      staff({ id: 'd' }),
    ]
    expect(pendingCount(rows)).toBe(2)
  })

  it('only ACTIVE admins count: pending or revoked admin flags are inert', () => {
    const rows = [
      staff({ id: 'a', is_admin: true, activated_at: '2026-08-01T00:00:00Z' }),
      staff({ id: 'b', is_admin: true }), // pending: dh_is_admin says no
      staff({ id: 'c', is_admin: true, activated_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-02T00:00:00Z' }),
    ]
    expect(activeAdminCount(rows)).toBe(1)
  })

  it('isLastActiveAdmin: true only for the sole active admin themselves', () => {
    const sole = [
      staff({ id: 'me', is_admin: true, activated_at: '2026-08-01T00:00:00Z' }),
      staff({ id: 'other', activated_at: '2026-08-01T00:00:00Z' }),
    ]
    expect(isLastActiveAdmin(sole, 'me')).toBe(true)
    // A non-admin is never "the last admin".
    expect(isLastActiveAdmin(sole, 'other')).toBe(false)

    const two = [
      staff({ id: 'me', is_admin: true, activated_at: '2026-08-01T00:00:00Z' }),
      staff({ id: 'peer', is_admin: true, activated_at: '2026-08-01T00:00:00Z' }),
    ]
    expect(isLastActiveAdmin(two, 'me')).toBe(false)

    // The peer admin being revoked makes me sole again.
    const peerRevoked = [
      staff({ id: 'me', is_admin: true, activated_at: '2026-08-01T00:00:00Z' }),
      staff({ id: 'peer', is_admin: true, activated_at: '2026-08-01T00:00:00Z', revoked_at: '2026-08-20T00:00:00Z' }),
    ]
    expect(isLastActiveAdmin(peerRevoked, 'me')).toBe(true)
  })

  it('the station role list is the documented four', () => {
    expect([...STATION_ROLES]).toEqual(['reception', 'nurse', 'provider', 'pharmacy'])
  })
})

// ---------------------------------------------------------------------------
// The org-mode master switch
// ---------------------------------------------------------------------------

describe('switchOrgMode', () => {
  it('upserts the orgMode row directly so the server trigger vets it NOW', async () => {
    const kv = memKv()
    const { calls, request } = fakeRequest({
      rows: [{ key: 'orgMode', value: { mode: 'clinic' } }],
    })
    await switchOrgMode('clinic', { request, configKv: kv })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/rest/v1/config')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(headersOf(calls[0])).toEqual({
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    })
    expect(bodyOf(calls[0])).toEqual([{ key: 'orgMode', value: { mode: 'clinic' } }])
  })

  it('mirrors the mode into the local config KV on success', async () => {
    const kv = memKv()
    const { request } = fakeRequest({ rows: [{ key: 'orgMode', value: { mode: 'clinic' } }] })
    await switchOrgMode('clinic', { request, configKv: kv })
    expect(kv.data.get('orgMode')).toEqual({ mode: 'clinic' })
  })

  it('flipping back to field sends the field value', async () => {
    const kv = memKv({ orgMode: { mode: 'clinic' } })
    const { calls, request } = fakeRequest({
      rows: [{ key: 'orgMode', value: { mode: 'field' } }],
    })
    await switchOrgMode('field', { request, configKv: kv })
    expect(bodyOf(calls[0])).toEqual([{ key: 'orgMode', value: { mode: 'field' } }])
    expect(kv.data.get('orgMode')).toEqual({ mode: 'field' })
  })

  it("a refused switch surfaces the trigger's sentence verbatim and NEVER touches the local mirror", async () => {
    const kv = memKv()
    const { request } = fakeRequest({
      rows: {
        message: 'Only an administrator account can switch this organization to clinic mode.',
      },
      status: 403,
    })
    await expect(switchOrgMode('clinic', { request, configKv: kv })).rejects.toThrow(
      'Only an administrator account can switch this organization to clinic mode.',
    )
    // The device must keep believing the truth: no local clinic flag exists
    // for a switch the server refused.
    expect(kv.data.has('orgMode')).toBe(false)
  })
})
