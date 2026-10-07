/**
 * The Clinic product's automatic org-mode write (src/clinicOrgMode.ts).
 *
 * Runs on injected fakes: no network, no real authedRequest. The rules:
 *  - an active ADMIN on an org whose mode is not clinic writes orgMode =
 *    clinic through the same direct config upsert the server trigger vets
 *    (switchOrgMode), and the local mirror updates after the server accepts;
 *  - an org already in clinic mode sends nothing;
 *  - a non-admin never tries (the server would refuse anyway);
 *  - a refusal or a dead network is swallowed and reported, never thrown,
 *    and the local mirror is left believing the truth.
 */
import { describe, expect, it } from 'vitest'
import type { KV } from '@dh/core/kernel/api'
import { ensureClinicOrgMode } from '../src/clinicOrgMode'

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

interface Call {
  path: string
  init: RequestInit | undefined
}

function fakeRequest(opts: { rows?: unknown; status?: number; throws?: Error } = {}) {
  const calls: Call[] = []
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    calls.push({ path, init })
    if (opts.throws) throw opts.throws
    return new Response(JSON.stringify(opts.rows ?? []), {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return { calls, request }
}

const bodyOf = (c: Call | undefined): unknown => JSON.parse(String(c?.init?.body))

const silent = (): void => {}

// ---------------------------------------------------------------------------

describe('ensureClinicOrgMode', () => {
  it('an active admin on a field-mode org writes orgMode=clinic through the vetted upsert', async () => {
    const kv = memKv()
    const { calls, request } = fakeRequest({
      rows: [{ key: 'orgMode', value: { mode: 'clinic' } }],
    })
    const r = await ensureClinicOrgMode({ isAdmin: true }, { configKv: kv, request, log: silent })
    expect(r).toEqual({ ok: true, switched: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.path).toBe('/rest/v1/config')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(bodyOf(calls[0])).toEqual([{ key: 'orgMode', value: { mode: 'clinic' } }])
    // Mirrored locally only after the server accepted.
    expect(kv.data.get('orgMode')).toEqual({ mode: 'clinic' })
  })

  it('an org already in clinic mode sends nothing', async () => {
    const kv = memKv({ orgMode: { mode: 'clinic' } })
    const { calls, request } = fakeRequest()
    const r = await ensureClinicOrgMode({ isAdmin: true }, { configKv: kv, request, log: silent })
    expect(r).toEqual({ ok: true, switched: false })
    expect(calls).toHaveLength(0)
  })

  it('a non-admin never tries', async () => {
    const kv = memKv()
    const { calls, request } = fakeRequest()
    const r = await ensureClinicOrgMode({ isAdmin: false }, { configKv: kv, request, log: silent })
    expect(r).toEqual({ ok: true, switched: false })
    expect(calls).toHaveLength(0)
    expect(kv.data.has('orgMode')).toBe(false)
  })

  it("a server refusal is reported with the trigger's sentence, never thrown, and the mirror is untouched", async () => {
    const kv = memKv()
    const logged: unknown[] = []
    const { request } = fakeRequest({
      rows: {
        message: 'Only an administrator account can switch this organization to clinic mode.',
      },
      status: 403,
    })
    const r = await ensureClinicOrgMode(
      { isAdmin: true },
      { configKv: kv, request, log: (_m, e) => logged.push(e) },
    )
    expect(r).toEqual({
      ok: false,
      error: 'Only an administrator account can switch this organization to clinic mode.',
    })
    expect(logged).toHaveLength(1)
    expect(kv.data.has('orgMode')).toBe(false)
  })

  it('a dead network is swallowed the same way so the shell can retry later', async () => {
    const kv = memKv()
    const { request } = fakeRequest({ throws: new TypeError('Failed to fetch') })
    const r = await ensureClinicOrgMode({ isAdmin: true }, { configKv: kv, request, log: silent })
    expect(r).toEqual({ ok: false, error: 'Failed to fetch' })
    expect(kv.data.has('orgMode')).toBe(false)
  })
})
