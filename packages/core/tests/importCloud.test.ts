/**
 * Importing records out of an old Supabase project into a fresh one.
 *
 * This is the escape hatch that makes a clean slate possible: leave a project
 * behind without abandoning the records in it. It matters that this is exact -
 * if a lab result or a medication list comes back subtly wrong, nobody finds
 * out until a clinician is looking at the wrong chart.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { resetStorage } from './setup'
import { detectShape, importCloudExport, rowsToRecords } from '../src/lib/importCloud'
import { gatherBackup } from '../src/lib/backup'
import { records as store, settings } from '../src/kernel'
import { getDeviceId, registerDevice } from '../src/sync/device'
import type { PatientRecord } from '../src/types/record'

/** A row exactly as Supabase hands it back: snake_case, JSONB already parsed. */
const cloudRow = (o: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  device_id: 'old-device',
  site: 'Kabale Community Clinic',
  date: '2026-08-01',
  mrn: 'AMNA12041989',
  given_name: 'Amara',
  family_name: 'Nakato',
  name: 'Amara Nakato',
  sex: 'F',
  dob: '1989-04-12',
  temp: '38.9',
  bp: '118/76',
  allergies: 'Penicillin',
  chief_concern: 'Fever 3 days',
  labs: { 'Malaria RDT': { kind: 'toggle', ordered: true, result: 'POS' } },
  urinalysis: {},
  diagnosis: 'Malaria',
  diagnosis_codes: [{ code: 'B54', label: 'Malaria, unspecified' }],
  medications: [{ id: 'm1', medId: 'f-para', dose: '500mg', freq: 'q8h', duration: '5d', qty: 15, qtyUnit: 'tabs' }],
  referral_type: 'None',
  saved_at: '2026-08-01T09:00:00.000Z',
  sync_version: 3,
  deleted: false,
  ...o,
})

beforeEach(async () => {
  await resetStorage()
})

describe('recognising what was handed over', () => {
  it('knows a Supabase export', () => {
    expect(detectShape([cloudRow()])).toBe('supabase-rows')
    expect(detectShape({ data: [cloudRow()] })).toBe('supabase-rows')
  })

  it('knows one of our own backups', async () => {
    await store.save({ id: 'a' } as PatientRecord)
    expect(detectShape(await gatherBackup())).toBe('app-backup')
  })

  it('refuses anything else rather than guessing', () => {
    expect(detectShape({ hello: 'world' })).toBe('unknown')
    expect(detectShape([{ nope: 1 }])).toBe('unknown')
    expect(detectShape(null)).toBe('unknown')
    expect(detectShape([])).toBe('unknown')
  })
})

describe('converting cloud rows', () => {
  it('carries the clinical content across intact', () => {
    const { records, rejected } = rowsToRecords([cloudRow()])
    expect(rejected).toEqual([])
    const r = records[0]!
    expect(r.name).toBe('Amara Nakato')
    expect(r.givenName).toBe('Amara')
    expect(r.mrn).toBe('AMNA12041989')
    expect(r.allergies).toBe('Penicillin')
    // The JSONB columns are the ones a hand-rolled converter gets wrong.
    expect(r.labs['Malaria RDT']).toMatchObject({ ordered: true, result: 'POS' })
    expect(r.medications[0]).toMatchObject({ medId: 'f-para', dose: '500mg', qty: 15 })
    expect(r.diagnosisCodes[0]).toMatchObject({ code: 'B54' })
  })

  it('rejects a row with no id instead of inventing one', () => {
    // An invented id cannot merge with the same encounter arriving from
    // anywhere else, so the patient quietly ends up with two of everything.
    const { records, rejected } = rowsToRecords([cloudRow(), { ...cloudRow(), id: undefined }])
    expect(records).toHaveLength(1)
    expect(rejected).toEqual([{ index: 1, reason: 'no id' }])
  })

  it('reports junk rows rather than dropping them silently', () => {
    const { records, rejected } = rowsToRecords([cloudRow(), null, 'nonsense'])
    expect(records).toHaveLength(1)
    expect(rejected.map((r) => r.index)).toEqual([1, 2])
  })
})

describe('importing into a fresh device', () => {
  it('lands the records and marks them for upload to the NEW project', async () => {
    // The real flow: the clinician sets the new device up, THEN imports.
    await registerDevice('New iPad')
    const res = await importCloudExport([cloudRow()])
    expect(res.shape).toBe('supabase-rows')
    expect(res.added).toBe(1)

    const all = await store.getAll()
    expect(all).toHaveLength(1)
    // The old project's device id must not come with it: the new project has
    // never heard of that device, and its RLS rejects writes from one it does
    // not know, so the record would sit pending forever.
    expect(all[0]!.deviceId).not.toBe('old-device')
    expect(all[0]!.sync_version).toBeGreaterThan(all[0]!.synced_version ?? 0)
  })

  it('brings tombstones across, so a deletion is not undone by the move', async () => {
    await registerDevice('New iPad')
    await importCloudExport([cloudRow({ id: '22222222-2222-4222-8222-222222222222', deleted: true })])
    const all = await store.getAll()
    expect(all[0]!.deleted).toBe(true)
  })

  it('round-trips a whole device through a cloud-shaped export', async () => {
    const rows = [
      cloudRow(),
      cloudRow({ id: '33333333-3333-4333-8333-333333333333', name: 'Joseph Okello', mrn: 'JOOK03112001', diagnosis: 'Anaemia' }),
    ]
    await registerDevice('New iPad')
    const res = await importCloudExport(rows)
    expect(res.added).toBe(2)
    const names = (await store.getAll()).map((r) => r.name).sort()
    expect(names).toEqual(['Amara Nakato', 'Joseph Okello'])
  })

  it('explains itself when the file is not an export at all', async () => {
    await expect(importCloudExport({ hello: 'world' })).rejects.toThrow(/not recognised/i)
  })

  it('still accepts one of our own backups', async () => {
    await store.save({ ...(cloudRow() as unknown as PatientRecord), id: 'native', name: 'Native Backup' })
    const file = await gatherBackup()
    await resetStorage()
    const res = await importCloudExport(file)
    expect(res.shape).toBe('app-backup')
    expect((await store.getAll()).map((r) => r.id)).toContain('native')
  })

  it('refuses to import before the device has been set up', async () => {
    // Otherwise the records keep the OLD project's device id, the new project
    // rejects every upload from a device it has never heard of, and they sit
    // pending forever with nothing on screen to explain it.
    //
    // The device id lives in IndexedDB settings, which resetStorage does not
    // clear, so an earlier test in this file would otherwise leave one behind
    // and this assertion would pass for the wrong reason.
    await settings.set('deviceId', null)
    expect(await getDeviceId()).toBeFalsy()

    await expect(importCloudExport([cloudRow()])).rejects.toThrow(/finish setting up/i)
  })
})
