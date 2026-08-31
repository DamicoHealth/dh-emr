/**
 * THE INVARIANT WALL.
 *
 * These test the real kernel and encode the rules that keep the live patient
 * records safe. If one of these ever fails, STOP - a change has broken a
 * durability guarantee, not just a test.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetStorage } from './setup'
import { dbName, records, setCurrentUserId, settings, storagePrefix, storageSuffix } from '../src/kernel'
import { isUnsynced } from '../src/types/record'
import type { PatientRecord } from '../src/types/record'

type AnyRec = Record<string, unknown>

function makeRecord(over: AnyRec = {}): PatientRecord {
  return {
    id: (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`),
    site: 'Clinic A', date: '2026-07-01', mrn: 'TEPA01011990',
    givenName: 'Test', familyName: 'Patient', name: 'Test Patient',
    sex: 'F', dob: '1990-01-01', phone: '',
    temp: '37.0', bp: '120/80', weight: '60',
    allergies: '', currentMeds: '', pmh: '', chiefConcern: 'Fever',
    labs: {}, urinalysis: null, accessToCare: null,
    diagnosis: 'Malaria', diagnosisCodes: [], medications: [], procedures: [],
    imaging: null, surgery: null, referralType: 'None', referralDate: '',
    provider: 'Dr. A', notes: '', ageEstimated: false, bloodGlucose: '',
    templateId: null, templateName: '', customFields: {},
    treatmentNotes: '', treatment: '', transport: '', travelTime: '', labComments: '',
    ...over,
  } as unknown as PatientRecord
}

beforeEach(async () => {
  await resetStorage()
  records.invalidate()
})

describe('kernel wiring', () => {
  it('exposes the module surface the app depends on', () => {
    // The old kernel wired itself through window globals; the rebuild is ES
    // modules, so the wall asserts the module surface instead.
    expect(typeof records).toBe('object')
    expect(typeof records.withLock).toBe('function')
    expect(typeof records.getAll).toBe('function')
    expect(typeof records.persist).toBe('function')
    expect(typeof records.mutate).toBe('function')
    expect(typeof records.adoptMirror).toBe('function')
    expect(typeof records.mirrorRefusal).toBe('function')
    expect(typeof settings.get).toBe('function')
    expect(typeof settings.set).toBe('function')
  })
})

describe('record persistence', () => {
  it('round-trips a saved record', async () => {
    const rec = makeRecord({ givenName: 'Ada' })
    await records.save(rec)
    const all = await records.getActive()
    expect(all).toHaveLength(1)
    expect(all[0]!.givenName).toBe('Ada')
    expect(all[0]!.mrn).toBe('TEPA01011990')
  })

  it('preserves every field it was given (no silent field loss)', async () => {
    const rec = makeRecord({
      customFields: { painScore: '7', tags: ['a', 'b'] },
      labs: { 'Malaria RDT': { ordered: true, result: 'POS', type: 'toggle' } },
      medications: [{ id: 'm1', medId: 'Artemether', dose: '80mg', freq: 'BID', duration: '3 days', qty: null, qtyUnit: null }],
      urinalysis: { protein: 'Trace' },
      referralStatus: 'Pending',
      // An EXTRA field that is not in the record shape at all - the kernel
      // must not strip unknown fields (they may belong to a newer build).
      legacyExtra: 'still-here',
    })
    await records.save(rec)
    const [saved] = await records.getActive()
    expect(saved!.customFields).toEqual({ painScore: '7', tags: ['a', 'b'] })
    expect(saved!.labs['Malaria RDT']!.result).toBe('POS')
    expect(saved!.medications[0]!.medId).toBe('Artemether')
    expect(saved!.urinalysis!.protein).toBe('Trace')
    expect(saved!.referralStatus).toBe('Pending')
    expect((saved as unknown as AnyRec).legacyExtra).toBe('still-here')

    // The unknown field also survives an EDIT that does not carry it:
    // save spread-merges { ...old, ...incoming } on an existing id.
    const edit = makeRecord({ id: rec.id, diagnosis: 'Typhoid' })
    await records.save(edit)
    const [edited] = await records.getActive()
    expect((edited as unknown as AnyRec).legacyExtra).toBe('still-here')
    expect(edited!.diagnosis).toBe('Typhoid')
  })

  it('writes a localStorage mirror as a second copy', async () => {
    await records.save(makeRecord())
    const mirror = localStorage.getItem('dhemr_records')
    expect(mirror).toBeTruthy()
    expect(JSON.parse(mirror as string)).toHaveLength(1)
  })
})

describe('sync bookkeeping', () => {
  it('a new record starts unsynced (sync_version 1 > synced_version 0)', async () => {
    await records.save(makeRecord())
    const [r] = await records.getAll()
    expect(r!.sync_version).toBe(1)
    expect(r!.synced_version).toBe(0)
    expect((await records.getAll()).filter(isUnsynced)).toHaveLength(1)
  })

  it('bumps sync_version on every edit so the change is re-pushed', async () => {
    const rec = makeRecord()
    await records.save(rec)
    await records.save({ ...rec, diagnosis: 'Typhoid' })
    const [r] = await records.getAll()
    expect(r!.sync_version).toBe(2)
    expect(r!.diagnosis).toBe('Typhoid')
  })
})

describe('soft delete', () => {
  it('marks deleted and hides from the active list but keeps the tombstone', async () => {
    const rec = makeRecord()
    await records.save(rec)
    await records.softDelete(rec.id)

    expect(await records.getActive()).toHaveLength(0) // hidden from the UI
    const all = await records.getAll()
    expect(all).toHaveLength(1) // tombstone retained
    expect(all[0]!.deleted).toBe(true)
    expect(all[0]!.sync_version).toBe(2) // so the delete syncs
  })
})

describe('single-writer mutex (the save-during-sync data-loss guard)', () => {
  it('serializes concurrent saves so neither is lost', async () => {
    const a = makeRecord({ givenName: 'Ada', mrn: 'ADON01011990' })
    const b = makeRecord({ givenName: 'Bee', mrn: 'BEET01011990' })
    await Promise.all([records.save(a), records.save(b)])
    const all = await records.getActive()
    expect(all).toHaveLength(2)
    expect(all.map((r) => r.givenName).sort()).toEqual(['Ada', 'Bee'])
  })

  it('survives a burst of concurrent saves without dropping any', async () => {
    const recs = Array.from({ length: 25 }, (_, i) =>
      makeRecord({ givenName: `P${i}`, mrn: `PP${String(i).padStart(2, '0')}01011990` }))
    await Promise.all(recs.map((r) => records.save(r)))
    expect(await records.getActive()).toHaveLength(25)
  })

  it('mutate serializes an external read-modify-write against a save', async () => {
    await records.save(makeRecord({ givenName: 'Base' }))
    await Promise.all([
      // Simulates what the sync engine does: mutate the array under the lock.
      records.mutate((all) => {
        const r = makeRecord({ givenName: 'FromSync', mrn: 'FRSY01011990' })
        all.push(r)
        return { changed: [r], result: null }
      }),
      records.save(makeRecord({ givenName: 'FromUser', mrn: 'FRUS01011990' })),
    ])
    const names = (await records.getActive()).map((r) => r.givenName).sort()
    expect(names).toEqual(['Base', 'FromSync', 'FromUser'])
  })
})

describe('storage namespacing', () => {
  it('uses the un-suffixed keys in a normal build so existing records are found', () => {
    // A suffix here would point production at an empty database and look like
    // total data loss. Only demo/staging builds set DH_STORAGE_SUFFIX.
    expect(storageSuffix()).toBe('')
    expect(storagePrefix()).toBe('dhemr_')
    expect(dbName()).toBe('dh-emr-db')
  })
})

describe('clinic-mode author stamping', () => {
  beforeEach(async () => {
    await resetStorage()
    setCurrentUserId(null)
  })

  it('stamps user_id on a new record while a clinic account is active', async () => {
    // The clinic insert policy REQUIRES user_id = auth.uid(); an unstamped
    // record pushes as a rejection and surfaces as "NOT backed up".
    setCurrentUserId('11111111-2222-4333-8444-555555555555')
    await records.save(makeRecord({ givenName: 'Stamped', mrn: 'STMP01011990' }))
    const all = await records.getAll()
    expect(all[0]?.user_id).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('never rewrites an existing author', async () => {
    setCurrentUserId('11111111-2222-4333-8444-555555555555')
    const saved = (await records.save(
      makeRecord({ givenName: 'Original', mrn: 'ORIG01011990' }),
    ))[0] as PatientRecord
    setCurrentUserId('99999999-8888-4777-8666-555555555555')
    await records.save({ ...saved, diagnosis: 'Edited' })
    const all = await records.getAll()
    expect(all[0]?.user_id).toBe('11111111-2222-4333-8444-555555555555')
  })

  it('leaves user_id absent with no signed-in account (field mode)', async () => {
    await records.save(makeRecord({ givenName: 'Field', mrn: 'FLDM01011990' }))
    const all = await records.getAll()
    expect(all[0]?.user_id ?? null).toBeNull()
  })
})
