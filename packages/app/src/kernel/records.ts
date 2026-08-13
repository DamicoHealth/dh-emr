/**
 * The records store: cache, recovery machine, save/softDelete/update/mutate,
 * mirror + sidecar persistence, adoptMirror. Every rule here corresponds to
 * a shipped data-loss bug - see DESIGN.md before changing anything.
 */
import type { PatientRecord } from '../types/record'
import type { MirrorRefusal, MutationResult, RecordsStore } from './api'
import { idbClearRecords, idbGetAllRecords, idbPutRecords } from './idb'
import {
  onExternalWrite as locksOnExternalWrite,
  registerCacheInvalidator,
  withCrossTabLock,
  withTabLock,
} from './locks'
import { MIRROR_LIMIT, mirrorStaleKey, recordsKey, recordsMetaKey } from './namespace'

// Exact strings. Tests match /could not be read/i against the wipe guard;
// the double-failure message carries a U+2019 apostrophe in device's.
const WIPE_GUARD_MESSAGE =
  'Your existing records could not be read from this device right now, so saving was blocked to avoid overwriting them. Please close and reopen the app; if it keeps happening, restart the device before entering more data.'
const DOUBLE_FAILURE_MESSAGE =
  'Could not save to this device’s storage - both the database and the local backup failed to write. The device may be out of space or in a private-browsing window. Your entry was NOT saved.'
const NO_MIRROR_MESSAGE = 'There is no local backup copy on this device to recover from.'

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cache: PatientRecord[] | null = null
let cacheReady = false
/**
 * Did the last full read genuinely succeed? Used by the wipe guard to refuse
 * saving into a store that was merely unreadable (not truly empty).
 */
let lastLoadOk = false
/**
 * Set when a mirror recovery was refused because the mirror is behind.
 * Null at all other times. Reset at the top of EVERY uncached read.
 */
let refusal: MirrorRefusal | null = null
/** Concurrent uncached reads share one in-flight promise. */
let inflightRead: Promise<PatientRecord[]> | null = null
/** Registered device id, published by the app after setup. Never a shared default. */
let currentDeviceId: string | null = null

export function setCurrentDeviceId(id: string | null): void {
  currentDeviceId = id
}

export function getCurrentDeviceId(): string | null {
  return currentDeviceId
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lsGetJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function invalidate(): void {
  cacheReady = false
  cache = null
}

// External writes from other tabs drop this tab's cache.
registerCacheInvalidator(invalidate)

// ---------------------------------------------------------------------------
// Recovery machine - runs on any uncached read
// ---------------------------------------------------------------------------

async function readUncached(): Promise<PatientRecord[]> {
  let arr: PatientRecord[] = []
  let loadOk = false
  try {
    arr = await idbGetAllRecords()
    loadOk = true // a resolved read is authoritative, even when empty
  } catch (e) {
    console.warn('[platform] idb read failed', e)
    loadOk = false // could NOT read - must not be treated as "empty"
    arr = []
  }
  // Reset on EVERY uncached read, so the refusal clears automatically once
  // the real store comes back.
  refusal = null
  if (arr.length === 0) {
    // Safety net: IndexedDB came back empty but a localStorage mirror may
    // hold data (iOS evicts IDB and leaves localStorage). Only adopt a
    // mirror that is provably current: records_meta is written in the same
    // step as a successful mirror write, and records_mirror_stale is set
    // whenever a mirror write fails. Adopting a stale mirror is not a
    // recovery, it is the mechanism of permanent loss.
    const mirror = lsGetJson(recordsKey())
    if (Array.isArray(mirror) && mirror.length > 0) {
      const stale = (() => {
        try {
          return localStorage.getItem(mirrorStaleKey()) === '1'
        } catch {
          // An unreadable localStorage is exactly the device that must not
          // be trusted.
          return true
        }
      })()
      const meta = lsGetJson(recordsMetaKey()) as {
        count?: unknown
        at?: unknown
        newest?: unknown
      } | null
      const expected = meta && typeof meta.count === 'number' ? meta.count : null
      // A mirror from a build that predates the sidecar has no expected
      // count. Allow it: that device never had the quota failure mode.
      const short = expected !== null && mirror.length < expected
      if (stale || short) {
        console.error('[platform] REFUSED to recover from a stale localStorage mirror', {
          mirrorCount: mirror.length,
          expected,
          stale,
        })
        refusal = {
          mirrorCount: mirror.length,
          expectedCount: expected,
          stale,
          mirrorAt: meta && typeof meta.at === 'string' && meta.at ? meta.at : null,
          newest: meta && typeof meta.newest === 'string' && meta.newest ? meta.newest : null,
        }
        // Leave the store looking UNREADABLE, not empty. The IndexedDB read
        // itself resolved (eviction resolves empty rather than erroring), so
        // loadOk would otherwise be true and the wipe guard in save() would
        // not fire - the clinician would see zero records and be free to
        // save over the only remaining copy.
        loadOk = false
      } else {
        console.warn('[platform] recovered', mirror.length, 'records from localStorage mirror')
        arr = mirror as PatientRecord[]
        loadOk = true
        try {
          await idbPutRecords(arr) // repair IndexedDB, best-effort
        } catch {
          /* the adopted in-memory copy is still authoritative */
        }
      }
    }
  }
  cache = arr
  cacheReady = true
  lastLoadOk = loadOk
  return arr
}

function getAllCached(): Promise<PatientRecord[]> {
  if (cacheReady && cache !== null) return Promise.resolve(cache)
  if (!inflightRead) {
    inflightRead = readUncached().finally(() => {
      inflightRead = null
    })
  }
  return inflightRead
}

// ---------------------------------------------------------------------------
// Persistence - per-record puts + bounded mirror + sidecar
// ---------------------------------------------------------------------------

/**
 * Rewrite the localStorage mirror (newest MIRROR_LIMIT rows by savedAt,
 * string compare, tombstones included) and its sidecar. The sidecar count is
 * the FULL row count and newest is the max savedAt across ALL rows; both are
 * written only in the same step as a successful mirror write. Returns
 * whether the mirror write itself succeeded. Never throws.
 */
function writeMirrorAndSidecar(all: PatientRecord[]): boolean {
  let mirrorOk = false
  try {
    let bounded: PatientRecord[] = all
    if (all.length > MIRROR_LIMIT) {
      bounded = [...all]
        .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0))
        .slice(0, MIRROR_LIMIT)
    }
    localStorage.setItem(recordsKey(), JSON.stringify(bounded))
    mirrorOk = true
  } catch (e) {
    console.warn('[platform] localStorage mirror write failed (quota?)', e)
  }
  // Mirror freshness sidecar + staleness flag, so recovery never silently
  // adopts an out-of-date mirror. This block must never break a save.
  try {
    if (mirrorOk) {
      let newest = ''
      for (const r of all) {
        if (r && r.savedAt && r.savedAt > newest) newest = r.savedAt
      }
      localStorage.setItem(
        recordsMetaKey(),
        JSON.stringify({ count: all.length, newest, at: new Date().toISOString() }),
      )
      localStorage.removeItem(mirrorStaleKey())
    } else {
      localStorage.setItem(mirrorStaleKey(), '1')
    }
  } catch {
    /* sidecar is best-effort */
  }
  return mirrorOk
}

/**
 * The dual write. `full` is the complete in-memory working set (including
 * tombstones), `changed` the rows to put. The in-memory copy becomes
 * authoritative FIRST - so the wipe-guard condition clears even if the IDB
 * write then fails - and the loud throw fires only when BOTH layers fail.
 */
async function persistInternal(full: PatientRecord[], changed: PatientRecord[]): Promise<void> {
  cache = full
  cacheReady = true
  lastLoadOk = true // we now hold an authoritative in-memory copy
  let idbOk = false
  try {
    await idbPutRecords(changed)
    idbOk = true
  } catch (e) {
    console.warn('[platform] idb write failed', e)
  }
  const mirrorOk = writeMirrorAndSidecar(full)
  if (!idbOk && !mirrorOk) {
    throw new Error(DOUBLE_FAILURE_MESSAGE)
  }
}

/** Public persist: full set comes from the cache the caller just mutated. */
async function persist(changed: PatientRecord[]): Promise<void> {
  let full: PatientRecord[]
  if (cacheReady && cache !== null) {
    full = cache
  } else {
    // The cache was dropped between the caller's read and this persist (an
    // external invalidation). Re-read and overlay the changed rows so the
    // mirror and sidecar never shrink to just the changed set.
    full = await getAllCached()
    for (const row of changed) {
      const i = full.findIndex((r) => r.id === row.id)
      if (i >= 0) full[i] = row
      else full.push(row)
    }
  }
  await persistInternal(full, changed)
}

// ---------------------------------------------------------------------------
// Locked operations
// ---------------------------------------------------------------------------

function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  // Cross-tab lock OUTSIDE, per-tab promise mutex INSIDE.
  return withCrossTabLock(() => withTabLock(fn))
}

function save(record: PatientRecord): Promise<PatientRecord[]> {
  return withLock(async () => {
    const all = await getAllCached()
    // Wipe guard: if the existing records could NOT be read and the working
    // set is empty, refuse to write - that is exactly how an
    // unreadable-but-present dataset gets destroyed.
    if (!lastLoadOk && all.length === 0) {
      throw new Error(WIPE_GUARD_MESSAGE)
    }
    const idx = all.findIndex((r) => r.id === record.id)
    record.savedAt = new Date().toISOString()
    // Use the registered device id; never fall back to a shared default
    // (every fresh install would upload records with the same device_id).
    const resolvedDeviceId = record.deviceId || currentDeviceId || null
    if (!resolvedDeviceId) {
      record.deviceId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : 'pwa-' + Date.now()
      console.warn(
        '[pwa-shim] saveRecord called before device registered; assigned ephemeral id',
        record.deviceId,
      )
    } else {
      record.deviceId = resolvedDeviceId
    }
    let row: PatientRecord
    if (idx >= 0) {
      // Spread-merge preserves fields not present on the incoming record
      // (synced_version, unknown/extra fields) and bumps sync_version.
      const prev = all[idx] as PatientRecord
      row = { ...prev, ...record, sync_version: (prev.sync_version || 1) + 1 }
      all[idx] = row
    } else {
      record.sync_version = 1
      record.synced_version = 0
      row = record
      all.push(record)
    }
    await persistInternal(all, [row])
    return all.filter((r) => !r.deleted)
  })
}

function softDelete(id: string): Promise<PatientRecord[]> {
  return withLock(async () => {
    const all = await getAllCached()
    const idx = all.findIndex((r) => r.id === id)
    const changed: PatientRecord[] = []
    if (idx >= 0) {
      const row = all[idx] as PatientRecord
      row.deleted = true
      row.sync_version = (row.sync_version || 1) + 1
      // savedAt is deliberately NOT touched on delete.
      changed.push(row)
    }
    // Missing id is a silent no-op; the mirror is still rewritten.
    await persistInternal(all, changed)
    return all.filter((r) => !r.deleted)
  })
}

function update(id: string, patch: (r: PatientRecord) => PatientRecord): Promise<boolean> {
  return withLock(async () => {
    const all = await getAllCached()
    const idx = all.findIndex((r) => r.id === id)
    if (idx < 0) return false
    const prev = all[idx] as PatientRecord
    const next = patch({ ...prev })
    next.sync_version = (prev.sync_version ?? 1) + 1
    next.savedAt = new Date().toISOString()
    all[idx] = next
    await persistInternal(all, [next])
    return true
  })
}

function mutate<T>(
  fn: (all: PatientRecord[]) => MutationResult<T> | Promise<MutationResult<T>>,
): Promise<T> {
  return withLock(async () => {
    const all = await getAllCached()
    const { changed, result } = await fn(all)
    await persistInternal(all, changed)
    return result
  })
}

function adoptMirror(): Promise<number> {
  return withLock(async () => {
    // Re-read the mirror here: this is a deliberate, human-confirmed action
    // and must adopt what is actually on the device right now.
    const mirror = lsGetJson(recordsKey())
    if (!Array.isArray(mirror) || mirror.length === 0) {
      throw new Error(NO_MIRROR_MESSAGE)
    }
    console.warn(
      '[platform] adopting stale mirror by explicit confirmation:',
      mirror.length,
      'records',
    )
    const rows = mirror as PatientRecord[]
    // Goes through the normal persist path, so the records store, the
    // mirror, the sidecar and the staleness flag all end up consistent.
    await persistInternal(rows, rows)
    refusal = null
    return rows.length
  })
}

// ---------------------------------------------------------------------------
// Reads + surface
// ---------------------------------------------------------------------------

async function getAll(): Promise<PatientRecord[]> {
  return await getAllCached()
}

async function getActive(): Promise<PatientRecord[]> {
  return (await getAllCached()).filter((r) => !r.deleted)
}

function mirrorRefusal(): MirrorRefusal | null {
  return refusal ? { ...refusal } : null
}

export const records: RecordsStore = {
  getActive,
  getAll,
  save,
  softDelete,
  update,
  mutate,
  withLock,
  persist,
  invalidate,
  mirrorRefusal,
  adoptMirror,
  onExternalWrite: locksOnExternalWrite,
}

/**
 * TEST/MAINTENANCE ONLY: hard-empty the records store through the kernel's
 * own locked path. Never deleteDatabase - the kernel caches its connection.
 */
export function hardResetRecords(): Promise<void> {
  return withLock(async () => {
    await idbClearRecords()
    cache = []
    cacheReady = true
    lastLoadOk = true
    refusal = null
  })
}
