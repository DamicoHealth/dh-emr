/**
 * Wire-shape mapping between the app's camelCase PatientRecord and the
 * snake_case Supabase `records` row, plus the record conflict policy.
 *
 * These rows already exist in org databases and in raw Supabase exports, so
 * the column names and defaults MUST NOT drift. Ported field-for-field from
 * the previous implementation (pwa-sync.js). This is the ONE implementation:
 * the sync engine, backup restore and cloud import all convert through here.
 */
import type { PatientRecord } from '../types/record'

/** A Supabase row: snake_case keys, JSONB columns already parsed. */
export type SupabaseRow = Record<string, unknown>

/** Loose input: a full PatientRecord or a legacy/partial camel-or-snake object. */
type AnyRecord = Record<string, unknown>

/**
 * camelCase record -> snake_case row. Dual-source reads (camel first, snake
 * fallback) keep half-migrated legacy objects uploadable. Scalars default to
 * null; JSONB list/map columns default to [] / {} (never null).
 */
export function recordToSupabaseRow(
  record: PatientRecord | AnyRecord,
  fallbackDeviceId?: string | null,
): SupabaseRow {
  const r = record as AnyRecord
  return {
    id: r.id,
    device_id: r.deviceId || r.device_id || fallbackDeviceId || null,
    site: r.site || null,
    date: r.date || null,
    mrn: r.mrn || null,
    given_name: r.givenName || r.given_name || null,
    family_name: r.familyName || r.family_name || null,
    name: r.name || null,
    sex: r.sex || null,
    dob: r.dob || null,
    phone: r.phone || null,
    pregnant: r.pregnant || null,
    breastfeeding: r.breastfeeding || null,
    temp: r.temp || null,
    bp: r.bp || null,
    weight: r.weight || null,
    allergies: r.allergies || null,
    current_meds: r.currentMeds || r.current_meds || null,
    pmh: r.pmh || null,
    chief_concern: r.chiefConcern || r.chief_concern || null,
    transport: r.transport || null,
    travel_time: r.travelTime || r.travel_time || null,
    access_to_care: r.accessToCare || r.access_to_care || null,
    labs: r.labs || {},
    lab_comments: r.labComments || r.lab_comments || null,
    urinalysis: r.urinalysis || {},
    blood_glucose: r.bloodGlucose || r.blood_glucose || null,
    diagnosis: r.diagnosis || null,
    diagnosis_codes: r.diagnosisCodes || r.diagnosis_codes || [],
    medications: r.medications || [],
    treatment_notes: r.treatmentNotes || r.treatment_notes || null,
    treatment: r.treatment || null,
    procedures: r.procedures || [],
    imaging: r.imaging || null,
    surgery: r.surgery || null,
    referral_type: r.referralType || r.referral_type || null,
    referral_date: r.referralDate || r.referral_date || null,
    referral_status: r.referralStatus || r.referral_status || null,
    provider: r.provider || null,
    notes: r.notes || null,
    age_estimated: !!r.ageEstimated,
    saved_at: r.savedAt || r.saved_at || null,
    custom_fields: r.customFields || r.custom_fields || {},
    template_id: r.templateId || r.template_id || null,
    template_name: r.templateName || r.template_name || null,
    deleted: !!r.deleted,
  }
}

/**
 * snake_case row -> camelCase record. String fields default '', object
 * columns default null, maps default {}, lists default []. The sync stamp at
 * the bottom is load-bearing: pulled records are already synced, so
 * sync_version === synced_version or every pull shows phantom pending
 * records.
 */
export function supabaseRowToRecord(row: SupabaseRow): PatientRecord {
  return {
    id: row.id as string,
    deviceId: (row.device_id as string) || '',
    site: (row.site as string) || '',
    date: (row.date as string) || '',
    mrn: (row.mrn as string) || '',
    givenName: (row.given_name as string) || '',
    familyName: (row.family_name as string) || '',
    name: (row.name as string) || '',
    sex: (row.sex as string) || '',
    dob: (row.dob as string) || '',
    phone: (row.phone as string) || '',
    pregnant: (row.pregnant as string) || '',
    breastfeeding: (row.breastfeeding as string) || '',
    temp: (row.temp as string) || '',
    bp: (row.bp as string) || '',
    weight: (row.weight as string) || '',
    allergies: (row.allergies as string) || '',
    currentMeds: (row.current_meds as string) || '',
    pmh: (row.pmh as string) || '',
    chiefConcern: (row.chief_concern as string) || '',
    transport: (row.transport as string) || '',
    travelTime: (row.travel_time as string) || '',
    accessToCare: (row.access_to_care as PatientRecord['accessToCare']) || null,
    labs: (row.labs as PatientRecord['labs']) || {},
    labComments: (row.lab_comments as string) || '',
    urinalysis: (row.urinalysis as PatientRecord['urinalysis']) || {},
    bloodGlucose: (row.blood_glucose as string) || '',
    diagnosis: (row.diagnosis as string) || '',
    diagnosisCodes: (row.diagnosis_codes as PatientRecord['diagnosisCodes']) || [],
    medications: (row.medications as PatientRecord['medications']) || [],
    treatmentNotes: (row.treatment_notes as string) || '',
    treatment: (row.treatment as string) || '',
    procedures: (row.procedures as string[]) || [],
    imaging: (row.imaging as PatientRecord['imaging']) || null,
    surgery: (row.surgery as PatientRecord['surgery']) || null,
    referralType: (row.referral_type as string) || '',
    referralDate: (row.referral_date as string) || '',
    referralStatus: (row.referral_status as string) || '',
    provider: (row.provider as string) || '',
    notes: (row.notes as string) || '',
    ageEstimated: !!row.age_estimated,
    savedAt: (row.saved_at as string) || '',
    customFields: (row.custom_fields as PatientRecord['customFields']) || {},
    templateId: (row.template_id as string) || '',
    templateName: (row.template_name as string) || '',
    deleted: !!row.deleted,
    sync_version: (row.sync_version as number) || 1,
    synced_version: (row.sync_version as number) || 1, // Pulled records are already synced
  }
}

/** The slice of a record the conflict policy needs. */
interface Mergeable {
  sync_version?: number
  synced_version?: number
  savedAt?: string
  /** legacy rows sometimes carry the snake spelling */
  saved_at?: string
}

/**
 * Merge a remote (pulled) record into the local copy. This is the SINGLE
 * point where record conflict policy lives:
 *  1. A local unsynced edit wins outright - the next push sends it.
 *  2. An older remote copy never overwrites a newer local one.
 *  3. Otherwise remote wins field-by-field via spread (ties and missing
 *     timestamps go to remote).
 * Tombstones need no special case: `deleted` is an ordinary field, and rule 1
 * protects an unsynced local deletion from being resurrected by a pull.
 */
export function mergeRecords<T extends Mergeable>(local: T, remote: T): T {
  if ((local.sync_version || 1) > (local.synced_version || 0)) {
    return local
  }
  const localTs = local.savedAt || local.saved_at || ''
  const remoteTs = remote.savedAt || remote.saved_at || ''
  if (localTs && remoteTs && remoteTs < localTs) {
    return local
  }
  return { ...local, ...remote }
}
