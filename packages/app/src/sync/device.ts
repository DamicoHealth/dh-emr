/**
 * Device identity: the crypto.randomUUID id, name, and role that every
 * record and every cloud write are filed under.
 *
 * Rules ported from the previous implementation, each one a shipped bug:
 *  - NEVER a shared default id. The legacy builds shipped 'pwa-device-001' /
 *    'demo-device-001'; every fresh install uploaded records as the same
 *    device. Those ids are treated as ABSENT wherever they are found.
 *  - Rename NEVER re-registers: registerDevice mints a fresh UUID, so
 *    renaming would give the device a new identity, strand its fleet row and
 *    make its own records read as another device's.
 *  - Connecting to a NEW project MUST re-register there: the project's RLS
 *    only accepts records whose device_id exists in ITS devices table, so
 *    skipping registration means every upload 403s silently and the device
 *    sits permanently "not backed up".
 *  - The cloud role is authoritative: the engine's pullDeviceRole adopts it
 *    unconditionally every cycle. Registration always POSTs role 'standard';
 *    the requested role is applied afterwards by the setDeviceRole PATCH,
 *    which the server trigger only lets stick as 'admin' when the project
 *    has no other active admin (first-run bootstrap).
 *  - A revoked device has NO special client code path: the server rejects
 *    its writes, the unsynced count stays > 0, and honest reporting surfaces
 *    "NOT backed up". That is the designed experience.
 */
import type { KV } from '../kernel/api'
import { setCurrentDeviceId, settings as kernelSettings } from '../kernel'
import { supabaseHeaders } from './keys'
import { defaultTransport, type Transport } from './transport'

export type DeviceRole = 'standard' | 'admin'

/** Legacy shared ids that must read as "this device has no identity yet". */
export const LEGACY_SHARED_DEVICE_IDS: readonly string[] = ['pwa-device-001', 'demo-device-001']

export interface DeviceContext {
  /** settings KV; defaults to the kernel's. */
  kv?: KV
  /** network seam; defaults to real fetch. */
  transport?: Transport
  /** explicit credentials; default to the stored supabaseUrl/supabaseKey. */
  url?: string | null
  key?: string | null
}

function ctxKv(ctx: DeviceContext): KV {
  return ctx.kv ?? kernelSettings
}

async function ctxCreds(ctx: DeviceContext): Promise<{ url: string | null; key: string | null }> {
  const kv = ctxKv(ctx)
  const url = ctx.url !== undefined ? ctx.url : await kv.get<string>('supabaseUrl')
  const key = ctx.key !== undefined ? ctx.key : await kv.get<string>('supabaseKey')
  return { url: url || null, key: key || null }
}

/** The registered device id, or null when unregistered. Legacy shared defaults read as absent. */
export async function getDeviceId(kv: KV = kernelSettings): Promise<string | null> {
  const id = await kv.get<string>('deviceId')
  if (!id || typeof id !== 'string') return null
  if (LEGACY_SHARED_DEVICE_IDS.includes(id)) return null
  return id
}

export async function getDeviceName(kv: KV = kernelSettings): Promise<string> {
  return (await kv.get<string>('deviceName')) || ''
}

export async function getDeviceRole(kv: KV = kernelSettings): Promise<DeviceRole> {
  const role = await kv.get<string>('deviceRole')
  return role === 'admin' ? 'admin' : 'standard'
}

/**
 * Mint and store a NEW device identity, register it in the cloud when
 * credentials are available, and publish it to the kernel so record saves and
 * the sync engine see it immediately. Cloud registration failure only warns;
 * the local id stands either way. The registration POST always carries role
 * 'standard' (see module header).
 */
export async function registerDevice(name: string, ctx: DeviceContext = {}): Promise<string> {
  const kv = ctxKv(ctx)
  const transport = ctx.transport ?? defaultTransport
  const deviceId = crypto.randomUUID()

  await kv.set('deviceId', deviceId)
  await kv.set('deviceName', name)
  setCurrentDeviceId(deviceId)

  const { url, key } = await ctxCreds(ctx)
  if (url && key) {
    try {
      await transport(`${url}/rest/v1/devices`, {
        method: 'POST',
        headers: supabaseHeaders(key, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        }),
        body: JSON.stringify({
          id: deviceId,
          name: name,
          role: 'standard',
          last_sync_at: new Date().toISOString(),
        }),
      })
    } catch (err) {
      console.warn(
        '[pwa-sync] Device registration in cloud failed:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  return deviceId
}

/**
 * Set the role locally and PATCH it to the fleet row. The cloud remains
 * authoritative: the server trigger may refuse the promotion, and the next
 * pullDeviceRole adopts whatever the cloud says.
 */
export async function setDeviceRole(role: DeviceRole, ctx: DeviceContext = {}): Promise<void> {
  const kv = ctxKv(ctx)
  await kv.set('deviceRole', role)
  const id = await getDeviceId(kv)
  const { url, key } = await ctxCreds(ctx)
  if (!id || !url || !key) return
  const transport = ctx.transport ?? defaultTransport
  try {
    await transport(`${url}/rest/v1/devices?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ role: role }),
    })
  } catch {
    /* best-effort; pullDeviceRole reconciles */
  }
}

/** The facade used by setup and connect flows: register, then request the role. */
export async function registerDeviceWithRole(
  name: string,
  role: DeviceRole,
  ctx: DeviceContext = {},
): Promise<string> {
  const id = await registerDevice(name, ctx)
  await setDeviceRole(role, ctx)
  return id
}

export interface RenameResult {
  ok: boolean
  message: string
}

/**
 * Rename WITHOUT re-registering. Deliberately not registerDevice(): that
 * always mints a fresh crypto.randomUUID, so renaming would give this device
 * a new identity. Only register a device that has no id yet.
 */
export async function renameDevice(rawName: string, ctx: DeviceContext = {}): Promise<RenameResult> {
  const name = (rawName || '').trim()
  if (!name) return { ok: false, message: 'A device name cannot be blank.' }
  const kv = ctxKv(ctx)
  const existing = await getDeviceId(kv)
  if (!existing) {
    const role = await getDeviceRole(kv)
    await registerDeviceWithRole(name, role === 'admin' ? 'admin' : 'standard', ctx)
  } else {
    await kv.set('deviceName', name)
  }
  return { ok: true, message: `This device is now called "${name}".` }
}
