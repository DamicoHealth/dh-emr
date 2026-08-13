/**
 * IndexedDB plumbing: open/upgrade/migrate, typed row ops on the per-record
 * 'records' store, and keyval ops for settings/config.
 *
 * Rules that are load-bearing here:
 *  - The connection promise is cached forever and never re-opened. Tests must
 *    NEVER indexedDB.deleteDatabase - a delete blocks on the open handle and
 *    leaves it pointing at a dead database.
 *  - Reads THROW when storage is unreadable. They never resolve null/[] on
 *    failure: "storage unreadable" must stay distinguishable from "genuinely
 *    empty", or an outage upstream turns into a dataset wipe (the wipe guard
 *    in records.ts depends on this).
 */
import type { PatientRecord } from '../types/record'
import { dbName, recordsKey } from './namespace'

export const DB_VERSION = 2
export const RECORDS_STORE = 'records'
export const KEYVAL_STORE = 'keyval'

let dbPromise: Promise<IDBDatabase> | null = null
let persistRequested = false

/** navigator.storage.persist(), once, best-effort. Never throws. */
function requestPersist(): void {
  if (persistRequested) return
  persistRequested = true
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (storage && typeof storage.persist === 'function') {
      const check: Promise<boolean> =
        typeof storage.persisted === 'function' ? storage.persisted() : Promise.resolve(false)
      void check
        .then((already) => (already ? true : storage.persist()))
        .then((granted) => {
          console.log('[idb-storage] persistent storage:', granted)
        })
        .catch(() => {
          /* best-effort */
        })
    }
  } catch {
    /* best-effort */
  }
}

/**
 * One-time v1 -> v2 migration, inside the versionchange transaction: if the
 * old whole-array blob exists under the keyval key and the records store is
 * empty, copy each element into the records store. The blob is left in place
 * as a read-only safety copy - never deleted.
 */
function migrateLegacyBlob(tx: IDBTransaction): void {
  try {
    const records = tx.objectStore(RECORDS_STORE)
    const keyval = tx.objectStore(KEYVAL_STORE)
    const countReq = records.count()
    countReq.onsuccess = () => {
      if (countReq.result > 0) return
      const blobReq = keyval.get(recordsKey())
      blobReq.onsuccess = () => {
        const blob: unknown = blobReq.result
        if (!Array.isArray(blob) || blob.length === 0) return
        let migrated = 0
        for (const row of blob) {
          if (row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string') {
            try {
              records.put(row)
              migrated++
            } catch {
              /* skip an unstorable row rather than abort the upgrade */
            }
          }
        }
        if (migrated > 0) {
          console.log('[idb-storage] Migrated', migrated, 'records from the legacy keyval blob')
        }
      }
      blobReq.onerror = (ev) => {
        ev.preventDefault() // do not abort the upgrade over a failed migration read
      }
    }
    countReq.onerror = (ev) => {
      ev.preventDefault()
    }
  } catch {
    /* migration must never block the upgrade */
  }
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  requestPersist()
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(dbName(), DB_VERSION)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage open failed'))
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(KEYVAL_STORE)) {
        db.createObjectStore(KEYVAL_STORE) // out-of-line keys, same as v1
      }
      if (!db.objectStoreNames.contains(RECORDS_STORE)) {
        db.createObjectStore(RECORDS_STORE, { keyPath: 'id' })
      }
      const tx = req.transaction
      if (tx) migrateLegacyBlob(tx)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      console.warn('[idb-storage] Failed to open IndexedDB:', req.error)
      reject(req.error ?? new Error('storage open failed'))
    }
  })
  return dbPromise
}

/** Every row in the records store, including tombstones. THROWS on failure. */
export async function idbGetAllRecords(): Promise<PatientRecord[]> {
  const db = await openDb()
  return await new Promise<PatientRecord[]>((resolve, reject) => {
    try {
      const tx = db.transaction(RECORDS_STORE, 'readonly')
      const req = tx.objectStore(RECORDS_STORE).getAll()
      req.onsuccess = () => resolve((req.result ?? []) as PatientRecord[])
      req.onerror = () => reject(req.error ?? new Error('storage read failed'))
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage read failed'))
    }
  })
}

/** Put the given rows (O(changed), one transaction). THROWS on failure. */
export async function idbPutRecords(rows: PatientRecord[]): Promise<void> {
  if (rows.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(RECORDS_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('storage write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('storage write failed'))
      const store = tx.objectStore(RECORDS_STORE)
      for (const row of rows) store.put(row)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage write failed'))
    }
  })
}

/** Empty the records store. Test/maintenance path only. THROWS on failure. */
export async function idbClearRecords(): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(RECORDS_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('storage clear failed'))
      tx.onabort = () => reject(tx.error ?? new Error('storage clear failed'))
      tx.objectStore(RECORDS_STORE).clear()
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage clear failed'))
    }
  })
}

/** keyval get. Resolves null when the key is absent; THROWS when unreadable. */
export async function kvGet(key: string): Promise<unknown> {
  const db = await openDb()
  return await new Promise<unknown>((resolve, reject) => {
    try {
      const tx = db.transaction(KEYVAL_STORE, 'readonly')
      const req = tx.objectStore(KEYVAL_STORE).get(key)
      req.onsuccess = () => resolve(req.result === undefined ? null : req.result)
      req.onerror = () => reject(req.error ?? new Error('storage read failed'))
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage read failed'))
    }
  })
}

/** keyval put. THROWS on failure (callers decide whether to fall back). */
export async function kvSet(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(KEYVAL_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('storage write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('storage write failed'))
      tx.objectStore(KEYVAL_STORE).put(value, key)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage write failed'))
    }
  })
}

/** keyval delete. THROWS on failure (callers swallow - removals are best-effort). */
export async function kvRemove(key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    try {
      const tx = db.transaction(KEYVAL_STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('storage delete failed'))
      tx.onabort = () => reject(tx.error ?? new Error('storage delete failed'))
      tx.objectStore(KEYVAL_STORE).delete(key)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('storage delete failed'))
    }
  })
}
