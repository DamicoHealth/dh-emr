/**
 * Who may push config (src/sync/engine.ts, the config-push policy seam).
 *
 * The cycle pushes changed config keys only when the gate allows it. By
 * default the gate is the DEVICE role (Field: admin or standard, chosen in
 * the wizard; the server accepts config from the shared key in field mode).
 * DH EMR Clinic installs a policy that follows the signed-in ACCOUNT: there
 * the server accepts config writes only from an admin account, and a device
 * that joined through a link is 'standard' by design, so without the policy
 * an admin's Settings edits on such a device would stay local forever.
 *
 * Real engine over a fake transport; no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KV, RecordsStore } from '../src/kernel/api'
import { storagePrefix } from '../src/kernel'
import { createSyncEngine } from '../src/sync/engine'
import type { Transport } from '../src/sync/transport'

const URL_ = 'https://proj.supabase.co'
const KEY = 'sb_publishable_k123'

function memKv(): KV {
  const data = new Map<string, unknown>()
  return {
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

async function makeEngine(deviceRole: 'admin' | 'standard') {
  const requests: { url: string; method: string }[] = []
  const transport: Transport = async (url, init) => {
    requests.push({ url, method: init?.method ?? 'GET' })
    return jsonRes([])
  }
  const settings = memKv()
  await settings.set('deviceRole', deviceRole)
  const store = { getAll: async () => [], invalidate: () => {} } as unknown as RecordsStore
  const engine = createSyncEngine({
    transport,
    store,
    settings,
    config: memKv(),
    getDeviceId: () => 'dev-1',
    sleep: async () => {},
  })
  engine.updateCredentials(URL_, KEY)
  return {
    engine,
    requests,
    configPushes: () =>
      requests.filter((r) => r.method === 'POST' && r.url === `${URL_}/rest/v1/config`).length,
    cycles: () => requests.filter((r) => r.url.includes('/rest/v1/config?')).length,
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  // A changed config key waiting to go out (what an admin's list edit leaves).
  localStorage.setItem(storagePrefix() + 'sites', JSON.stringify(['Kabale Community Clinic']))
})

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('config push gate', () => {
  it('by default the DEVICE role decides (Field): standard never pushes, admin pushes', async () => {
    const std = await makeEngine('standard')
    await std.engine.syncNow()
    expect(std.cycles()).toBe(1)
    expect(std.configPushes()).toBe(0)

    const adm = await makeEngine('admin')
    await adm.engine.syncNow()
    expect(adm.cycles()).toBe(1)
    expect(adm.configPushes()).toBe(1)
  })

  it('an installed policy replaces the device gate (Clinic: the signed-in account)', async () => {
    // An admin account on a link-joined (standard) device pushes.
    const std = await makeEngine('standard')
    std.engine.setConfigPushPolicy(() => true)
    await std.engine.syncNow()
    expect(std.configPushes()).toBe(1)

    // A non-admin account never pushes, whatever the device row says.
    const adm = await makeEngine('admin')
    adm.engine.setConfigPushPolicy(() => false)
    await adm.engine.syncNow()
    expect(adm.configPushes()).toBe(0)

    // null restores the device gate.
    adm.engine.setConfigPushPolicy(null)
    await adm.engine.syncNow()
    expect(adm.configPushes()).toBe(1)
  })

  it('the policy is asked on every cycle, so a sign-out or demotion holds the next push', async () => {
    let admin = false
    const e = await makeEngine('standard')
    e.engine.setConfigPushPolicy(async () => admin)
    await e.engine.syncNow()
    expect(e.configPushes()).toBe(0)
    admin = true
    await e.engine.syncNow()
    expect(e.configPushes()).toBe(1)
    expect(e.cycles()).toBe(2)
  })
})
