/**
 * DEMO MODE SEEDER - a self-contained fictional clinic anyone can try in a
 * browser at damicohealth.com/demo.
 *
 * An earlier version of this feature in the old app caused a critical
 * incident: it enumerated and deleted every dhemr_ key on load and wiped a
 * real deployment's records. The safety laws below are therefore law, not
 * style (REBUILD-HANDOFF.md section 7):
 *
 *   1. REFUSES to run unless the build set DH_DEMO (__DH_DEMO__ true).
 *   2. Storage is namespaced by the BUILD (DH_STORAGE_SUFFIX=-demo gives the
 *      demo its own IndexedDB database and key prefix via the kernel's
 *      namespace module). This module never computes a prefix of its own.
 *   3. NEVER enumerates-and-deletes storage keys. Re-seeding goes through
 *      the kernel's own locked writes: hardResetRecords() + records.mutate()
 *      for the records store, and setConfig/saveLibrary/settings.set for the
 *      KNOWN config and settings keys. No key listing, no database drop, no
 *      bulk clear of local storage (the demo tests scan this file for those
 *      calls, so even naming them here would trip the scan).
 *   4. Forces standalone mode with null cloud credentials; the demo can
 *      never sync (cloudGuard.ts additionally blocks the connect paths).
 *   5. Every patient below is fictional. No real patient data, ever.
 *
 * Seeding is idempotent per SEED_VERSION (stored via the kernel settings
 * KV): a returning visitor keeps whatever they added until the version is
 * bumped or they press Reset Demo. All ids come from a stable string hash,
 * never from randomness or the clock, so repeated seeds produce
 * byte-identical records. Dates are relative to the seed day (todayLocal)
 * so the demo always looks current.
 */
import {
  config,
  hardResetRecords,
  records,
  setCurrentDeviceId,
  settings,
} from '@dh/core/kernel'
import type { LabEntry, Medication, PatientRecord } from '@dh/core/types/record'
import type { FormTemplateLibrary } from '@dh/core/config/types'
import {
  saveLibrary,
  setComplaints,
  setConfig,
  setDxPresets,
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

/** Bump to re-seed every returning visitor on their next load. */
export const SEED_VERSION = '1'
/** Settings key holding the last seeded version (kernel settings KV). */
export const SEED_FLAG = 'demoSeedVersion'

/**
 * Stable demo device identity. Deliberately NOT 'demo-device-001': that is a
 * legacy shared id the sync layer treats as "no identity" (see
 * LEGACY_SHARED_DEVICE_IDS in src/sync/device.ts).
 */
export const DEMO_DEVICE_ID = 'demo-device'
export const DEMO_DEVICE_NAME = 'Demo iPad'

export const DEMO_SITES = [
  'Kabale Community Clinic',
  'Rukungiri Outreach',
  'Mobile Unit A',
]
// 'Grace N., clinical officer' is ONE provider: commas belong inside a value.
export const DEMO_PROVIDERS = ['Dr. A. Mensah', 'Dr. L. Okot', 'Grace N., clinical officer']

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

/** The local calendar date `minus` days before `todayIso` (YYYY-MM-DD). */
export function demoDaysAgo(minus: number, todayIso: string): string {
  const [y, m, d] = todayIso.split('-').map((x) => parseInt(x, 10))
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))
  dt.setUTCDate(dt.getUTCDate() - minus)
  return dt.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Form template library - REAL, so the flagship customization is usable
// ---------------------------------------------------------------------------

/**
 * Two enabled templates with custom sections and several field types. This is
 * not decoration: without a stored library the org's form state reads as
 * "synthesized" (loadLibraryDetailed) and the builder must refuse to save, so
 * the single most differentiated feature would look dead in the demo.
 * Field ids are stable literals: records below store answers under them.
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
        id: 'outreach',
        name: 'Mobile Outreach',
        enabled: true,
        schema: {
          sections: [
            {
              id: 'demo-sec-screening',
              title: 'Outreach Screening',
              order: 6,
              fields: [
                { id: 'demo-f-pain', label: 'Pain score (0-10)', type: 'range', min: 0, max: 10 },
                {
                  id: 'demo-f-screens',
                  label: 'Screening done',
                  type: 'multiselect',
                  options: ['Malaria RDT', 'Blood pressure', 'Blood sugar', 'MUAC'],
                },
                { id: 'demo-f-netgiven', label: 'Bed net given today', type: 'yesno' },
                { id: 'demo-f-outreach-notes', label: 'Outreach notes', type: 'textarea' },
              ],
            },
            { id: 'imaging', hidden: true },
            { id: 'surgery', hidden: true },
            { id: 'referral', title: 'Refer to District Hospital' },
          ],
        },
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Fictional patients
// ---------------------------------------------------------------------------

function toggleLab(result: 'POS' | 'NEG'): LabEntry {
  return { ordered: true, type: 'toggle', result }
}

/** Numeric lab entry with the interpretation SNAPSHOTTED at seed time. */
function numericLab(testId: string, value: string): LabEntry {
  const test = DEFAULT_LAB_TESTS.find((t) => t.id === testId)
  if (!test) throw new Error(`Demo seed references unknown lab test id "${testId}"`)
  return snapshotNumericLab(test, value)
}

/** Medication line with the dispensing quantity from the REAL calcMedQty. */
function med(seed: string, medId: string, dose: string, freq: string, duration: string): Medication {
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

function medName(medId: string): string {
  const f = DEFAULT_FORMULARY.find((x) => x.id === medId)
  return f ? f.name : medId
}

function freqLabel(v: string): string {
  const f = FREQUENCIES.find((x) => x.value === v)
  return f ? f.label : v
}

/** Human-readable treatment summary, matching the visit form's own format. */
function treatmentText(meds: Medication[], notes: string): string {
  const lines = meds.map(
    (m) => `${medName(m.medId)} ${m.dose} ${freqLabel(m.freq)} x ${m.duration}`,
  )
  if (notes.trim()) lines.push('Notes: ' + notes.trim())
  return lines.join('; ')
}

type Seed = Partial<PatientRecord> & {
  givenName: string
  familyName: string
  dob: string
  sex: string
  date: string
}

/** Fill a full PatientRecord around a sparse fictional seed. */
function rec(o: Seed): PatientRecord {
  const mrn = generateBaseMRN(o.givenName, o.familyName, o.dob)
  const id = sid(o.givenName + '|' + o.familyName + '|' + o.date)
  // Stable per-record time of day (minutes from the id hash, no clock reads).
  const minute = 10 + (djb2(id) % 50)
  const meds = o.medications ?? []
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
    allergies: 'NKDA',
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
    savedAt: `${o.date}T09:${minute}:00.000Z`,
    sync_version: 1,
    synced_version: 1,
  }
  return { ...base, ...o, medications: meds }
}

/**
 * The showcase patients from REBUILD-HANDOFF section 7. Every one is
 * fictional; each exists to make a real capability visible: a returning
 * patient with a vitals trend, a malaria-positive visit with a snapshotted
 * numeric interpretation, an antenatal visit, a paediatric visit, a
 * completed referral, a penicillin allergy respected in prescribing, and a
 * name written in Amharic (filed by the real MRN generator).
 */
export function buildDemoRecords(todayIso: string): PatientRecord[] {
  const d = (n: number) => demoDaysAgo(n, todayIso)
  // The paediatric DOB is relative to the seed day so this patient stays a
  // child no matter when the demo is opened (about 6 years 4 months old).
  const paediatricDob = demoDaysAgo(2300, todayIso)

  return [
    // Returning patient, 3 visits: fever resolving, weight recovering.
    rec({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: d(96),
      temp: '39.2', bp: '118/76', weight: '58',
      chiefConcern: 'Fever; Headache',
      labs: {
        'Malaria RDT': toggleLab('POS'),
        Hemoglobin: numericLab('hemoglobin', '9.6'),
      },
      diagnosis: 'Malaria',
      diagnosisCodes: [{ code: 'B54', term: 'Malaria, unspecified' }],
      medications: [med('amara-1', 'am-artefan', '4 tabs', 'q12h', '3d')],
      customFields: {
        'demo-f-water': 'Borehole',
        'demo-f-bednet': 'No',
        'demo-f-cookfire': 'Yes',
        'demo-f-travelhrs': 2,
        'demo-f-fu-when': '1 week',
        'demo-f-fu-notes': 'Repeat malaria RDT if fever persists.',
      },
    }),
    rec({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: d(38),
      temp: '37.1', bp: '122/78', weight: '59',
      chiefConcern: 'Follow-up, feeling better',
      labs: {
        'Malaria RDT': toggleLab('NEG'),
        Hemoglobin: numericLab('hemoglobin', '11.0'),
      },
      diagnosis: 'Malaria, resolved',
      customFields: { 'demo-f-bednet': 'Yes', 'demo-f-fu-when': 'No follow up needed' },
    }),
    rec({
      givenName: 'Amara', familyName: 'Nakato', dob: '1991-04-12', sex: 'F', date: d(4),
      temp: '36.9', bp: '126/80', weight: '60',
      chiefConcern: 'Cough, 5 days',
      diagnosis: 'URTI',
      medications: [med('amara-3', 'an-para500', '1g', 'q8h', '5d')],
    }),

    // Completed referral.
    rec({
      givenName: 'Joseph', familyName: 'Okello', dob: '1978-11-03', sex: 'M', date: d(21),
      site: DEMO_SITES[1], provider: DEMO_PROVIDERS[1],
      temp: '36.8', bp: '158/96', weight: '81',
      pmh: 'Hypertension',
      chiefConcern: 'Headache; dizziness',
      diagnosis: 'Hypertension, uncontrolled',
      medications: [med('joseph-1', 'Amlodipine 5mg', '5mg', 'q24h', 'Ongoing')],
      referralType: 'Hospital',
      referralDate: d(21),
      referralStatus: 'Completed',
      notes: 'Referred for blood pressure review. Seen at the district hospital and started on treatment.',
    }),

    // Antenatal visit.
    rec({
      givenName: 'Grace', familyName: 'Auma', dob: '1996-02-20', sex: 'F', date: d(9),
      temp: '37.0', bp: '110/70', weight: '64',
      pregnant: 'Yes', breastfeeding: 'No',
      chiefConcern: 'Antenatal check, about 22 weeks',
      labs: { 'HCG/Pregnancy': toggleLab('POS') },
      imaging: {
        modality: 'Ultrasound',
        type: 'OB',
        findings: 'Single intrauterine pregnancy, size consistent with about 22 weeks.',
      },
      diagnosis: 'Normal antenatal visit',
      medications: [med('grace-1', 'vit-prenatal', '1 tab', 'q24h', 'Ongoing')],
    }),

    // Paediatric malaria (weight-banded dosing).
    rec({
      givenName: 'Samuel', familyName: 'Ochieng', dob: paediatricDob, sex: 'M', date: d(6),
      site: DEMO_SITES[2], provider: DEMO_PROVIDERS[2],
      temp: '38.6', weight: '17',
      chiefConcern: 'Fever; poor feeding',
      labs: { 'Malaria RDT': toggleLab('POS') },
      diagnosis: 'Malaria',
      diagnosisCodes: [{ code: 'B50', term: 'Plasmodium falciparum malaria' }],
      medications: [med('samuel-1', 'am-artefan', '2 tabs', 'q12h', '3d')],
    }),

    // Penicillin allergy, respected in prescribing.
    rec({
      givenName: 'Miriam', familyName: 'Adeke', dob: '1985-09-30', sex: 'F', date: d(3),
      temp: '36.6', bp: '116/74', weight: '55',
      allergies: 'Penicillin (rash)',
      chiefConcern: 'Dysuria, 2 days',
      urinalysis: { leukocytes: '2+', nitrite: 'POS', blood: 'Trace' },
      diagnosis: 'UTI',
      medications: [med('miriam-1', 'abx-cipro', '500mg', 'q12h', '5d')],
      notes: 'Penicillin allergy respected: ciprofloxacin chosen instead of amoxicillin.',
    }),

    // A name written in Amharic, filed by the real MRN generator - older
    // builds stripped non-Latin letters and could not file this patient.
    rec({
      givenName: 'አማራ', familyName: 'ንጉሤ', dob: '1988-06-15', sex: 'F', date: d(2),
      site: DEMO_SITES[2], provider: DEMO_PROVIDERS[2],
      templateId: 'outreach', templateName: 'Mobile Outreach',
      temp: '37.2', bp: '120/78', weight: '62',
      chiefConcern: 'Abdominal Pain',
      labs: { 'H. pylori': toggleLab('POS') },
      diagnosis: 'PUD/GERD',
      medications: [med('almaz-1', 'gi-omep', '20mg', 'q12h', '14d')],
      customFields: {
        'demo-f-pain': 4,
        'demo-f-screens': ['Malaria RDT', 'Blood pressure'],
        'demo-f-netgiven': 'Yes',
        'demo-f-outreach-notes': 'Counselled on taking omeprazole before the morning meal.',
      },
    }),

    // Chronic disease review with a numeric lab and its top-level mirror.
    rec({
      givenName: 'Daniel', familyName: 'Kirya', dob: '1963-01-08', sex: 'M', date: d(1),
      provider: DEMO_PROVIDERS[1],
      temp: '36.5', bp: '142/88', weight: '74',
      pmh: 'Type 2 diabetes',
      chiefConcern: 'Routine review',
      labs: { 'Blood Glucose': numericLab('blood_glucose', '182') },
      bloodGlucose: '182',
      diagnosis: 'Diabetes',
      medications: [med('daniel-1', 'Metformin 500mg', '500mg', 'q12h', 'Ongoing')],
    }),

    // Minor procedure.
    rec({
      givenName: 'Esther', familyName: 'Nabirye', dob: '2007-03-25', sex: 'F', date: d(1),
      site: DEMO_SITES[1],
      temp: '36.7', bp: '108/68', weight: '48',
      chiefConcern: 'Wound/Injury',
      diagnosis: 'Laceration, left forearm',
      procedures: ['Wound Closure/Sutures'],
      medications: [med('esther-1', 'an-para500', '500mg', 'q8h', '3d')],
      treatmentNotes: 'Wound cleaned and closed with 4 sutures. Remove in 7 days.',
    }),
  ]
}

// ---------------------------------------------------------------------------
// The seeder
// ---------------------------------------------------------------------------

export interface SeedOptions {
  /** Re-seed even when SEED_VERSION already matches (Reset Demo). */
  force?: boolean
  /**
   * TEST ONLY: overrides the build flag so vitest (which builds with DH_DEMO
   * unset) can exercise the seeder. Production callers must never pass this;
   * the boot hook calls seedDemo() bare and the build define decides.
   */
  demoBuild?: boolean
  /** Seed day (YYYY-MM-DD); defaults to todayLocal(). Injectable for tests. */
  today?: string
}

export interface SeedResult {
  seeded: boolean
  records: number
}

const REFUSAL_MESSAGE =
  'Demo seeding refused: this build was not made with DH_DEMO=1. ' +
  'The seeder never runs against a real deployment.'

/**
 * Seed (or re-seed) the demo clinic. Refuses outside a DH_DEMO build.
 * Idempotent per SEED_VERSION; `force` re-seeds on demand (Reset Demo).
 */
export async function seedDemo(opts: SeedOptions = {}): Promise<SeedResult> {
  const demo = opts.demoBuild ?? isDemoBuild()
  // SAFETY LAW 1: refuse, loudly, before touching anything.
  if (!demo) throw new Error(REFUSAL_MESSAGE)

  const already = await settings.get<string>(SEED_FLAG)
  if (already === SEED_VERSION && !opts.force) {
    return { seeded: false, records: 0 }
  }

  const today = opts.today ?? todayLocal()

  // SAFETY LAW 4: standalone forever, credentials explicitly null. The demo
  // can never reach a cloud.
  await settings.set('standaloneMode', 'true')
  await settings.set('supabaseUrl', null)
  await settings.set('supabaseKey', null)
  await settings.set('deviceId', DEMO_DEVICE_ID)
  await settings.set('deviceName', DEMO_DEVICE_NAME)
  // Admin, so the admin-gated screens (lists, formulary, form setup) are
  // usable instead of showing a wall of disabled controls.
  await settings.set('deviceRole', 'admin')
  setCurrentDeviceId(DEMO_DEVICE_ID)

  // Known config keys only, through the config model's own writers.
  await setSites(config, [...DEMO_SITES])
  await setProviders(config, [...DEMO_PROVIDERS])
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

  // SAFETY LAW 3: records reset goes through the kernel's own locked paths.
  // hardResetRecords() empties the records store (the kernel's maintenance
  // path, never a database drop); the mutate() below rewrites the store and
  // its mirror with the seed set. No storage keys are enumerated anywhere.
  const rows = buildDemoRecords(today)
  await hardResetRecords()
  await records.mutate((all) => {
    all.length = 0
    all.push(...rows)
    return { changed: rows, result: undefined }
  })

  // Setup is complete: the demo opens straight into a working clinic and the
  // setup wizard (with its cloud path) never appears.
  await settings.set('setupComplete', 'true')

  // LAST, so a crash mid-seed re-runs the whole seed on the next load.
  await settings.set(SEED_FLAG, SEED_VERSION)

  return { seeded: true, records: rows.length }
}

/** Put the demo back to its original fictional patients. */
export function resetDemo(opts: Omit<SeedOptions, 'force'> = {}): Promise<SeedResult> {
  return seedDemo({ ...opts, force: true })
}
