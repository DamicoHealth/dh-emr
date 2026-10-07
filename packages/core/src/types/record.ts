/**
 * The canonical patient encounter record.
 *
 * Ported field-for-field from the previous implementation. Records in this
 * shape exist in org Supabase projects and in backup files, so every field
 * is load-bearing: dropping or renaming one silently loses clinical data on
 * the next save or breaks a restore.
 *
 * Rules encoded here:
 *  - Most scalar clinical values are STRINGS (they come from DOM inputs),
 *    even numeric-looking ones like temp/weight. Do not convert them.
 *  - Objects that mean "nothing recorded" are null, not {} (accessToCare,
 *    urinalysis, imaging, surgery).
 *  - sync_version / synced_version are LOCAL bookkeeping: a record is
 *    unsynced when sync_version > synced_version. Every local edit bumps
 *    sync_version; a confirmed push sets synced_version to the pushed value;
 *    pulled rows arrive with both equal.
 *  - deleted is a SOFT delete; records are never removed from storage.
 */

/** A lab result. Toggle tests carry `result`, numeric tests carry `value`+`unit`. */
export interface LabEntry {
  ordered: boolean
  type: 'toggle' | 'numeric'
  /** toggle tests: 'POS' | 'NEG' | 'N/A' */
  result?: string
  /** numeric tests: the measured value as typed */
  value?: string
  unit?: string
  /** Snapshot of the interpretation AT ENTRY TIME. Never recompute on view:
   *  the org may have edited the reference ranges since. */
  interpretation?: string
}

export type LabsMap = Record<string, LabEntry>

/** Urinalysis dipstick. Keys are the fixed UA params; values are toggle strings. */
export interface Urinalysis {
  leukocytes?: string
  nitrite?: string
  urobilinogen?: string
  protein?: string
  ph?: string
  blood?: string
  sg?: string
  ketones?: string
  bilirubin?: string
  glucose?: string
}

export interface AccessToCare {
  careNotProvided?: string | null
  careNotProvidedNote?: string
  painLevel?: number | null
  soughtCareBefore?: string | null
  careLocations?: string[]
  careLocationOther?: string
  careBarriers?: string[]
  careBarrierOther?: string
  delayedCare?: string | null
  delayedDueToCost?: string | null
  delayedDueToDistance?: string | null
  ranOutOfMeds?: string | null
  travelDistance?: string | null
  travelTime?: string | null
  transportType?: string | null
  transportTypeOther?: string
}

/**
 * Pharmacy's mark on one prescription line (Clinic product). Lives INSIDE
 * the medications JSONB so it syncs like any other edit with no schema
 * change; absent means not dispensed yet. Written through records.update by
 * the Pharmacy workspace, preserved verbatim by every form resave.
 */
export interface MedDispense {
  /** what was handed over, as counted; null when the line had no quantity */
  qty: number | null
  /** display name of the account that dispensed */
  by: string
  /** ISO timestamp */
  at: string
}

export interface Medication {
  id: string
  /** formulary item id, or a plain drug name when there is no formulary entry */
  medId: string
  dose: string
  /** a FREQUENCIES value (e.g. 'BID'); renders via label lookup with raw fallback */
  freq: string
  duration: string
  qty: number | null
  qtyUnit: string | null
  dispensed?: MedDispense
}

export interface Imaging {
  modality: string
  type: string
  findings: string
}

export interface Surgery {
  type: string
  notes: string
}

/** ICD-10 selections. Stored objects carry code + term. */
export interface DiagnosisCode {
  code: string
  term?: string
}

/** Answers to admin-defined custom fields, keyed by stable field id. */
export type CustomFields = Record<string, string | string[] | number | null>

export interface PatientRecord {
  // --- identity ---
  id: string
  deviceId: string
  mrn: string

  // --- encounter context ---
  site: string
  date: string
  provider: string

  // --- demographics ---
  givenName: string
  familyName: string
  name: string
  sex: string
  dob: string
  phone: string
  /** true when DOB was estimated from an age rather than known */
  ageEstimated: boolean

  // --- vitals ---
  temp: string
  bp: string
  weight: string
  pregnant: string
  breastfeeding: string

  // --- history ---
  allergies: string
  currentMeds: string
  pmh: string
  chiefConcern: string

  // --- access to care (+ legacy mirrors kept for backward compatibility) ---
  accessToCare: AccessToCare | null
  transport: string
  travelTime: string

  // --- labs ---
  labs: LabsMap
  labComments: string
  urinalysis: Urinalysis | null
  /** legacy convenience copy of labs['Blood Glucose'].value */
  bloodGlucose: string

  // --- clinical ---
  diagnosis: string
  diagnosisCodes: DiagnosisCode[]
  medications: Medication[]
  treatmentNotes: string
  /** human-readable summary line built from medications + notes */
  treatment: string
  procedures: string[]
  imaging: Imaging | null
  surgery: Surgery | null

  // --- referral ---
  referralType: string
  referralDate: string
  /** set cross-device (e.g. marked Completed on the coordinator's iPad) */
  referralStatus?: string

  notes: string

  // --- form template + custom answers ---
  templateId: string | null
  templateName: string
  customFields: CustomFields

  // --- clinic mode (v4 cloud columns; absent on field-era records) ---
  /** auth user id of the visit's author in clinic mode. Devices round-trip
   *  it untouched; the server coerces any device-side change anyway. */
  user_id?: string | null
  /** current station on the clinic flow board; null/absent = not on the board */
  flow_station?: string | null
  /** when the station last changed (ISO); display and wait-time only */
  flow_updated_at?: string | null

  // --- bookkeeping ---
  savedAt: string
  deleted?: boolean
  sync_version?: number
  synced_version?: number
}

/** A record is UNSYNCED when sync_version > synced_version. */
export function isUnsynced(r: Pick<PatientRecord, 'sync_version' | 'synced_version'>): boolean {
  return (r.sync_version ?? 1) > (r.synced_version ?? 0)
}

/** Active records exclude soft-deleted ones. */
export function isActive(r: Pick<PatientRecord, 'deleted'>): boolean {
  return !r.deleted
}

/** Display name, matching the legacy fallback order. */
export function displayName(r: Pick<PatientRecord, 'givenName' | 'familyName' | 'name'>): string {
  if (r.givenName) return [r.givenName, r.familyName].filter(Boolean).join(' ')
  return r.name || 'Unknown'
}
