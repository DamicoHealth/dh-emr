/**
 * CLINIC DEMO SEEDER - a fictional clinic day in progress that anyone can
 * try in a browser at damicohealth.com/demo/clinic, as any role.
 *
 * An earlier version of this feature in the old app caused a critical
 * incident: it enumerated and deleted every dhemr_ key on load and wiped a
 * real deployment's records. The safety laws below are therefore law, not
 * style (REBUILD-HANDOFF.md section 7):
 *
 *   1. REFUSES to run unless the build set DH_DEMO (__DH_DEMO__ true).
 *   2. Storage is namespaced by the BUILD (DH_STORAGE_SUFFIX=-clinic-demo in
 *      build:demo gives the demo its own IndexedDB database and key prefix
 *      through the kernel's namespace module; the Field demo on the same
 *      origin uses -demo). This module never computes a prefix of its own.
 *   3. NEVER enumerates-and-deletes storage keys. Re-seeding goes through the
 *      kernel's own locked writes: hardResetRecords() + records.mutate() for
 *      the records store, and setConfig/saveLibrary/settings.set for the
 *      KNOWN config and settings keys. No key listing, no database drop, no
 *      bulk clear of local storage (the demo tests scan this file for those
 *      calls, so even naming them here would trip the scan).
 *   4. Can never sync: standalone mode, null cloud credentials, and the
 *      shell never starts the sync engine, the realtime trigger or
 *      auto-sync in a demo build (cloudGuard.ts additionally refuses every
 *      connect path; the simulated gate never asks a server).
 *   5. Every patient and every staff member below is fictional. No real
 *      patient data, ever.
 *
 * Seeding is idempotent per SEED_VERSION AND per calendar day: the board
 * shows TODAY's visits only, so a visitor who comes back tomorrow gets the
 * clinic day re-seeded for that day instead of an empty board (whatever they
 * added the day before goes with it; the demo is a day, not a chart). All
 * ids come from a stable string hash, never from randomness or the clock, so
 * repeated seeds produce the same ids and patient numbers; the time stamps
 * are minutes before the seed moment (injectable), so the board's wait times
 * look like a clinic in progress whenever the demo is opened.
 */
import {
  config,
  hardResetRecords,
  records,
  setCurrentDeviceId,
  settings,
} from '@dh/core/kernel'
import type {
  DiagnosisCode,
  LabEntry,
  Medication,
  PatientRecord,
} from '@dh/core/types/record'
import type { FormTemplateLibrary } from '@dh/core/config/types'
import type { StaffRow } from '@dh/core/ui/staff/staffApi'
import {
  DEFAULT_FLOW_STATIONS,
  saveLibrary,
  setComplaints,
  setConfig,
  setDxPresets,
  setFlowStations,
  setFormulary,
  setHiddenPresets,
  setLabTests,
  setProcedures,
  setProviders,
  setReferralTypes,
  setRxPresets,
  setSites,
} from '@dh/core/config/keys'
import {
  DEFAULT_COMPLAINTS,
  DEFAULT_FORMULARY,
  DEFAULT_LAB_TESTS,
  DEFAULT_PROCEDURES,
  DEFAULT_REFERRAL_TYPES,
  DX_PRESETS,
  FREQUENCIES,
  RX_PRESETS,
  defaultHiddenPresets,
} from '@dh/core/config/defaults'
import { snapshotNumericLab } from '@dh/core/config/labInterpret'
import { generateBaseMRN } from '@dh/core/domain/mrn'
import { calcMedQty } from '@dh/core/domain/medQty'
import { todayLocal } from '@dh/core/domain/today'
import { DEMO_ROLE_KEY, DEMO_ROSTER, DEFAULT_DEMO_ROLE, demoMemberFor, type DemoRoleId } from './gate'

// ---------------------------------------------------------------------------
// Build flag
// ---------------------------------------------------------------------------

declare const __DH_DEMO__: boolean | undefined

/** True only when the build was made with DH_DEMO=1 (vite define). */
export function isDemoBuild(): boolean {
  return typeof __DH_DEMO__ === 'boolean' ? __DH_DEMO__ : false
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Bump to re-seed every returning visitor on their next load. 2: the Lab
 * column (two visits waiting on results seed there; the stations config
 * of a same-day returning visitor would otherwise still lack it).
 */
export const SEED_VERSION = '2'
/** Settings key holding the last seeded version (kernel settings KV). */
export const SEED_FLAG = 'demoSeedVersion'
/** Settings key holding the calendar day the clinic day was seeded for. */
export const SEED_DAY_FLAG = 'demoSeedDay'
/** Settings key holding the simulated staff roster (Staff screen rows). */
export const DEMO_STAFF_KEY = 'demoStaffRoster'
/** Settings key holding the simulated-activity cursor (activity.ts). */
export const DEMO_ACTIVITY_CURSOR_KEY = 'demoActivityCursor'
/** Settings key holding the simulated-activity pause flag (activity.ts). */
export const DEMO_ACTIVITY_PAUSED_KEY = 'demoActivityPaused'

/**
 * Stable demo device identity. Deliberately NOT 'demo-device-001': that is a
 * legacy shared id the sync layer treats as "no identity" (see
 * LEGACY_SHARED_DEVICE_IDS in core/sync/device.ts), and deliberately not the
 * Field demo's id either, so the two demos never look like one device.
 */
export const DEMO_DEVICE_ID = 'demo-clinic-device'
export const DEMO_DEVICE_NAME = 'Demo clinic iPad'

export const DEMO_SITES = ['Kabale Community Clinic', 'Kabale MCH Wing']
// 'Grace N., clinical officer' is ONE provider: commas belong inside a value.
export const DEMO_PROVIDERS = ['Dr. A. Mensah', 'Dr. L. Okot', 'Grace N., clinical officer']
/** The board columns: the shipped defaults, verbatim, in board order. */
export const DEMO_STATIONS: readonly string[] = [...DEFAULT_FLOW_STATIONS]

// ---------------------------------------------------------------------------
// Deterministic helpers - stable hashes, no randomness
// ---------------------------------------------------------------------------

/** djb2-xor string hash, deterministic across runs and platforms. */
export function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h * 33) ^ s.charCodeAt(i)) | 0
  }
  return h >>> 0
}

/** Stable record/med id from a seed string. */
function sid(seed: string): string {
  return 'demo-' + djb2(seed).toString(36)
}

/** The id of the visit for this patient on this date (the activity script needs it). */
export function demoVisitId(givenName: string, familyName: string, date: string): string {
  return sid(givenName + '|' + familyName + '|' + date)
}

/** The local calendar date `minus` days before `todayIso` (YYYY-MM-DD). */
export function demoDaysAgo(minus: number, todayIso: string): string {
  const [y, m, d] = todayIso.split('-').map((x) => parseInt(x, 10))
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() - minus)
  return dt.toISOString().slice(0, 10)
}

/** ISO stamp `minutes` before `now`. */
export function minutesBefore(minutes: number, now: Date): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

/** ISO stamp `days` before `now`. */
function daysBefore(days: number, now: Date): string {
  return new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString()
}

// ---------------------------------------------------------------------------
// Form template library - REAL, with role visibility, so the flagship
// customization is usable and the Roles grid has something to show
// ---------------------------------------------------------------------------

/**
 * Two enabled templates with custom sections, several field types and role
 * overrides. This is not decoration: without a stored library the org's
 * form state reads as "synthesized" (loadLibraryDetailed) and the builder
 * must refuse to save, so the single most differentiated feature would look
 * dead in the demo. Field ids are stable literals: records below store
 * answers under them.
 */
export function buildDemoLibrary(): FormTemplateLibrary {
  return {
    version: 1,
    templates: [
      {
        id: 'general',
        name: 'General Clinic',
        enabled: true,
        schema: {
          sections: [
            {
              id: 'demo-sec-social',
              title: 'Social History',
              order: 6,
              // Triage asks these at the same time as the history; the
              // provider can correct them; everyone else reads.
              roles: { view: 'all', edit: ['triage', 'provider'] },
              fields: [
                {
                  id: 'demo-f-water',
                  label: 'Main source of drinking water',
                  type: 'select',
                  options: ['Borehole', 'Piped', 'Rain water', 'Surface water', 'Unknown'],
                },
                { id: 'demo-f-bednet', label: 'Sleeps under a treated bed net', type: 'yesno' },
                { id: 'demo-f-cookfire', label: 'Cooks indoors on an open fire', type: 'yesno' },
                {
                  id: 'demo-f-travelhrs',
                  label: 'Hours travelled to reach the clinic',
                  type: 'number',
                  min: 0,
                  max: 24,
                },
              ],
            },
            {
              id: 'demo-sec-followup',
              title: 'Follow Up',
              order: 16,
              // The provider decides the follow-up; pharmacy reads it so the
              // counselling matches.
              roles: { view: ['provider', 'pharmacy', 'reception'], edit: ['provider'] },
              fields: [
                {
                  id: 'demo-f-fu-when',
                  label: 'Return in',
                  type: 'select',
                  options: ['No follow up needed', '1 week', '2 weeks', '1 month', '3 months'],
                },
                {
                  id: 'demo-f-fu-notes',
                  label: 'What to check at the next visit',
                  type: 'textarea',
                },
              ],
            },
            // A built-in override, so visitors see what hiding a section does.
            { id: 'surgery', hidden: true },
          ],
        },
      },
      {
        id: 'antenatal',
        name: 'Antenatal Clinic',
        enabled: true,
        schema: {
          sections: [
            {
              id: 'demo-sec-antenatal',
              title: 'Antenatal',
              order: 7,
              collapsed: false,
              roles: { view: 'all', edit: ['triage', 'provider'] },
              fields: [
                { id: 'demo-f-gravida', label: 'Gravida', type: 'number', min: 0, max: 20 },
                { id: 'demo-f-para', label: 'Para', type: 'number', min: 0, max: 20 },
                { id: 'demo-f-lmp', label: 'Last menstrual period', type: 'date' },
                { id: 'demo-f-fundal', label: 'Fundal height (cm)', type: 'number', min: 0, max: 50 },
                { id: 'demo-f-fhr', label: 'Fetal heart heard', type: 'yesno' },
                {
                  id: 'demo-f-danger',
                  label: 'Danger signs discussed',
                  type: 'multiselect',
                  options: [
                    'Bleeding',
                    'Severe headache',
                    'Fever',
                    'Reduced movements',
                    'Swelling of face or hands',
                  ],
                },
                { id: 'demo-f-pain', label: 'Pain score (0-10)', type: 'range', min: 0, max: 10 },
              ],
            },
            { id: 'imaging', title: 'Ultrasound' },
            { id: 'surgery', hidden: true },
            { id: 'procedures', hidden: true },
          ],
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// The simulated staff roster (Staff screen rows). The six seats from gate.ts
// are active accounts; one more fictional person has signed up and waits
// for approval, so the admin's Approve button has something to do.
// ---------------------------------------------------------------------------

export const DEMO_PENDING_STAFF_ID = 'demo-user-pending'

export function buildDemoStaff(now: Date): StaffRow[] {
  const rows: StaffRow[] = DEMO_ROSTER.map((m, i) => ({
    id: m.profile.userId,
    display_name: m.profile.displayName,
    role: m.profile.role,
    is_admin: m.profile.isAdmin,
    activated_at: daysBefore(40 - i, now),
    revoked_at: null,
    created_at: daysBefore(41 - i, now),
  }))
  rows.push({
    id: DEMO_PENDING_STAFF_ID,
    display_name: 'Moses Tumwine',
    role: 'reception',
    is_admin: false,
    activated_at: null,
    revoked_at: null,
    created_at: minutesBefore(35, now),
  })
  return rows
}

// ---------------------------------------------------------------------------
// Fictional patients
// ---------------------------------------------------------------------------

function toggleLab(result: 'POS' | 'NEG'): LabEntry {
  return { ordered: true, type: 'toggle', result }
}

/** An ORDERED toggle test with no result yet: what the Lab queue reads. */
export function pendingToggle(): LabEntry {
  return { ordered: true, type: 'toggle', result: '' }
}

/** Numeric lab entry with the interpretation SNAPSHOTTED at seed time. */
export function numericLab(testId: string, value: string): LabEntry {
  const test = DEFAULT_LAB_TESTS.find((t) => t.id === testId)
  if (!test) throw new Error(`Demo seed references unknown lab test id "${testId}"`)
  return snapshotNumericLab(test, value)
}

/** An ORDERED numeric test with no value yet. */
export function pendingNumeric(testId: string): LabEntry {
  const test = DEFAULT_LAB_TESTS.find((t) => t.id === testId)
  if (!test) throw new Error(`Demo seed references unknown lab test id "${testId}"`)
  return { ordered: true, type: 'numeric', value: '', unit: test.unit || '' }
}

/** Medication line with the dispensing quantity from the REAL calcMedQty. */
export function med(
  seed: string,
  medId: string,
  dose: string,
  freq: string,
  duration: string,
): Medication {
  const q = calcMedQty(medId, dose, freq, duration, DEFAULT_FORMULARY)
  return {
    id: sid('med-' + seed),
    medId,
    dose,
    freq,
    duration,
    qty: q ? q.qty : null,
    qtyUnit: q ? q.unit : null,
  }
}

/** The same line, already handed over by the pharmacy. */
function dispensed(line: Medication, by: string, at: string, qty?: number | null): Medication {
  return { ...line, dispensed: { qty: qty === undefined ? line.qty : qty, by, at } }
}

function medName(medId: string): string {
  const f = DEFAULT_FORMULARY.find((x) => x.id === medId)
  return f ? f.name : medId
}

function freqLabel(v: string): string {
  const f = FREQUENCIES.find((x) => x.value === v)
  return f ? f.label : v
}

/** Human-readable treatment summary, matching the visit form's own format. */
export function treatmentText(meds: Medication[], notes: string): string {
  const lines = meds.map(
    (m) => `${medName(m.medId)} ${m.dose} ${freqLabel(m.freq)} x ${m.duration}`,
  )
  if (notes.trim()) lines.push('Notes: ' + notes.trim())
  return lines.join('; ')
}

export interface VisitSeed extends Partial<PatientRecord> {
  givenName: string
  familyName: string
  dob: string
  sex: string
  date: string
  /** Who registered the visit (stamps user_id); reception by default. */
  author?: DemoRoleId
  /** Today's visits: minutes before the seed moment the patient arrived (savedAt). */
  arrivedMin?: number
  /** Today's visits: the board column, and minutes since the move there. */
  station?: string
  stationMin?: number
}

export interface SeedClock {
  today: string
  now: Date
}

/** Fill a full PatientRecord around a sparse fictional seed. */
export function rec(o: VisitSeed, clock: SeedClock): PatientRecord {
  const mrn = generateBaseMRN(o.givenName, o.familyName, o.dob)
  const id = demoVisitId(o.givenName, o.familyName, o.date)
  const meds = o.medications ?? []
  const author = demoMemberFor(o.author ?? 'reception').profile.userId
  const isToday = o.date === clock.today
  // Today's visits are stamped relative to the seed moment so the board's
  // wait times read like a clinic in progress; earlier days get a stable
  // per-record time of day (minutes from the id hash, no clock reads).
  const minute = 10 + (djb2(id) % 50)
  const savedAt = isToday
    ? minutesBefore(o.arrivedMin ?? 0, clock.now)
    : `${o.date}T09:${minute}:00.000Z`
  const flow = isToday
    ? {
        flow_station: o.station ?? null,
        flow_updated_at: o.station ? minutesBefore(o.stationMin ?? 0, clock.now) : null,
      }
    : {
        flow_station: 'Done',
        flow_updated_at: `${o.date}T11:${minute}:00.000Z`,
      }
  const {
    author: _author,
    arrivedMin: _arrived,
    station: _station,
    stationMin: _stationMin,
    ...fields
  } = o
  const base: PatientRecord = {
    id,
    deviceId: DEMO_DEVICE_ID,
    mrn,
    site: DEMO_SITES[0] ?? '',
    date: o.date,
    provider: DEMO_PROVIDERS[0] ?? '',
    givenName: o.givenName,
    familyName: o.familyName,
    name: `${o.givenName} ${o.familyName}`,
    sex: o.sex,
    dob: o.dob,
    phone: '',
    ageEstimated: false,
    temp: '',
    bp: '',
    weight: '',
    pregnant: '',
    breastfeeding: '',
    allergies: '',
    currentMeds: '',
    pmh: '',
    chiefConcern: '',
    accessToCare: null,
    transport: '',
    travelTime: '',
    labs: {},
    labComments: '',
    urinalysis: null,
    bloodGlucose: '',
    diagnosis: '',
    diagnosisCodes: [],
    medications: meds,
    treatmentNotes: '',
    treatment: treatmentText(meds, o.treatmentNotes ?? ''),
    procedures: [],
    imaging: null,
    surgery: null,
    referralType: 'None',
    referralDate: '',
    notes: '',
    templateId: 'general',
    templateName: 'General Clinic',
    customFields: {},
    user_id: author,
    ...flow,
    savedAt,
    sync_version: 1,
    synced_version: 1,
  }
  return { ...base, ...fields, medications: meds }
}

const B54: DiagnosisCode = { code: 'B54', term: 'Malaria, unspecified' }
const B50: DiagnosisCode = { code: 'B50', term: 'Plasmodium falciparum malaria' }

/** The pharmacist's display name, stamped on every dispensed line. */
const PHARMACIST = demoMemberFor('pharmacy').profile.displayName

/**
 * TODAY: the clinic day in progress, ~15 visits across the default stations.
 *   Check-in 3 (just registered, nothing else entered yet)
 *   Triage   2 (vitals half-entered)
 *   Provider 1 (being seen right now)
 *   Lab      2 (ordered labs, waiting on results: the Lab queue)
 *   Pharmacy 3 (undispensed prescriptions; one penicillin allergy respected)
 *   Done     4 (seen and dispensed)
 * The showcase patients from REBUILD-HANDOFF section 7 are here where they
 * fit: malaria positive, antenatal, paediatric, the penicillin allergy, and
 * a name written in Amharic filed by the real MRN generator.
 */
export function buildTodayVisits(clock: SeedClock): PatientRecord[] {
  const { today } = clock
  const d = (n: number) => demoDaysAgo(n, today)
  // DOBs relative to the seed day so these patients stay children.
  const samuelDob = d(2300) // about 6 years 4 months
  const robertDob = d(1100) // about 3 years
  const r = (o: VisitSeed): PatientRecord => rec({ ...o, date: today }, clock)
  const S = DEMO_STATIONS
  const [CHECK_IN, TRIAGE, PROVIDER, LAB, PHARMACY, DONE] = [S[0], S[1], S[2], S[3], S[4], S[5]]

  return [
    // ---------------------------------------------------------- Check-in
    // A name written in Amharic, filed by the real MRN generator - older
    // builds stripped non-Latin letters and could not file this patient.
    r({
      givenName: 'አማራ', familyName: 'ንጉሤ', dob: '1988-06-15', sex: 'F', date: today,
      station: CHECK_IN, stationMin: 6, arrivedMin: 6,
    }),
    r({
      givenName: 'Joseph', familyName: 'Okello', dob: '1978-11-03', sex: 'M', date: today,
      station: CHECK_IN, stationMin: 4, arrivedMin: 4,
    }),
    r({
      givenName: 'Florence', familyName: 'Namukasa', dob: '2001-02-14', sex: 'F', date: today,
      site: DEMO_SITES[1],
      station: CHECK_IN, stationMin: 2, arrivedMin: 2,
    }),

    // ------------------------------------------------------------ Triage
    // Vitals half-entered: temperature taken, blood pressure not yet.
    r({
      givenName: 'Daniel', familyName: 'Kirya', dob: '1963-01-08', sex: 'M', date: today,
      provider: DEMO_PROVIDERS[1],
      temp: '36.5', pmh: 'Type 2 diabetes', chiefConcern: 'Routine review',
      station: TRIAGE, stationMin: 9, arrivedMin: 24,
    }),
    r({
      givenName: 'Esther', familyName: 'Nabirye', dob: '2007-03-25', sex: 'F', date: today,
      temp: '36.7', bp: '108/68', chiefConcern: 'Wound/Injury',
      station: TRIAGE, stationMin: 4, arrivedMin: 15,
    }),

    // ---------------------------------------------------------- Provider
    // Antenatal visit, being seen right now (no diagnosis yet).
    r({
      givenName: 'Grace', familyName: 'Auma', dob: '1996-02-20', sex: 'F', date: today,
      site: DEMO_SITES[1], templateId: 'antenatal', templateName: 'Antenatal Clinic',
      temp: '37.0', bp: '110/70', weight: '64', pregnant: 'Yes', breastfeeding: 'No',
      allergies: 'NKDA',
      chiefConcern: 'Antenatal check, about 22 weeks',
      labs: { 'HCG/Pregnancy': toggleLab('POS') },
      imaging: {
        modality: 'Ultrasound',
        type: 'OB',
        findings: 'Single intrauterine pregnancy, size consistent with about 22 weeks.',
      },
      customFields: {
        'demo-f-gravida': 2,
        'demo-f-para': 1,
        'demo-f-lmp': d(154),
        'demo-f-fundal': 22,
        'demo-f-fhr': 'Yes',
        'demo-f-danger': ['Bleeding', 'Severe headache', 'Reduced movements'],
        'demo-f-pain': 1,
      },
      station: PROVIDER, stationMin: 11, arrivedMin: 48,
    }),

    // --------------------------------------------------------------- Lab
    // Seen by the provider, tests ordered, waiting on results. The Lab
    // workspace lists them by their pending tests whatever column they are
    // in; the Lab column is where the board shows them waiting.
    // Returning patient (three earlier visits below): fever again.
    r({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: today,
      temp: '38.4', bp: '120/78', weight: '60', allergies: 'NKDA',
      chiefConcern: 'Fever; Headache',
      labs: { 'Malaria RDT': pendingToggle(), Hemoglobin: pendingNumeric('hemoglobin') },
      customFields: { 'demo-f-water': 'Borehole', 'demo-f-bednet': 'No', 'demo-f-travelhrs': 2 },
      station: LAB, stationMin: 20, arrivedMin: 55,
    }),
    r({
      givenName: 'Peter', familyName: 'Ssemakula', dob: '1990-07-09', sex: 'M', date: today,
      temp: '38.9', bp: '124/80', weight: '70', allergies: 'NKDA',
      chiefConcern: 'Fever; Body/Joint Pain',
      labs: { 'Malaria RDT': pendingToggle(), 'Typhoid (Widal/RDT)': pendingToggle() },
      customFields: { 'demo-f-bednet': 'No', 'demo-f-cookfire': 'Yes' },
      station: LAB, stationMin: 15, arrivedMin: 50,
    }),

    // ---------------------------------------------------------- Pharmacy
    // Paediatric malaria (weight-banded dosing), undispensed.
    r({
      givenName: 'Samuel', familyName: 'Ochieng', dob: samuelDob, sex: 'M', date: today,
      provider: DEMO_PROVIDERS[2],
      temp: '38.6', weight: '17', allergies: 'NKDA',
      chiefConcern: 'Fever; poor feeding',
      labs: { 'Malaria RDT': toggleLab('POS') },
      diagnosis: 'Malaria', diagnosisCodes: [B50],
      medications: [med('samuel-today', 'am-artefan', '2 tabs', 'q12h', '3d')],
      customFields: { 'demo-f-bednet': 'No', 'demo-f-fu-when': '1 week' },
      station: PHARMACY, stationMin: 7, arrivedMin: 70,
    }),
    // Penicillin allergy, respected in prescribing; the pharmacy screen
    // shows the allergy beside the line.
    r({
      givenName: 'Miriam', familyName: 'Adeke', dob: '1985-09-30', sex: 'F', date: today,
      temp: '36.6', bp: '116/74', weight: '55',
      allergies: 'Penicillin (rash)',
      chiefConcern: 'Dysuria, 2 days',
      urinalysis: { leukocytes: '2+', nitrite: 'POS', blood: 'Trace' },
      diagnosis: 'UTI',
      medications: [med('miriam-today', 'abx-cipro', '500mg', 'q12h', '5d')],
      notes: 'Penicillin allergy respected: ciprofloxacin chosen instead of amoxicillin.',
      customFields: { 'demo-f-fu-when': '1 week', 'demo-f-fu-notes': 'Review if dysuria persists.' },
      station: PHARMACY, stationMin: 3, arrivedMin: 62,
    }),
    // Adult malaria positive with a SNAPSHOTTED numeric interpretation.
    r({
      givenName: 'Sarah', familyName: 'Akello', dob: '1995-11-21', sex: 'F', date: today,
      temp: '39.1', bp: '112/72', weight: '57', allergies: 'NKDA',
      chiefConcern: 'Fever; Headache',
      labs: { 'Malaria RDT': toggleLab('POS'), Hemoglobin: numericLab('hemoglobin', '9.6') },
      diagnosis: 'Malaria', diagnosisCodes: [B54],
      medications: [
        med('sarah-today-1', 'am-artefan', '4 tabs', 'q12h', '3d'),
        med('sarah-today-2', 'an-para500', '1g', 'q8h', '3d'),
      ],
      customFields: { 'demo-f-bednet': 'No', 'demo-f-fu-when': '2 weeks', 'demo-f-fu-notes': 'Repeat hemoglobin.' },
      station: PHARMACY, stationMin: 12, arrivedMin: 80,
    }),

    // -------------------------------------------------------------- Done
    r({
      givenName: 'John', familyName: 'Mugisha', dob: '1970-05-02', sex: 'M', date: today,
      temp: '36.6', bp: '128/82', weight: '78', allergies: 'NKDA',
      chiefConcern: 'Body/Joint Pain',
      diagnosis: 'Osteoarthritis, right knee',
      medications: [
        dispensed(med('john-today', 'an-ibu', '400mg', 'q8h', '5d'), PHARMACIST, minutesBefore(27, clock.now)),
      ],
      treatmentNotes: 'Take with food.',
      station: DONE, stationMin: 25, arrivedMin: 110,
    }),
    r({
      givenName: 'Agnes', familyName: 'Nankya', dob: '1982-08-19', sex: 'F', date: today,
      site: DEMO_SITES[1], provider: DEMO_PROVIDERS[1],
      temp: '36.8', bp: '118/76', weight: '61', allergies: 'NKDA',
      chiefConcern: 'Skin Rash/Itching',
      diagnosis: 'Tinea corporis',
      medications: [
        dispensed(med('agnes-today-1', 'af-clotrim', 'apply', 'bid-topical', '14d'), PHARMACIST, minutesBefore(42, clock.now), 1),
        dispensed(med('agnes-today-2', 'as-cetir', '10mg', 'q24h', '5d'), PHARMACIST, minutesBefore(42, clock.now)),
      ],
      station: DONE, stationMin: 40, arrivedMin: 130,
    }),
    // Paediatric gastroenteritis, ORS dispensed.
    r({
      givenName: 'Robert', familyName: 'Okot', dob: robertDob, sex: 'M', date: today,
      provider: DEMO_PROVIDERS[2],
      temp: '37.4', weight: '13', allergies: 'NKDA',
      chiefConcern: 'Diarrhea',
      diagnosis: 'Acute gastroenteritis, no dehydration',
      medications: [
        dispensed(med('robert-today', 'gi-ors', '1', 'q8h', '3d'), PHARMACIST, minutesBefore(57, clock.now)),
      ],
      treatmentNotes: 'One sachet after each loose stool; return if unable to drink.',
      customFields: { 'demo-f-water': 'Surface water', 'demo-f-fu-when': '1 week' },
      station: DONE, stationMin: 55, arrivedMin: 140,
    }),
    // A drug outside the formulary: no computed quantity, counted by hand.
    r({
      givenName: 'Mary', familyName: 'Achan', dob: '1960-12-01', sex: 'F', date: today,
      provider: DEMO_PROVIDERS[1],
      temp: '36.5', bp: '150/92', weight: '68', allergies: 'NKDA', pmh: 'Hypertension',
      chiefConcern: 'Routine review',
      diagnosis: 'Hypertension',
      medications: [
        dispensed(med('mary-today', 'Amlodipine 5mg', '5mg', 'q24h', 'Ongoing'), PHARMACIST, minutesBefore(72, clock.now), 30),
      ],
      customFields: { 'demo-f-fu-when': '1 month', 'demo-f-fu-notes': 'Recheck blood pressure.' },
      station: DONE, stationMin: 70, arrivedMin: 160,
    }),
  ]
}

/**
 * EARLIER DAYS: a handful of completed visits for the Visits screen - the
 * returning patient's vitals trend, a completed referral, a chronic review
 * with a snapshotted numeric lab and its legacy mirror.
 */
export function buildEarlierVisits(clock: SeedClock): PatientRecord[] {
  const d = (n: number) => demoDaysAgo(n, clock.today)
  const r = (o: VisitSeed): PatientRecord => rec({ ...o, author: 'provider' }, clock)
  return [
    // Returning patient, 3 earlier visits: fever resolving, weight recovering.
    r({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: d(96),
      temp: '39.2', bp: '118/76', weight: '58', allergies: 'NKDA',
      chiefConcern: 'Fever; Headache',
      labs: { 'Malaria RDT': toggleLab('POS'), Hemoglobin: numericLab('hemoglobin', '9.6') },
      diagnosis: 'Malaria', diagnosisCodes: [B54],
      medications: [
        dispensed(med('amara-1', 'am-artefan', '4 tabs', 'q12h', '3d'), PHARMACIST, `${d(96)}T11:20:00.000Z`),
      ],
      customFields: {
        'demo-f-water': 'Borehole',
        'demo-f-bednet': 'No',
        'demo-f-cookfire': 'Yes',
        'demo-f-travelhrs': 2,
        'demo-f-fu-when': '1 week',
        'demo-f-fu-notes': 'Repeat malaria RDT if fever persists.',
      },
    }),
    r({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: d(38),
      temp: '37.1', bp: '122/78', weight: '59', allergies: 'NKDA',
      chiefConcern: 'Follow-up, feeling better',
      labs: { 'Malaria RDT': toggleLab('NEG'), Hemoglobin: numericLab('hemoglobin', '11.0') },
      diagnosis: 'Malaria, resolved',
      customFields: { 'demo-f-bednet': 'Yes', 'demo-f-fu-when': 'No follow up needed' },
    }),
    r({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: d(4),
      temp: '36.9', bp: '126/80', weight: '60', allergies: 'NKDA',
      chiefConcern: 'Cough, 5 days',
      diagnosis: 'URTI',
      medications: [
        dispensed(med('amara-3', 'an-para500', '1g', 'q8h', '5d'), PHARMACIST, `${d(4)}T10:05:00.000Z`),
      ],
    }),

    // Completed referral.
    r({
      givenName: 'Joseph', familyName: 'Okello', dob: '1978-11-03', sex: 'M', date: d(21),
      provider: DEMO_PROVIDERS[1],
      temp: '36.8', bp: '158/96', weight: '81', allergies: 'NKDA',
      pmh: 'Hypertension',
      chiefConcern: 'Headache; dizziness',
      diagnosis: 'Hypertension, uncontrolled',
      medications: [
        dispensed(med('joseph-1', 'Amlodipine 5mg', '5mg', 'q24h', 'Ongoing'), PHARMACIST, `${d(21)}T10:40:00.000Z`, 30),
      ],
      referralType: 'Hospital',
      referralDate: d(21),
      referralStatus: 'Completed',
      notes: 'Referred for blood pressure review. Seen at the district hospital and started on treatment.',
    }),

    // Chronic disease review with a numeric lab and its top-level mirror.
    r({
      givenName: 'Daniel', familyName: 'Kirya', dob: '1963-01-08', sex: 'M', date: d(30),
      provider: DEMO_PROVIDERS[1],
      temp: '36.5', bp: '142/88', weight: '74', allergies: 'NKDA',
      pmh: 'Type 2 diabetes',
      chiefConcern: 'Routine review',
      labs: { 'Blood Glucose': numericLab('blood_glucose', '182') },
      bloodGlucose: '182',
      diagnosis: 'Diabetes',
      medications: [
        dispensed(med('daniel-1', 'Metformin 500mg', '500mg', 'q12h', 'Ongoing'), PHARMACIST, `${d(30)}T09:50:00.000Z`, 60),
      ],
      customFields: { 'demo-f-fu-when': '1 month' },
    }),
  ]
}

/** Every seeded record: today's clinic day plus the earlier visits. */
export function buildDemoRecords(clock: SeedClock): PatientRecord[] {
  return [...buildTodayVisits(clock), ...buildEarlierVisits(clock)]
}

// ---------------------------------------------------------------------------
// The seeder
// ---------------------------------------------------------------------------

export interface SeedOptions {
  /** Re-seed even when SEED_VERSION and the day already match (Reset demo). */
  force?: boolean
  /**
   * TEST ONLY: overrides the build flag so vitest (which builds with DH_DEMO
   * unset) can exercise the seeder. Production callers must never pass this;
   * the boot hook calls seedDemo() bare and the build define decides.
   */
  demoBuild?: boolean
  /** The seed moment; defaults to the clock. Injectable for tests. */
  now?: Date
  /** Seed day (YYYY-MM-DD); defaults to todayLocal(now). Injectable for tests. */
  today?: string
}

export interface SeedResult {
  seeded: boolean
  records: number
}

export const REFUSAL_MESSAGE =
  'Demo seeding refused: this build was not made with DH_DEMO=1. ' +
  'The seeder never runs against a real deployment.'

/**
 * Seed (or re-seed) the demo clinic. Refuses outside a DH_DEMO build.
 * Idempotent per SEED_VERSION and per calendar day; `force` re-seeds on
 * demand (Reset demo).
 */
export async function seedDemo(opts: SeedOptions = {}): Promise<SeedResult> {
  const demo = opts.demoBuild ?? isDemoBuild()
  // SAFETY LAW 1: refuse, loudly, before touching anything.
  if (!demo) throw new Error(REFUSAL_MESSAGE)

  const now = opts.now ?? new Date()
  const today = opts.today ?? todayLocal(now)

  const already = await settings.get<string>(SEED_FLAG)
  const seededDay = await settings.get<string>(SEED_DAY_FLAG)
  if (already === SEED_VERSION && seededDay === today && !opts.force) {
    return { seeded: false, records: 0 }
  }

  // SAFETY LAW 4: standalone forever, credentials explicitly null. The demo
  // can never reach a cloud.
  await settings.set('standaloneMode', 'true')
  await settings.set('supabaseUrl', null)
  await settings.set('supabaseKey', null)
  await settings.set('deviceId', DEMO_DEVICE_ID)
  await settings.set('deviceName', DEMO_DEVICE_NAME)
  // Admin DEVICE role, so the admin-gated editors (lists, formulary, form
  // setup) are usable from the Admin seat instead of a wall of disabled
  // controls. The simulated ACCOUNT role is a separate thing (gate.ts).
  await settings.set('deviceRole', 'admin')
  setCurrentDeviceId(DEMO_DEVICE_ID)

  // Known config keys only, through the config model's own writers.
  await setSites(config, [...DEMO_SITES])
  await setProviders(config, [...DEMO_PROVIDERS])
  await setFlowStations(config, [...DEMO_STATIONS])
  await setFormulary(config, DEFAULT_FORMULARY.map((f) => ({ ...f })))
  await setLabTests(config, DEFAULT_LAB_TESTS.map((t) => ({ ...t })))
  await setComplaints(config, [...DEFAULT_COMPLAINTS])
  await setProcedures(config, [...DEFAULT_PROCEDURES])
  await setReferralTypes(config, [...DEFAULT_REFERRAL_TYPES])
  await setDxPresets(config, [...DX_PRESETS])
  await setRxPresets(config, RX_PRESETS.map((p) => ({ ...p, meds: p.meds.map((m) => ({ ...m })) })))
  await setHiddenPresets(config, defaultHiddenPresets())
  await setConfig(config, 'formSchema', { sections: [] }) // overwritten by saveLibrary's mirror
  await saveLibrary(config, buildDemoLibrary())

  // The simulated roster and the colleague-activity cursor, known keys.
  await settings.set(DEMO_STAFF_KEY, buildDemoStaff(now))
  await settings.set(DEMO_ACTIVITY_CURSOR_KEY, 0)
  await settings.set(DEMO_ACTIVITY_PAUSED_KEY, false)
  // The picked role survives a day rollover and a reset; only a visitor
  // with no pick yet starts at the default seat.
  if ((await settings.get<string>(DEMO_ROLE_KEY)) === null) {
    await settings.set(DEMO_ROLE_KEY, DEFAULT_DEMO_ROLE)
  }

  // SAFETY LAW 3: records reset goes through the kernel's own locked paths.
  // hardResetRecords() empties the records store (the kernel's maintenance
  // path, never a database drop); the mutate() below rewrites the store and
  // its mirror with the seed set. No storage keys are enumerated anywhere.
  const rows = buildDemoRecords({ today, now })
  await hardResetRecords()
  await records.mutate((all) => {
    all.length = 0
    all.push(...rows)
    return { changed: rows, result: undefined }
  })

  // Setup is complete: the demo opens straight into the clinic and the
  // setup wizard (with its cloud path) never appears.
  await settings.set('setupComplete', 'true')

  // LAST, so a crash mid-seed re-runs the whole seed on the next load.
  await settings.set(SEED_DAY_FLAG, today)
  await settings.set(SEED_FLAG, SEED_VERSION)

  return { seeded: true, records: rows.length }
}

/** Put the demo back to its original clinic day. */
export function resetDemo(opts: Omit<SeedOptions, 'force'> = {}): Promise<SeedResult> {
  return seedDemo({ ...opts, force: true })
}
