/**
 * THE STALE-MIRROR GUARD.
 *
 * The kernel keeps a second copy of the newest records in a localStorage
 * blob. When a mirror write fails, the kernel sets `records_mirror_stale`
 * and carries on reporting a successful save because IndexedDB still worked.
 *
 * The dangerous part was the READ path. When IndexedDB comes back empty -
 * which is exactly what iOS eviction looks like, a resolved read returning
 * nothing - the old kernel adopted whatever the mirror held, wrote it back
 * into IndexedDB as authoritative, and set loadOk so the wipe guard could
 * not fire. A device that lost IndexedDB at 6,000 records would silently
 * come back as a months-old 2,700-record clinic and let staff keep working.
 *
 * These tests drive the real kernel through that exact sequence. Planted
 * mirrors are byte-identical to the old suite - the localStorage contract
 * is unchanged - while eviction now clears the per-record object store.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetStorage } from './setup'
import { MIRROR_LIMIT, RECORDS_STORE, dbName, records } from '../src/kernel'
import type { PatientRecord } from '../src/types/record'

const P = 'dhemr_'

const rec = (id: string, savedAt = '2026-08-01T09:00:00.000Z'): PatientRecord => ({
  id, deviceId: 'dev', mrn: 'AMNA12041989', site: 'Clinic A', date: '2026-08-01',
  provider: '', givenName: 'Amara', familyName: 'Nakato', name: 'Amara Nakato',
  sex: 'F', dob: '1989-04-12', phone: '', ageEstimated: false,
  temp: '', bp: '', weight: '', pregnant: '', breastfeeding: '',
  allergies: '', currentMeds: '', pmh: '', chiefConcern: '',
  accessToCare: null, transport: '', travelTime: '',
  labs: {}, labComments: '', urinalysis: null, bloodGlucose: '',
  diagnosis: '', diagnosisCodes: [], medications: [], treatmentNotes: '', treatment: '',
  procedures: [], imaging: null, surgery: null,
  referralType: 'None', referralDate: '', notes: '',
  templateId: null, templateName: '', customFields: {},
  savedAt, sync_version: 1, synced_version: 1,
})

const many = (n: number) => Array.from({ length: n }, (_, i) => rec(`r-${i}`))

/**
 * The test's OWN IndexedDB handle (never the kernel's cached connection).
 * Opened without a version so it attaches to whatever the kernel created;
 * resetStorage() in beforeEach guarantees the kernel opened v2 first.
 */
let testDbPromise: Promise<IDBDatabase> | null = null
function openTestDb(): Promise<IDBDatabase> {
  if (!testDbPromise) {
    testDbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName())
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('test open failed'))
    })
  }
  return testDbPromise
}

async function idbRecordRows(): Promise<PatientRecord[]> {
  const db = await openTestDb()
  return await new Promise((resolve, reject) => {
    const req = db.transaction(RECORDS_STORE, 'readonly').objectStore(RECORDS_STORE).getAll()
    req.onsuccess = () => resolve(req.result as PatientRecord[])
    req.onerror = () => reject(req.error ?? new Error('test read failed'))
  })
}

async function idbPutRows(rows: PatientRecord[]): Promise<void> {
  const db = await openTestDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('test write failed'))
    const store = tx.objectStore(RECORDS_STORE)
    for (const row of rows) store.put(row)
  })
}

/** iOS evicted IndexedDB: the read RESOLVES, and resolves to nothing. */
async function evictIndexedDb(): Promise<void> {
  const db = await openTestDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(RECORDS_STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('test clear failed'))
    tx.objectStore(RECORDS_STORE).clear()
  })
  records.invalidate()
}

/** Put a mirror on the device with a sidecar describing a LARGER real store. */
function plantStaleMirror(mirror: PatientRecord[], expectedCount: number, stale: boolean): void {
  localStorage.setItem(P + 'records', JSON.stringify(mirror))
  localStorage.setItem(P + 'records_meta', JSON.stringify({
    count: expectedCount, newest: '2026-08-09T09:00:00.000Z', at: '2026-06-01T09:00:00.000Z',
  }))
  if (stale) localStorage.setItem(P + 'records_mirror_stale', '1')
  else localStorage.removeItem(P + 'records_mirror_stale')
}

beforeEach(async () => { await resetStorage() })

describe('recovering from the localStorage mirror', () => {
  it('still recovers when the mirror is genuinely current', async () => {
    // The safety net this whole mechanism exists for must keep working.
    const all = many(5)
    await records.mutate((working) => {
      for (const r of all) working.push(r)
      return { changed: all, result: null }
    })
    await evictIndexedDb()

    const back = await records.getAll()
    expect(back.length).toBe(5)
    expect(records.mirrorRefusal()).toBeNull()
    // ...and it repaired IndexedDB on the way through.
    expect(await idbRecordRows()).toHaveLength(5)
  })

  it('REFUSES a mirror the kernel flagged as stale', async () => {
    await evictIndexedDb()
    plantStaleMirror(many(2670), 6000, true)
    records.invalidate()

    const back = await records.getAll()
    expect(back).toHaveLength(0) // never silently adopted

    const refusal = records.mirrorRefusal()!
    expect(refusal).not.toBeNull()
    expect(refusal.mirrorCount).toBe(2670)
    expect(refusal.expectedCount).toBe(6000)
    expect(refusal.stale).toBe(true)
  })

  it('REFUSES a mirror that is short of the sidecar count even without the flag', async () => {
    await evictIndexedDb()
    plantStaleMirror(many(2670), 6000, false)
    records.invalidate()

    await records.getAll()
    expect(records.mirrorRefusal()?.mirrorCount).toBe(2670)
  })

  it('BLOCKS saving after a refusal, so the mirror cannot be overwritten', async () => {
    // This is the whole point. Refusing to adopt is worthless if the app then
    // presents an empty list and lets the clinician save over the last copy.
    await evictIndexedDb()
    plantStaleMirror(many(2670), 6000, true)
    records.invalidate()
    await records.getAll()

    await expect(records.save(rec('new-after-eviction')))
      .rejects.toThrow(/could not be read/i)

    // The mirror is still intact and still 2,670 records.
    expect(JSON.parse(localStorage.getItem(P + 'records')!)).toHaveLength(2670)
  })

  it('adopts the stale mirror only when a human explicitly says so', async () => {
    await evictIndexedDb()
    plantStaleMirror(many(2670), 6000, true)
    records.invalidate()
    await records.getAll()
    expect(records.mirrorRefusal()).not.toBeNull()

    const adopted = await records.adoptMirror()
    expect(adopted).toBe(2670)
    expect(records.mirrorRefusal()).toBeNull()

    // Saving works again, and the store is consistent across both copies.
    // The mirror is BOUNDED now: it holds the newest MIRROR_LIMIT rows while
    // the sidecar carries the full count (the old kernel mirrored all 2,671).
    await records.save(rec('after-adoption'))
    const all = await records.getAll()
    expect(all.length).toBe(2671)
    expect(JSON.parse(localStorage.getItem(P + 'records')!))
      .toHaveLength(Math.min(2671, MIRROR_LIMIT))
    expect(JSON.parse(localStorage.getItem(P + 'records_meta')!).count).toBe(2671)
    expect(localStorage.getItem(P + 'records_mirror_stale')).toBeNull()
  }, 60_000)

  it('adopts a legacy mirror that predates the sidecar', async () => {
    // A device last written by an older build has no records_meta. It never
    // had the quota failure mode, so refusing would strand it for no reason.
    await evictIndexedDb()
    localStorage.setItem(P + 'records', JSON.stringify(many(40)))
    localStorage.removeItem(P + 'records_meta')
    localStorage.removeItem(P + 'records_mirror_stale')
    records.invalidate()

    expect(await records.getAll()).toHaveLength(40)
    expect(records.mirrorRefusal()).toBeNull()
  })

  it('clears the refusal once the real store comes back', async () => {
    await evictIndexedDb()
    plantStaleMirror(many(2670), 6000, true)
    records.invalidate()
    await records.getAll()
    expect(records.mirrorRefusal()).not.toBeNull()

    // IndexedDB returns (a restore, or iOS handing the data back).
    await idbPutRows(many(6000))
    records.invalidate()

    expect(await records.getAll()).toHaveLength(6000)
    expect(records.mirrorRefusal()).toBeNull()
  }, 60_000)

  it('refuses when localStorage itself cannot be read', async () => {
    // An unreadable localStorage is exactly the device that must not be trusted.
    await evictIndexedDb()
    localStorage.setItem(P + 'records', JSON.stringify(many(10)))
    const real = localStorage.getItem.bind(localStorage)
    localStorage.getItem = (k: string) => {
      if (k === P + 'records_mirror_stale') throw new Error('storage unavailable')
      return real(k)
    }
    try {
      records.invalidate()
      await records.getAll()
      expect(records.mirrorRefusal()?.stale).toBe(true)
    } finally {
      localStorage.getItem = real
    }
  })
})
