/**
 * Wire-shape parity: the camelCase record <-> snake_case Supabase row mapping.
 * These rows already exist in org databases, so the mapping must not drift.
 */
import { describe, expect, it } from 'vitest'
import { mergeRecords, recordToSupabaseRow, supabaseRowToRecord } from '../src/sync/mapping'
import { generateBaseMRN } from '../src/domain/mrn'

const full = {
  id: 'rec-1', deviceId: 'dev-1', site: 'Clinic A', date: '2026-07-01',
  mrn: 'AMNA12041989', givenName: 'Amara', familyName: 'Nakato', name: 'Amara Nakato',
  sex: 'F', dob: '1989-04-12', phone: '0700000000',
  pregnant: 'Yes', breastfeeding: '', temp: '38.9', bp: '118/76', weight: '58',
  allergies: 'NKDA', currentMeds: 'Folic acid', pmh: 'None', chiefConcern: 'Fever',
  transport: 'Boda', travelTime: '30 min',
  accessToCare: { painLevel: 4, careBarriers: ['cost'] },
  labs: { 'Malaria RDT': { ordered: true, result: 'POS', type: 'toggle' } },
  labComments: 'repeat in 3d', urinalysis: { protein: 'Trace' }, bloodGlucose: '104',
  diagnosis: 'Uncomplicated malaria',
  diagnosisCodes: [{ code: 'B54', term: 'Malaria' }],
  medications: [{ id: 'm1', medId: 'AL', dose: '80/480', freq: 'BID', duration: '3 days', qty: 6, qtyUnit: 'tabs' }],
  treatmentNotes: 'hydrate', treatment: 'AL BID x3d', procedures: ['I&D'],
  imaging: { modality: 'Ultrasound', type: 'Abdominal', findings: 'normal' },
  surgery: { type: 'None', notes: '' },
  referralType: 'Antenatal', referralDate: '2026-07-10', referralStatus: 'Pending',
  provider: 'Dr. A', notes: 'follow up', ageEstimated: false,
  templateId: 'general', templateName: 'General Encounter',
  customFields: { painScore: '7', tags: ['a', 'b'] },
  savedAt: '2026-07-01T09:00:00.000Z', deleted: false,
}

describe('record <-> Supabase row mapping', () => {
  it('maps every clinical field to snake_case columns', () => {
    const row = recordToSupabaseRow(full)
    expect(row.given_name).toBe('Amara')
    expect(row.family_name).toBe('Nakato')
    expect(row.current_meds).toBe('Folic acid')
    expect(row.chief_concern).toBe('Fever')
    expect(row.access_to_care).toEqual(full.accessToCare)
    expect(row.lab_comments).toBe('repeat in 3d')
    expect(row.blood_glucose).toBe('104')
    expect(row.diagnosis_codes).toEqual(full.diagnosisCodes)
    expect(row.treatment_notes).toBe('hydrate')
    expect(row.referral_type).toBe('Antenatal')
    expect(row.referral_status).toBe('Pending')
    expect(row.age_estimated).toBe(false)
    expect(row.custom_fields).toEqual(full.customFields)
    expect(row.template_id).toBe('general')
    expect(row.template_name).toBe('General Encounter')
    expect(row.saved_at).toBe(full.savedAt)
    expect(row.device_id).toBe('dev-1')
  })

  it('round-trips back to the app shape without losing clinical data', () => {
    const back = supabaseRowToRecord(recordToSupabaseRow(full))
    for (const k of [
      'id', 'site', 'date', 'mrn', 'givenName', 'familyName', 'sex', 'dob', 'phone',
      'temp', 'bp', 'weight', 'allergies', 'currentMeds', 'pmh', 'chiefConcern',
      'labComments', 'bloodGlucose', 'diagnosis', 'treatmentNotes', 'treatment',
      'referralType', 'referralDate', 'referralStatus', 'provider', 'notes',
      'templateId', 'templateName', 'savedAt',
    ] as const) {
      expect({ k, v: (back as unknown as Record<string, unknown>)[k] }).toEqual({
        k,
        v: (full as unknown as Record<string, unknown>)[k],
      })
    }
    expect(back.customFields).toEqual(full.customFields)
    expect(back.labs).toEqual(full.labs)
    expect(back.medications).toEqual(full.medications)
    expect(back.diagnosisCodes).toEqual(full.diagnosisCodes)
    expect(back.urinalysis).toEqual(full.urinalysis)
  })

  it('marks a pulled row as already synced', () => {
    const back = supabaseRowToRecord(recordToSupabaseRow(full))
    expect(back.sync_version).toBe(back.synced_version)
  })
})

describe('conflict merge policy', () => {
  const base = { ...full, sync_version: 1, synced_version: 1 }

  it('keeps a local unsynced edit rather than letting a pull overwrite it', () => {
    const local = { ...base, diagnosis: 'LOCAL EDIT', sync_version: 2, synced_version: 1 }
    const remote = { ...base, diagnosis: 'remote' }
    expect(mergeRecords(local, remote).diagnosis).toBe('LOCAL EDIT')
  })

  it('prefers the newer saved_at when there is no local edit', () => {
    const local = { ...base, diagnosis: 'older', savedAt: '2026-07-01T09:00:00.000Z' }
    const remote = { ...base, diagnosis: 'newer', savedAt: '2026-07-02T09:00:00.000Z' }
    expect(mergeRecords(local, remote).diagnosis).toBe('newer')
  })

  it('does not let an older remote copy overwrite a newer local one', () => {
    const local = { ...base, diagnosis: 'newer', savedAt: '2026-07-05T09:00:00.000Z' }
    const remote = { ...base, diagnosis: 'stale', savedAt: '2026-07-01T09:00:00.000Z' }
    expect(mergeRecords(local, remote).diagnosis).toBe('newer')
  })

  // Caught live in the first two-device E2E (2026-10-06): a delete does not
  // advance savedAt, so a pulled tombstone carries the SAME instant as the
  // local copy - but Postgres returns '+00:00' where the device stored 'Z',
  // and a raw string compare calls the remote older. Result in the field:
  // deletes pushed fine and then never applied anywhere. Timestamps must be
  // compared as instants, not strings.
  it('applies a remote tombstone whose timestamp is equal but Postgres-formatted', () => {
    const local = {
      ...base,
      deleted: false,
      sync_version: 2,
      synced_version: 2,
      savedAt: '2026-10-06T19:45:07.363Z',
    }
    const remote = {
      ...base,
      deleted: true,
      sync_version: 1,
      synced_version: 1,
      savedAt: '2026-10-06T19:45:07.363+00:00',
    }
    expect(mergeRecords(local, remote).deleted).toBe(true)
  })

  it('still treats a Postgres-formatted remote as newer when it IS newer', () => {
    const local = { ...base, diagnosis: 'older', savedAt: '2026-07-01T09:00:00.000Z' }
    const remote = { ...base, diagnosis: 'newer', savedAt: '2026-07-01T09:00:01+00:00' }
    expect(mergeRecords(local, remote).diagnosis).toBe('newer')
  })

  // Also caught live: the push row omitted sync_version, so every cloud row
  // sat at the column default (1) forever and pulled records erased their
  // version lineage. The cloud must carry the writer's version, as v3 did.
  it('pushes the record version so the cloud carries the writer lineage', () => {
    const row = recordToSupabaseRow({ ...full, sync_version: 7, synced_version: 6 })
    expect(row.sync_version).toBe(7)
  })
})

describe('MRN generation parity', () => {
  it('matches the legacy algorithm (2+2 initials + DDMMYYYY)', () => {
    expect(generateBaseMRN('Amara', 'Nakato', '1989-04-12')).toBe('AMNA12041989')
    expect(generateBaseMRN('Joseph', 'Okello', '1962-09-03')).toBe('JOOK03091962')
  })

  it('returns empty (never a partial MRN) when it cannot be formed', () => {
    expect(generateBaseMRN('A', 'Nakato', '1989-04-12')).toBe('')
    expect(generateBaseMRN('Amara', 'Nakato', '')).toBe('')
  })
})
