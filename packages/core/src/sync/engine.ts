/**
 * The sync engine: the hardened Supabase replication cycle, ported
 * behavior-for-behavior from the previous implementation (pwa-sync.js +
 * syncLayer.ts). Every rule here corresponds to a shipped data-loss or
 * false-reporting bug; see the sync contract before changing anything.
 *
 * Cycle order (exact): pullConfig -> pushConfig (admin, non-fatal) ->
 * pushRecords -> pullRecords -> pullDeviceRole.
 *
 * Failure severity is deliberately asymmetric:
 *  - pullConfig failure: silent return (non-fatal).
 *  - pushConfig failure: caught in the cycle, console.warn only.
 *  - pushRecords per-record failures: logged, cycle continues.
 *  - pullRecords HTTP failure: THROWS -> status 'error'.
 *  - pullDeviceRole: swallows everything.
 *
 * Realtime is a TRIGGER, not a second replication path: onRemoteChange()
 * only schedules a full cycle. Payloads are never applied directly, so every
 * byte still arrives through this proven path; the worst a bad notification
 * can do is cause an extra sync. The periodic auto-sync (startAutoSync) is
 * the floor under that trigger: the same full cycle on a cadence, so a
 * device whose channel is down still converges.
 *
 * Transport is injectable (fetch-shaped) so tests run the whole protocol
 * without a network.
 */
import type { KV, RecordsStore } from '../kernel/api'
import {
  config as kernelConfig,
  getCurrentDeviceId,
  records as kernelRecords,
  setCurrentDeviceId,
  settings as kernelSettings,
  storagePrefix,
} from '../kernel'
import type { PatientRecord } from '../types/record'
import { CONFIG_PUSH_KEYS } from '../config/keys'
import {
  DEFAULT_COMPLAINTS,
  DEFAULT_FORMULARY,
  DEFAULT_PHYSICIANS,
  DEFAULT_PROCEDURES,
  DEFAULT_REFERRAL_TYPES,
  DEFAULT_SITES,
  DX_PRESETS,
  RX_PRESETS,
} from '../config/defaults'
import { supabaseHeaders } from './keys'
import { mergeRecords, recordToSupabaseRow, supabaseRowToRecord, type SupabaseRow } from './mapping'
import { getDeviceId as readStoredDeviceId, registerDeviceWithRole, type DeviceRole } from './device'
import { defaultTransport, type Transport } from './transport'

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The engine itself only ever emits 'disabled' | 'idle' | 'syncing' |
 * 'synced' | 'error'. 'offline' is derived by effectiveStatus(); 'pending'
 * exists in the union (and SYNC_LABELS) but nothing emits it.
 */
export type SyncStatus =
  | 'disabled'
  | 'idle'
  | 'offline'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'error'

export interface SyncLabel {
  label: string
  hint: string
  tone: 'ok' | 'warn' | 'bad' | 'idle'
}

export const SYNC_LABELS: Record<SyncStatus, SyncLabel> = {
  disabled: {
    label: 'Offline only',
    hint: 'Cloud sync is turned off. Records stay on this device.',
    tone: 'idle',
  },
  idle: {
    label: 'Connected',
    hint: 'Cloud connected. Not synced yet this session.',
    tone: 'idle',
  },
  offline: {
    label: 'Offline',
    hint: 'Saved on this device. Will sync when you reconnect.',
    tone: 'warn',
  },
  syncing: {
    label: 'Syncing',
    hint: 'Sending and receiving records...',
    tone: 'warn',
  },
  pending: {
    label: 'Pending',
    hint: 'Changes are waiting to sync.',
    tone: 'warn',
  },
  synced: {
    label: 'Synced',
    hint: 'All records are backed up to your cloud.',
    tone: 'ok',
  },
  error: {
    label: 'Sync error',
    hint: 'Tap to retry, or check your connection and credentials.',
    tone: 'bad',
  },
}

/** A raw status plus the browser's own connectivity signal. */
export function effectiveStatus(raw: SyncStatus): SyncStatus {
  if (raw !== 'disabled' && typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'offline'
  }
  return raw
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export type SyncOutcome =
  | { ok: true; pushed: number }
  | { ok: false; stillPending: number; reason: string }

/**
 * Who may push config from this device. The default (no policy installed)
 * is the DEVICE role: Field devices are admin or standard, and the server
 * accepts config from the shared key in field mode. DH EMR Clinic installs
 * a policy that follows the signed-in ACCOUNT instead: there the server
 * accepts config writes only from an admin account (dh_is_admin), so the
 * device role decides nothing and an admin on a link-joined (standard)
 * device must still get their Settings edits out to the organization.
 */
export type ConfigPushPolicy = () => boolean | Promise<boolean>

export interface SyncEngineDeps {
  transport?: Transport
  store?: RecordsStore
  settings?: KV
  config?: KV
  /** current device id, published at registration/boot. Defaults to the kernel's. */
  getDeviceId?: () => string | null
  /** injectable so retry backoff is instant in tests */
  sleep?: (ms: number) => Promise<void>
  /** onRemoteChange debounce, default 2000 ms */
  debounceMs?: number
}

export interface AutoSyncOptions {
  /** Cadence between cycles. Clinic uses CLINIC_AUTO_SYNC_INTERVAL_MS. */
  intervalMs: number
  /**
   * Run a cycle right away on start (default true): a device that just
   * signed in wants the board current now, not one interval from now.
   */
  immediate?: boolean
}

export interface SyncEngine {
  init(): Promise<void>
  syncNow(): Promise<void>
  syncNowChecked(): Promise<SyncOutcome>
  getStatus(): SyncStatus
  onStatus(cb: (s: SyncStatus) => void): () => void
  updateCredentials(url: string | null, key: string | null): void
  getCredentials(): { url: string | null; key: string | null }
  hasCloud(): boolean
  getUnsyncedCount(): Promise<number>
  getUnsyncedRecords(): Promise<PatientRecord[]>
  verifyTables(url?: string, key?: string): Promise<{ ok: boolean; error?: string }>
  seedConfig(url: string, key: string): Promise<{ ok: boolean; error?: string }>
  /** Realtime/trigger entry: schedules a full cycle. Never applies payloads. */
  onRemoteChange(): void
  onRecordsUpdated(cb: () => void): () => void
  onConfigUpdated(cb: () => void): () => void
  /** Connect to a (possibly NEW) project: verify, store creds, re-register there. */
  connectToProject(
    url: string,
    key: string,
    deviceName: string,
    role: DeviceRole,
  ): Promise<{ ok: boolean; error?: string }>
  /**
   * Periodic full cycles while the browser is online (see autoTick). Calling
   * it again replaces the running cadence; stopAutoSync ends it. Idempotent
   * and safe without a cloud (ticks are no-ops until credentials exist).
   */
  startAutoSync(opts: AutoSyncOptions): void
  stopAutoSync(): void
  /** True between startAutoSync and stopAutoSync. */
  autoSyncActive(): boolean
  /**
   * Replace the config-push gate (see ConfigPushPolicy). null restores the
   * default device-role gate. Consulted once per cycle, before pushConfig.
   */
  setConfigPushPolicy(policy: ConfigPushPolicy | null): void
}

/**
 * The Clinic product's auto-sync cadence. 20 s keeps a board current even
 * when the realtime trigger is down (realtime not enabled on the project,
 * a proxy that drops WebSockets, an iPad that killed the socket in the
 * background) and is well inside the free tier for a 20-device clinic:
 * an idle cycle is four small GETs. Field may adopt a slower cadence later.
 */
export const CLINIC_AUTO_SYNC_INTERVAL_MS = 20_000

/** Batch size for record pushes. */
const PUSH_BATCH_SIZE = 50
/** Keyset page size for record pulls. */
const PULL_PAGE_SIZE = 1000
const EPOCH = '1970-01-01T00:00:00.000Z'
/**
 * Cross-tab sync serialization. Deliberately a DIFFERENT lock name from the
 * kernel's records lock: the kernel takes 'dh-emr-records' inside every
 * mutation, and Web Locks are not reentrant.
 */
const SYNC_LOCK_NAME = 'dh-emr-sync'

export function createSyncEngine(deps: SyncEngineDeps = {}): SyncEngine {
  const transport = deps.transport ?? defaultTransport
  const store = deps.store ?? kernelRecords
  const settings = deps.settings ?? kernelSettings
  const config = deps.config ?? kernelConfig
  const getDeviceId = deps.getDeviceId ?? getCurrentDeviceId
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const debounceMs = deps.debounceMs ?? 2000

  let syncStatus: SyncStatus = 'disabled'
  let supabaseUrl: string | null = null
  let supabaseKey: string | null = null
  const statusCallbacks = new Set<(s: SyncStatus) => void>()
  const recordsUpdatedCallbacks = new Set<() => void>()
  const configUpdatedCallbacks = new Set<() => void>()
  let remoteTimer: ReturnType<typeof setTimeout> | null = null
  let configPushPolicy: ConfigPushPolicy | null = null

  function setStatus(status: SyncStatus): void {
    syncStatus = status
    statusCallbacks.forEach((cb) => {
      try {
        cb(status)
      } catch {
        /* a listener must not break the engine */
      }
    })
  }

  function fireRecordsUpdated(): void {
    recordsUpdatedCallbacks.forEach((cb) => {
      try {
        cb()
      } catch {
        /* ignore */
      }
    })
  }

  function fireConfigUpdated(): void {
    configUpdatedCallbacks.forEach((cb) => {
      try {
        cb()
      } catch {
        /* ignore */
      }
    })
  }

  // ---------------------------------------------------------------- network

  function supabaseFetch(url: string, options: RequestInit = {}): Promise<Response> {
    return transport(url, {
      ...options,
      headers: supabaseHeaders(supabaseKey, options.headers as Record<string, string> | undefined),
    })
  }

  /**
   * Retry on network errors, 5xx and 429. Other 4xx responses are returned
   * without retry (the caller inspects them). Backoff 2^attempt seconds.
   */
  async function fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3,
  ): Promise<Response> {
    let lastError: unknown = new Error('sync request failed')
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const res = await supabaseFetch(url, options)
        if (res.ok) return res
        if (res.status >= 400 && res.status < 500 && res.status !== 429) return res
        lastError = new Error(`HTTP ${res.status}`)
      } catch (err) {
        lastError = err
      }
      await sleep(Math.pow(2, attempt) * 1000)
    }
    throw lastError
  }

  // ------------------------------------------------------------ record state

  async function getUnsyncedRecords(): Promise<PatientRecord[]> {
    const all = await store.getAll()
    return all.filter((r) => (r.sync_version || 1) > (r.synced_version || 0))
  }

  async function getUnsyncedCount(): Promise<number> {
    return (await getUnsyncedRecords()).length
  }

  // ------------------------------------------------------------- config sync

  async function pullConfig(): Promise<void> {
    const lastConfigPull =
      (await settings.get<string>('lastConfigPullTimestamp')) || EPOCH
    const query = `updated_at=gt.${encodeURIComponent(lastConfigPull)}&order=updated_at.asc`

    const res = await supabaseFetch(`${supabaseUrl}/rest/v1/config?${query}`)
    if (!res.ok) return // Config pull failure is non-fatal

    const rows = (await res.json()) as { key?: string; value?: unknown; updated_at?: string }[]
    if (rows.length === 0) return

    let latestTimestamp = lastConfigPull

    for (const row of rows) {
      const key = row.key
      if (!key) continue
      // Never store a synced admin password. It is device-local only; legacy
      // databases may still hold a plaintext 'adminPassword' row, so skip it
      // (but still advance the cursor past it).
      if (key === 'adminPassword') {
        if (row.updated_at && row.updated_at > latestTimestamp) latestTimestamp = row.updated_at
        continue
      }
      let value = row.value
      // Older builds of the seed step pre-JSON.stringify'd values, so the
      // JSONB column held a JSON string. Detect that case and unwrap once so
      // we never end up with double-encoded config.
      if (typeof value === 'string') {
        const trimmed = value.trim()
        if (
          trimmed.length &&
          (trimmed[0] === '{' || trimmed[0] === '[' || trimmed[0] === '"')
        ) {
          try {
            const parsed: unknown = JSON.parse(value)
            if (
              parsed &&
              (Array.isArray(parsed) || typeof parsed === 'object' || typeof parsed === 'string')
            ) {
              value = parsed
            }
          } catch {
            /* keep the raw string */
          }
        }
      }
      try {
        // Dual write (localStorage JSON + keyval), same key convention as v1.
        await config.set(key, value)
      } catch {
        /* best-effort */
      }

      if (row.updated_at && row.updated_at > latestTimestamp) {
        latestTimestamp = row.updated_at
      }
    }

    await settings.set('lastConfigPullTimestamp', latestTimestamp)
    fireConfigUpdated()
  }

  /**
   * Admin only. Pushes ONLY keys whose RAW localStorage value changed since
   * this device's last push (cfgPushed_<key>): previously every key was
   * re-stamped every cycle, so a second admin's edits were repeatedly
   * overwritten by this device's unchanged copies. The pull cursor is
   * deliberately NOT bumped on push - that skipped other admins' changes
   * written in between.
   */
  async function pushConfig(): Promise<void> {
    if (!supabaseUrl || !supabaseKey) return
    const lsPrefix = storagePrefix()
    const items: { key: string; value: unknown; updated_at: string; _raw: string }[] = []
    for (const k of CONFIG_PUSH_KEYS) {
      try {
        const raw = localStorage.getItem(lsPrefix + k)
        if (raw === null) continue
        const lastPushed = await settings.get<string>('cfgPushed_' + k)
        if (lastPushed === raw) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue
        }
        if (parsed === null || parsed === undefined) continue
        items.push({ key: k, value: parsed, updated_at: new Date().toISOString(), _raw: raw })
      } catch {
        /* skip an unreadable key */
      }
    }
    if (items.length === 0) return
    const res = await fetchWithRetry(`${supabaseUrl}/rest/v1/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(items.map(({ _raw, ...it }) => it)),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Push config failed: ${res.status} ${errText}`)
    }
    for (const it of items) {
      await settings.set('cfgPushed_' + it.key, it._raw)
    }
    console.log(`[pwa-sync] Pushed ${items.length} changed config keys`)
  }

  // ------------------------------------------------------------ record push

  async function pushRecords(): Promise<void> {
    const unsynced = await getUnsyncedRecords()
    if (unsynced.length === 0) return

    // Ids that reached the server, WITH the sync_version we pushed. We do NOT
    // hold the whole array across the network - writing that stale snapshot
    // back afterward was deleting encounters saved during the sync window.
    const pushed: { id: string; version: number }[] = []
    const deviceId = getDeviceId()

    for (let i = 0; i < unsynced.length; i += PUSH_BATCH_SIZE) {
      const batch = unsynced.slice(i, i + PUSH_BATCH_SIZE)
      const rows = batch.map((r) => recordToSupabaseRow(r, deviceId))

      try {
        const res = await fetchWithRetry(`${supabaseUrl}/rest/v1/records`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
          body: JSON.stringify(rows),
        })

        if (res.ok) {
          for (const record of batch) {
            pushed.push({ id: record.id, version: record.sync_version || 1 })
          }
        } else {
          throw new Error('Batch push failed')
        }
      } catch {
        // Fall back to one-by-one, so a single poison row cannot hold the
        // rest of the batch hostage.
        for (const record of batch) {
          try {
            const row = recordToSupabaseRow(record, deviceId)
            const res = await fetchWithRetry(`${supabaseUrl}/rest/v1/records`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Prefer: 'resolution=merge-duplicates',
              },
              body: JSON.stringify(row),
            })
            if (res.ok) pushed.push({ id: record.id, version: record.sync_version || 1 })
          } catch (err) {
            console.error(
              `[pwa-sync] Push failed for record ${record.id}:`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }
    }

    // Mark the pushed records synced on a FRESH copy, under the single-writer
    // lock - and ONLY if the record has not been edited again since we pushed
    // it (its sync_version still matches), so a mid-flight edit stays pending.
    if (pushed.length) {
      await store.mutate((all) => {
        const changed: PatientRecord[] = []
        for (const p of pushed) {
          const idx = all.findIndex((r) => r.id === p.id)
          if (idx >= 0) {
            const row = all[idx] as PatientRecord
            if ((row.sync_version || 1) === p.version) {
              row.synced_version = p.version
              changed.push(row)
            }
          }
        }
        return { changed, result: undefined }
      })
    }
    console.log(`[pwa-sync] Push: ${pushed.length}/${unsynced.length} records pushed`)

    // Update the fleet row's last_sync_at, best-effort.
    if (deviceId) {
      await supabaseFetch(`${supabaseUrl}/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_sync_at: new Date().toISOString() }),
      }).catch(() => {})
    }
  }

  // ------------------------------------------------------------ record pull

  async function pullRecords(): Promise<void> {
    const deviceId = getDeviceId()
    if (!deviceId) return

    const lastPull = (await settings.get<string>('lastPullTimestamp')) || EPOCH

    // Keyset pagination over (synced_at, id): loops until a short page
    // returns, so we NEVER silently truncate at Supabase's 1000-row cap, and
    // never skip rows that share a synced_at (a whole batch import shares one
    // timestamp). synced_at is stamped SERVER-side; field-device clocks are
    // unreliable. The first page uses gte so the boundary row is re-pulled
    // (harmless: mergeRecords is idempotent). The device_id echo filter was
    // REMOVED deliberately: cross-device updates that keep the original
    // creator's device_id (e.g. a referral marked Completed elsewhere) must
    // reach that device too; our own echoes are harmless.
    let cursorTs = lastPull
    let cursorId = ''
    const rows: SupabaseRow[] = []
    for (;;) {
      let filter: string
      if (cursorId) {
        filter = `or=(synced_at.gt.${encodeURIComponent(cursorTs)},and(synced_at.eq.${encodeURIComponent(cursorTs)},id.gt.${encodeURIComponent(cursorId)}))`
      } else {
        filter = `synced_at=gte.${encodeURIComponent(cursorTs)}`
      }
      const query = `${filter}&order=synced_at.asc,id.asc&limit=${PULL_PAGE_SIZE}`
      const res = await supabaseFetch(`${supabaseUrl}/rest/v1/records?${query}`)
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`Pull failed: ${res.status} ${errText}`)
      }
      const page = (await res.json()) as SupabaseRow[]
      if (page.length === 0) break
      rows.push(...page)
      const last = page[page.length - 1] as SupabaseRow
      cursorTs = (last.synced_at as string) || (last.saved_at as string) || cursorTs
      cursorId = last.id as string
      if (page.length < PULL_PAGE_SIZE) break
    }
    // lastPullTimestamp does NOT advance on an empty pull.
    if (rows.length === 0) return

    let latestTimestamp = lastPull
    const mrnFixes: { id: string; mrn: string }[] = []

    // Apply the whole pulled set to a FRESH copy under the single-writer lock.
    await store.mutate((all) => {
      const changed: PatientRecord[] = []
      for (const row of rows) {
        const record = supabaseRowToRecord(row)

        // MRN collision detection (different patient, same MRN).
        if (record.mrn) {
          const existing = all.find((r) => {
            const legacy = r as unknown as Record<string, unknown>
            return (
              r.mrn === record.mrn &&
              r.id !== record.id &&
              !r.deleted &&
              ((r.givenName || (legacy.given_name as string) || '') !== (record.givenName || '') ||
                (r.familyName || (legacy.family_name as string) || '') !==
                  (record.familyName || '') ||
                (r.dob || '') !== (record.dob || ''))
            )
          })
          if (existing) {
            let suffix = 1
            let newMrn = record.mrn + '-' + suffix
            while (all.some((r) => r.mrn === newMrn && r.id !== record.id)) {
              suffix++
              newMrn = record.mrn + '-' + suffix
            }
            console.log(`[pwa-sync] MRN collision: "${record.mrn}" reassigned to "${newMrn}"`)
            record.mrn = newMrn
            mrnFixes.push({ id: record.id, mrn: newMrn })
          }
        }

        const idx = all.findIndex((r) => r.id === record.id)
        if (idx >= 0) {
          const merged = mergeRecords(all[idx] as PatientRecord, record)
          all[idx] = merged
          changed.push(merged)
        } else {
          all.push(record)
          changed.push(record)
        }

        const ts = (row.synced_at as string) || (row.saved_at as string)
        if (ts && ts > latestTimestamp) latestTimestamp = ts
      }
      return { changed, result: undefined }
    })

    await settings.set('lastPullTimestamp', latestTimestamp)

    // Push MRN reassignments back to the cloud (outside the local write lock),
    // failures swallowed.
    for (const fix of mrnFixes) {
      try {
        await supabaseFetch(`${supabaseUrl}/rest/v1/records?id=eq.${encodeURIComponent(fix.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mrn: fix.mrn }),
        })
      } catch {
        /* retried implicitly on a later pull */
      }
    }

    console.log(`[pwa-sync] Pull: ${rows.length} rows processed`)
    fireRecordsUpdated()
  }

  // ------------------------------------------------------------- device role

  /** Cloud role ALWAYS overwrites local: portal promotions/demotions land here. */
  async function pullDeviceRole(): Promise<void> {
    const deviceId = getDeviceId()
    if (!deviceId) return
    try {
      const res = await supabaseFetch(
        `${supabaseUrl}/rest/v1/devices?id=eq.${encodeURIComponent(deviceId)}&select=role`,
      )
      if (!res.ok) return
      const rows = (await res.json()) as { role?: string }[]
      if (rows.length === 0) return

      const cloudRole = (rows[0] && rows[0].role) || 'standard'
      const localRole = (await settings.get<string>('deviceRole')) || 'standard'

      if (cloudRole !== localRole) {
        await settings.set('deviceRole', cloudRole)
        fireConfigUpdated()
      }
    } catch {
      /* role pull is never fatal */
    }
  }

  // --------------------------------------------------------------- the cycle

  async function runCycle(): Promise<void> {
    if (!supabaseUrl || !supabaseKey) return
    if (syncStatus === 'syncing') return // re-entry guard, silent

    setStatus('syncing')
    try {
      // Config push gate: the installed policy (Clinic: the signed-in
      // account's admin flag) or, by default, the device role.
      const pushAllowed = configPushPolicy
        ? await configPushPolicy()
        : (await settings.get<string>('deviceRole')) === 'admin'
      // Config: pull others' changes BEFORE pushing ours, so two admins
      // editing presets concurrently merge instead of overwriting each other.
      await pullConfig()
      if (pushAllowed) {
        try {
          await pushConfig()
        } catch (e) {
          console.warn('[pwa-sync] pushConfig failed:', e instanceof Error ? e.message : String(e))
        }
      }
      await pushRecords()
      await pullRecords()
      await pullDeviceRole()
      setStatus('synced')
    } catch (err) {
      console.error('[pwa-sync] Sync error:', err instanceof Error ? err.message : String(err))
      setStatus('error')
    }
  }

  /** Resolves when the status leaves 'syncing', or after capMs. */
  function waitNotSyncing(capMs: number): Promise<void> {
    if (syncStatus !== 'syncing') return Promise.resolve()
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let unsub: () => void = () => {}
      const done = (): void => {
        if (timer !== null) clearTimeout(timer)
        unsub()
        resolve()
      }
      unsub = onStatus((s) => {
        if (s !== 'syncing') done()
      })
      timer = setTimeout(done, capMs)
    })
  }

  /** Serialize whole cycles across tabs (own lock name; see SYNC_LOCK_NAME). */
  async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      return (await navigator.locks.request(SYNC_LOCK_NAME, fn)) as T
    }
    return await fn()
  }

  /**
   * When a run is already in flight, wait for it (60s cap) and then STILL run
   * our own: piggybacking on someone else's run only guarantees THAT run
   * finished, not that it covered a record saved after it started.
   */
  async function syncNow(): Promise<void> {
    if (syncStatus === 'syncing') await waitNotSyncing(60_000)
    await withSyncLock(() => runCycle())
    store.invalidate()
  }

  /**
   * Honest reporting. Ground truth is the POST-run unsynced count, because
   * the cycle swallows push failures and still ends on 'synced'. A pull
   * failure after a complete push is deliberately NOT a failure: the records
   * ARE backed up, and claiming otherwise trains clinicians to ignore the
   * alarm that matters.
   */
  async function syncNowChecked(): Promise<SyncOutcome> {
    const before = await getUnsyncedCount()
    const status0 = syncStatus
    try {
      await syncNow()
    } catch (e) {
      return {
        ok: false,
        stillPending: await getUnsyncedCount(),
        reason: e instanceof Error ? e.message : String(e),
      }
    }
    const after = await getUnsyncedCount()
    if (after === 0) return { ok: true, pushed: Math.max(0, before - after) }
    const reason =
      typeof navigator !== 'undefined' && navigator.onLine === false
        ? 'This device is offline.'
        : status0 === 'disabled'
          ? 'Cloud sync is not set up on this device.'
          : 'The cloud rejected the upload or could not be reached.'
    return { ok: false, stillPending: after, reason }
  }

  // -------------------------------------------------------- setup / plumbing

  async function init(): Promise<void> {
    const url = await settings.get<string>('supabaseUrl')
    const key = await settings.get<string>('supabaseKey')
    const standalone = await settings.get<string>('standaloneMode')
    // Publish the stored device identity so the first cycle can pull.
    try {
      const dev = await readStoredDeviceId(settings)
      if (dev) setCurrentDeviceId(dev)
    } catch {
      /* unregistered */
    }
    if (standalone === 'true') return // stays 'disabled'
    if (url && key) {
      supabaseUrl = url
      supabaseKey = key
      // 'idle' = connected but not yet synced this session. Do NOT claim
      // 'synced' here - that faked a "Last sync: just now" on every launch,
      // even offline.
      setStatus('idle')
    }
  }

  function updateCredentials(url: string | null, key: string | null): void {
    supabaseUrl = url
    supabaseKey = key
    void settings.set('supabaseUrl', url)
    void settings.set('supabaseKey', key)
    if (url && key) {
      setStatus('idle')
    } else {
      setStatus('disabled')
    }
  }

  function onStatus(cb: (s: SyncStatus) => void): () => void {
    statusCallbacks.add(cb)
    return () => {
      statusCallbacks.delete(cb)
    }
  }

  async function verifyTables(
    url?: string,
    key?: string,
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const tables = ['records', 'devices', 'config']
      for (const table of tables) {
        const res = await transport(`${url || supabaseUrl}/rest/v1/${table}?limit=0`, {
          headers: supabaseHeaders(key || supabaseKey),
        })
        if (res.status === 404) {
          return {
            ok: false,
            error: `Table "${table}" not found. Please run the SQL setup script first.`,
          }
        }
        if (!res.ok && res.status !== 200) {
          return { ok: false, error: `Error checking table "${table}": HTTP ${res.status}` }
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async function seedConfig(url: string, key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      // The value column is JSONB - pass the raw value, NOT a
      // JSON.stringify'd string. Pre-stringifying causes double-encoding on
      // pull.
      const defaults: Record<string, unknown> = {
        sites: DEFAULT_SITES,
        providers: DEFAULT_PHYSICIANS,
        formulary: DEFAULT_FORMULARY,
        rxPresets: RX_PRESETS,
        procedures: DEFAULT_PROCEDURES,
        referralTypes: DEFAULT_REFERRAL_TYPES,
        complaints: DEFAULT_COMPLAINTS,
        customDxPresets: DX_PRESETS,
      }
      const configItems = Object.entries(defaults).map(([k, v]) => ({
        key: k,
        value: v,
        updated_at: new Date().toISOString(),
      }))

      const res = await transport(`${url}/rest/v1/config`, {
        method: 'POST',
        headers: supabaseHeaders(key, {
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates',
        }),
        body: JSON.stringify(configItems),
      })

      if (!res.ok) {
        const errText = await res.text()
        return { ok: false, error: `Seed failed: ${errText}` }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  function onRemoteChange(): void {
    // TRIGGER only: debounce, coalesce bursts, then run the full proven
    // cycle. The payload itself is never applied.
    if (remoteTimer !== null) clearTimeout(remoteTimer)
    remoteTimer = setTimeout(() => {
      remoteTimer = null
      syncNow().catch(() => {})
    }, debounceMs)
  }

  // ---------------------------------------------------------------- auto-sync
  //
  // A periodic full cycle, the floor under the realtime trigger. Rules:
  //  - skipped entirely while the browser says offline (every tick would
  //    just burn the retry backoff), and run again the moment 'online' fires;
  //  - skipped while a cycle is already in flight, ours or a manual one
  //    (the chip, Settings): the tick does NOT queue behind it the way
  //    syncNow does, because a queued tick adds nothing a later tick will
  //    not cover, and a slow cycle must never pile up a backlog of cycles;
  //  - skipped without credentials, so a shell can start the cadence before
  //    the wizard finishes and nothing happens until it does.

  let autoTimer: ReturnType<typeof setInterval> | null = null
  let autoTickInFlight = false
  let autoOnlineListener: (() => void) | null = null

  async function autoTick(): Promise<void> {
    if (!supabaseUrl || !supabaseKey) return
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return
    if (autoTickInFlight || syncStatus === 'syncing') return
    autoTickInFlight = true
    try {
      await syncNow()
    } catch {
      /* the status (and the next tick) carry it; a tick never throws */
    } finally {
      autoTickInFlight = false
    }
  }

  function startAutoSync(opts: AutoSyncOptions): void {
    stopAutoSync()
    autoTimer = setInterval(() => {
      void autoTick()
    }, opts.intervalMs)
    if (typeof window !== 'undefined') {
      autoOnlineListener = () => {
        void autoTick()
      }
      window.addEventListener('online', autoOnlineListener)
    }
    if (opts.immediate !== false) void autoTick()
  }

  function stopAutoSync(): void {
    if (autoTimer !== null) {
      clearInterval(autoTimer)
      autoTimer = null
    }
    if (autoOnlineListener !== null && typeof window !== 'undefined') {
      window.removeEventListener('online', autoOnlineListener)
    }
    autoOnlineListener = null
  }

  async function connectToProject(
    url: string,
    key: string,
    deviceName: string,
    role: DeviceRole,
  ): Promise<{ ok: boolean; error?: string }> {
    const check = await verifyTables(url, key)
    if (!check.ok) return check
    updateCredentials(url, key)
    await settings.set('standaloneMode', 'false')
    // Re-register in the NEW project: its RLS only accepts records whose
    // device_id exists in ITS devices table. Skipping this means every upload
    // 403s silently and the device sits permanently "not backed up".
    await registerDeviceWithRole(deviceName, role, { kv: settings, transport, url, key })
    return { ok: true }
  }

  return {
    init,
    syncNow,
    syncNowChecked,
    getStatus: () => syncStatus,
    onStatus,
    updateCredentials,
    getCredentials: () => ({ url: supabaseUrl, key: supabaseKey }),
    hasCloud: () => !!(supabaseUrl && supabaseKey),
    getUnsyncedCount,
    getUnsyncedRecords,
    verifyTables,
    seedConfig,
    onRemoteChange,
    onRecordsUpdated: (cb) => {
      recordsUpdatedCallbacks.add(cb)
      return () => {
        recordsUpdatedCallbacks.delete(cb)
      }
    },
    onConfigUpdated: (cb) => {
      configUpdatedCallbacks.add(cb)
      return () => {
        configUpdatedCallbacks.delete(cb)
      }
    },
    connectToProject,
    startAutoSync,
    stopAutoSync,
    autoSyncActive: () => autoTimer !== null,
    setConfigPushPolicy: (policy) => {
      configPushPolicy = policy
    },
  }
}

/** The app-wide engine, bound to the real kernel and the real network. */
export const syncEngine: SyncEngine = createSyncEngine()
