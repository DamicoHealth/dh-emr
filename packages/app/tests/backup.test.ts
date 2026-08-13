/**
 * Backup / restore tests.
 *
 * Restore is the last line of defense when a device is lost or wiped, so its
 * merge rules matter as much as the sync engine's. The legacy restore replaced
 * a local record with the backup's copy unconditionally, which meant restoring
 * an older file could silently undo newer work and bring back deleted records.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetStorage } from './setup'
import type { PatientRecord } from '../src/types/record'
import { gatherBackup, restoreFromData, shouldReplace } from '../src/lib/backup'
import { RECORDS_STORE, dbName, records } from '../src/kernel'
import { getDeviceId, registerDevice } from '../src/sync/device'

const rec = (o: Partial<PatientRecord>): PatientRecord => ({
  id: 'r1', deviceId: 'dev', mrn: 'AMNA12041989', site: 'Clinic A', date: '2026-08-01',
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
  savedAt: '2026-08-01T09:00:00.000Z',
  ...o,
})

const backupOf = (records: PatientRecord[], config: Record<string, unknown> = {}) => ({
  app: 'DH Field EMR', backupVersion: 1, exportedAt: '2026-08-01T00:00:00.000Z',
  recordCount: records.length, records, config,
})

/**
 * The test's OWN IndexedDB handle (never the kernel's cached connection).
 * The old suite emptied the kernel's whole-array blob via idbStore; the new
 * kernel stores one row per record, so eviction clears the records store.
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

beforeEach(async () => {
  await resetStorage()
})

describe('backup file', () => {
  it('includes every record, including soft-deleted tombstones', async () => {
    await records.save(rec({ id: 'a' }))
    await records.save(rec({ id: 'b', deleted: true }))
    const file = await gatherBackup()
    expect(file.records).toHaveLength(2)
    expect(file.recordCount).toBe(2)
    expect(file.app).toBe('DH Field EMR')
  })

  it('NEVER contains credentials or device identity', async () => {
    localStorage.setItem('dhemr_setting_supabaseKey', '"secret-key"')
    localStorage.setItem('dhemr_setting_deviceId', '"dev-123"')
    localStorage.setItem('dhemr_adminPassword', '"hunter2"')
    localStorage.setItem('dhemr_sites', JSON.stringify(['Clinic A']))
    const file = await gatherBackup()
    const text = JSON.stringify(file)
    expect(text).not.toContain('secret-key')
    expect(text).not.toContain('dev-123')
    expect(text).not.toContain('hunter2')
    expect(file.config['dhemr_sites']).toEqual(['Clinic A']) // presets DO travel
  })
})

describe('restore merge policy', () => {
  it('adds records the device has never seen', async () => {
    const r = await restoreFromData(backupOf([rec({ id: 'new' })]))
    expect(r.added).toBe(1)
    expect((await records.getAll()).map((x) => x.id)).toContain('new')
  })

  it('replaces a local record when the backup copy is NEWER', async () => {
    await records.save(rec({ id: 'a', diagnosis: 'old' }))
    // The kernel stamps savedAt at save time, so derive "newer" from what was
    // actually stored rather than assuming the value we passed in.
    const stored = (await records.getAll()).find((x) => x.id === 'a')!
    const later = new Date(Date.parse(stored.savedAt) + 86_400_000).toISOString()
    const r = await restoreFromData(backupOf([rec({ id: 'a', diagnosis: 'newer', savedAt: later })]))
    expect(r.updated).toBe(1)
    const saved = (await records.getAll()).find((x) => x.id === 'a')!
    expect(saved.diagnosis).toBe('newer')
  })

  it('IMPROVEMENT: does NOT undo newer local work with an older backup', async () => {
    // The legacy restore overwrote unconditionally, so restoring last week's
    // file silently discarded this week's edits.
    await records.save(rec({ id: 'a', diagnosis: 'current', savedAt: '2026-08-10T09:00:00.000Z' }))
    const r = await restoreFromData(backupOf([rec({ id: 'a', diagnosis: 'stale', savedAt: '2026-08-01T09:00:00.000Z' })]))
    expect(r.skipped).toBe(1)
    expect(r.updated).toBe(0)
    const saved = (await records.getAll()).find((x) => x.id === 'a')!
    expect(saved.diagnosis).toBe('current')
  })

  it('IMPROVEMENT: does not resurrect a record deleted after the backup was taken', async () => {
    await records.save(rec({ id: 'a', savedAt: '2026-08-01T09:00:00.000Z' }))
    // delete happens later, so the tombstone is newer than the backup copy
    const all = await records.getAll()
    const target = all.find((x) => x.id === 'a')!
    await records.save({ ...target, deleted: true, savedAt: '2026-08-09T09:00:00.000Z' })

    await restoreFromData(backupOf([rec({ id: 'a', savedAt: '2026-08-01T09:00:00.000Z' })]))
    const after = (await records.getAll()).find((x) => x.id === 'a')!
    expect(after.deleted).toBe(true) // stays deleted
  })

  it('never loses a record that exists only on the device', async () => {
    await records.save(rec({ id: 'local-only' }))
    await restoreFromData(backupOf([rec({ id: 'from-file' })]))
    const ids = (await records.getAll()).map((x) => x.id)
    expect(ids).toContain('local-only')
    expect(ids).toContain('from-file')
  })

  it('rejects a file that is not a backup', async () => {
    await expect(restoreFromData({ nope: true })).rejects.toThrow(/not a DH Field EMR backup/i)
    await expect(restoreFromData(null)).rejects.toThrow()
  })

  it('LEAVES SETTINGS ALONE by default', async () => {
    // Config used to be overwritten unconditionally, with none of the
    // newer-wins comparison the records path uses. An old backup restored on
    // an admin device silently reverted the org's form for everyone at the
    // next config push, so settings are now an explicit, separate choice.
    localStorage.setItem('dhemr_sites', JSON.stringify(['Current Clinic']))
    const r = await restoreFromData(backupOf([], { dhemr_sites: ['Restored Clinic'] }))
    expect(JSON.parse(localStorage.getItem('dhemr_sites') || '[]')).toEqual(['Current Clinic'])
    expect(r.configRestored).toBe(false)
  })

  it('restores presets but not credentials when settings are asked for', async () => {
    const r = await restoreFromData(backupOf([], {
      dhemr_sites: ['Restored Clinic'],
      dhemr_setting_supabaseKey: 'should-not-land',
    }), { includeConfig: true })
    expect(JSON.parse(localStorage.getItem('dhemr_sites') || '[]')).toEqual(['Restored Clinic'])
    expect(localStorage.getItem('dhemr_setting_supabaseKey')).toBeNull()
    expect(r.configRestored).toBe(true)
  })

  it('marks every restored record for re-upload', async () => {
    // A record carried in from a backup can arrive looking already-uploaded
    // (synced_version === sync_version) when this device's cloud has never
    // seen it. It must be pushed, not assumed safe.
    await restoreFromData(backupOf([
      rec({ id: 'from-file', savedAt: '2026-03-01T00:00:00.000Z', sync_version: 4, synced_version: 4 }),
    ]))
    const all = await records.getAll()
    const back = all.find((r) => r.id === 'from-file')!
    expect(back.sync_version).toBeGreaterThan(back.synced_version ?? 0)
  })
})

describe('shouldReplace', () => {
  it('prefers the newer savedAt and keeps local on a tie', () => {
    const a = rec({ savedAt: '2026-08-01T00:00:00.000Z' })
    const b = rec({ savedAt: '2026-08-02T00:00:00.000Z' })
    expect(shouldReplace(a, b)).toBe(true)
    expect(shouldReplace(b, a)).toBe(false)
    expect(shouldReplace(a, a)).toBe(false)
    expect(shouldReplace(undefined, a)).toBe(true)
  })
})

describe('a restore must never resurrect a deletion', () => {
  it('keeps a real tombstone even when the backup copy looks newer', async () => {
    // Uses the REAL softDelete, not a save that fakes deleted:true. The
    // kernel's delete bumps sync_version but leaves savedAt at its pre-delete
    // value, so a backup taken while the visit was still live can carry a
    // LATER savedAt than the tombstone. Comparing savedAt alone let the
    // restore un-delete it, and the sync_version bump then pushed that
    // resurrection to every device in the clinic.
    await records.save(rec({ id: 'gone', diagnosis: 'entered in error', savedAt: '2026-08-01T09:00:00.000Z' }))
    await records.softDelete('gone')

    const before = (await records.getAll()).find((r) => r.id === 'gone')!
    expect(before.deleted).toBe(true)

    // Far future, so it is genuinely newer than the savedAt the kernel stamps
    // on save. With a past date this test passes even without the guard.
    await restoreFromData(backupOf([
      rec({ id: 'gone', diagnosis: 'entered in error', savedAt: '2099-01-01T00:00:00.000Z' }),
    ]))

    const after = (await records.getAll()).find((r) => r.id === 'gone')!
    expect(after.deleted).toBe(true)
  })

  it('still restores a tombstone from the backup onto a device that never saw the delete', async () => {
    await records.save(rec({ id: 'del-elsewhere', savedAt: '2026-08-01T09:00:00.000Z' }))
    await restoreFromData(backupOf([
      { ...rec({ id: 'del-elsewhere', savedAt: '2099-01-01T00:00:00.000Z' }), deleted: true },
    ]))
    const after = (await records.getAll()).find((r) => r.id === 'del-elsewhere')!
    expect(after.deleted).toBe(true)
  })
})

describe('restored records must be uploadable by this device', () => {
  it('re-stamps deviceId so the cloud will accept them', async () => {
    // The org project only accepts a record whose device_id exists in its
    // devices table, and the push sends the record's OWN deviceId. A backup
    // from a standalone or de-registered device therefore carried an id the
    // project has never seen, so every upsert 403s forever and the records
    // sit pending permanently.
    await registerDevice('This iPad')
    const mine = await getDeviceId()
    expect(mine).toBeTruthy()

    await restoreFromData(backupOf([
      rec({ id: 'from-other-device', deviceId: 'a-device-this-project-never-saw' }),
    ]))

    const back = (await records.getAll()).find((r) => r.id === 'from-other-device')!
    expect(back.deviceId).toBe(mine)
  })
})

describe('the backup file is the ONLY recovery from an evicted store', () => {
  it('round-trips a whole device: gather, wipe, restore, compare', async () => {
    // Nothing tested this end to end, even though this file is the only way
    // back from a WebKit eviction - and now that the kernel REFUSES a stale
    // mirror, it is the only way back from that blocked state too.
    await records.save(rec({ id: 'a', diagnosis: 'Malaria', savedAt: '2026-08-01T09:00:00.000Z' }))
    await records.save(rec({ id: 'b', diagnosis: 'Anaemia', mrn: 'JOOK03112001' }))
    await records.save(rec({ id: 'c', diagnosis: 'entered in error' }))
    await records.softDelete('c') // a real tombstone must survive
    localStorage.setItem('dhemr_sites', JSON.stringify(['Kabale Community Clinic']))
    localStorage.setItem('dhemr_providers', JSON.stringify(['Grace N., clinical officer']))

    const file = await gatherBackup()
    const before = await records.getAll()
    expect(file.records).toHaveLength(before.length)

    // Total loss: IndexedDB evicted AND the mirror gone.
    await evictIndexedDb()
    localStorage.removeItem('dhemr_records')
    localStorage.removeItem('dhemr_records_meta')
    localStorage.removeItem('dhemr_sites')
    localStorage.removeItem('dhemr_providers')
    records.invalidate()
    expect(await records.getAll()).toHaveLength(0)

    const result = await restoreFromData(file, { includeConfig: true })
    expect(result.added).toBe(before.length)

    const after = await records.getAll()
    expect(after).toHaveLength(before.length)

    // Record for record, field for field, tombstones included.
    const norm = (rs: PatientRecord[]) => [...rs].sort((x, y) => x.id.localeCompare(y.id))
      // deviceId is deliberately re-stamped on restore, and sync_version is
      // deliberately bumped so everything re-uploads. Everything else must match.
      .map(({ deviceId, sync_version, ...rest }) => rest)
    expect(norm(after)).toEqual(norm(before))

    const tomb = after.find((r) => r.id === 'c')!
    expect(tomb.deleted).toBe(true)
    expect(JSON.parse(localStorage.getItem('dhemr_sites')!)).toEqual(['Kabale Community Clinic'])
    expect(JSON.parse(localStorage.getItem('dhemr_providers')!)).toEqual(['Grace N., clinical officer'])
  })

  it('never carries the cloud key into a backup file', async () => {
    localStorage.setItem('dhemr_setting_supabaseKey', 'secret-anon-key')
    localStorage.setItem('dhemr_setting_supabaseUrl', 'https://x.supabase.co')
    const file = await gatherBackup()
    const dumped = JSON.stringify(file)
    expect(dumped).not.toContain('secret-anon-key')
  })

  it('recovers a device that the stale-mirror guard has blocked', async () => {
    await records.save(rec({ id: 'real-1' }))
    await records.save(rec({ id: 'real-2' }))
    const file = await gatherBackup()

    // Reproduce the blocked state: store evicted, mirror behind and flagged.
    await evictIndexedDb()
    localStorage.setItem('dhemr_records', JSON.stringify([rec({ id: 'stale-only' })]))
    localStorage.setItem('dhemr_records_meta', JSON.stringify({ count: 900, newest: '', at: '2026-06-01T00:00:00.000Z' }))
    localStorage.setItem('dhemr_records_mirror_stale', '1')
    records.invalidate()
    await records.getAll()
    expect(records.mirrorRefusal()).not.toBeNull()

    // Restoring the backup is the correct way out, and it must work while blocked.
    const r = await restoreFromData(file)
    expect(r.added + r.updated).toBe(2)
    const ids = (await records.getAll()).map((x) => x.id).sort()
    expect(ids).toContain('real-1')
    expect(ids).toContain('real-2')
  })
})
