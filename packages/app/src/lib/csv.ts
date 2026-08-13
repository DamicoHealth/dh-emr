/**
 * CSV export - a pure port of the legacy exporter (vendored verbatim at
 * tests/fixtures/legacy/csv-export.js).
 *
 * Orgs analyse these exports in Excel/SPSS/R, so the column set and order
 * are a PUBLIC CONTRACT: an inserted or renamed column silently breaks
 * someone's analysis. tests/csv.test.ts asserts byte-identical output
 * against the real legacy implementation.
 *
 * The one intentional addition: custom lab tests get columns AFTER all the
 * legacy ones (legacy iterated only DEFAULT_LAB_TESTS, so an org's own lab
 * was collected and displayed but never exported). Historical columns keep
 * their exact positions.
 */
import type { PatientRecord } from '../types/record'
import type { CustomLabTest } from '../config/types'
import { DEFAULT_LAB_TESTS } from '../config/defaults/labTests'
import { UA_PARAMS } from '../config/defaults/lists'

export interface CustomFieldDef {
  id: string
  label?: string
}

/**
 * Quote per RFC 4180, and neutralise formula injection: a cell starting with
 * = + - @ (or tab/CR) is executed as a formula by Excel and Sheets, so a
 * patient's free-text note could run on someone else's machine.
 */
export function csvEscape(val: unknown): string {
  let s = String(val === null || val === undefined ? '' : val)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return s.includes(',') || s.includes('"') || s.includes('\n')
    ? '"' + s.replace(/"/g, '""') + '"'
    : s
}

const safe = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '')

export interface CsvOptions {
  /** org-defined lab tests; exported after the built-in ones */
  customLabTests?: CustomLabTest[]
  /** admin-defined form fields, one column each, after everything else */
  customFields?: CustomFieldDef[]
}

export function generateCSV(recs: PatientRecord[], opts: CsvOptions = {}): string {
  const customLabTests = opts.customLabTests ?? []
  const customFields = opts.customFields ?? []

  // Encounter number per patient (by MRN, in date order) - matches legacy.
  const seen: Record<string, number> = {}
  const encNum: Record<string, number> = {}
  ;[...recs]
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''))
    .forEach((r) => {
      const mrn = r.mrn || r.id
      seen[mrn] = (seen[mrn] || 0) + 1
      encNum[r.id] = seen[mrn] as number
    })

  const cols: string[] = [
    'MRN', 'EncounterNum', 'Date', 'Site', 'GivenName', 'FamilyName', 'Sex', 'DOB', 'Phone',
    'Pregnant', 'Breastfeeding', 'Temp', 'BP', 'Weight_kg', 'Allergies', 'CurrentMeds', 'PMH',
    'ChiefConcern',
  ]
  const labCols = (t: CustomLabTest): string[] => {
    const s = safe(t.name)
    return t.type === 'toggle'
      ? [`Lab_${s}_Ordered`, `Lab_${s}_Result`]
      : [`Lab_${s}_Value`, `Lab_${s}_Unit`, `Lab_${s}_Interp`]
  }
  DEFAULT_LAB_TESTS.forEach((t) => cols.push(...labCols(t)))
  UA_PARAMS.forEach((p) => cols.push('UA_' + p))
  cols.push(
    'EncounterForm', 'LabComments', 'Diagnosis', 'ICD10', 'Medications', 'Procedures',
    'TreatmentNotes', 'ReferralType', 'Provider', 'Notes', 'AgeEstimated', 'SavedAt',
  )
  customFields.forEach((f) => cols.push('Custom_' + safe(String(f.label || f.id))))
  // Appended last so every legacy column keeps its position.
  customLabTests.forEach((t) => cols.push(...labCols(t)))

  const labCells = (r: PatientRecord, t: CustomLabTest): string[] => {
    const lab = (r.labs && r.labs[t.name]) || ({} as Record<string, unknown>)
    if (t.type === 'toggle') {
      return [lab.ordered ? 'Yes' : 'No', (lab.result as string) || 'N/A']
    }
    const value =
      (lab.value as string) || (t.id === 'blood_glucose' && r.bloodGlucose ? r.bloodGlucose : '')
    return [value, (lab.unit as string) || t.unit || '', (lab.interpretation as string) || '']
  }

  let csv = cols.map(csvEscape).join(',') + '\n'
  for (const r of recs) {
    const gn = r.givenName || (r.name ? r.name.split(' ')[0] : '')
    const fn = r.familyName || (r.name ? r.name.split(' ').slice(1).join(' ') : '')
    const row: unknown[] = [
      r.mrn, encNum[r.id] || 1, r.date, r.site, gn, fn, r.sex, r.dob, r.phone,
      r.pregnant, r.breastfeeding, r.temp, r.bp, r.weight,
      r.allergies, r.currentMeds, r.pmh, r.chiefConcern,
    ]
    DEFAULT_LAB_TESTS.forEach((t) => row.push(...labCells(r, t)))
    UA_PARAMS.forEach((p) => row.push(r.urinalysis ? (r.urinalysis as Record<string, string>)[p] : ''))
    row.push(
      r.templateName || r.templateId || '',
      r.labComments,
      r.diagnosis,
      (r.diagnosisCodes || []).map((c) => c.code).join('; '),
      // Legacy quirk kept for byte parity: the Medications column carries the
      // serialized treatment string, not the medications array.
      r.treatment || '',
      (r.procedures || []).join('; '),
      r.treatmentNotes,
      r.referralType || 'None',
      r.provider,
      r.notes,
      r.ageEstimated ? 'Yes' : 'No',
      r.savedAt,
    )
    customFields.forEach((f) => {
      const v = r.customFields ? r.customFields[f.id] : ''
      row.push(Array.isArray(v) ? v.join('; ') : (v ?? ''))
    })
    customLabTests.forEach((t) => row.push(...labCells(r, t)))
    csv += row.map(csvEscape).join(',') + '\n'
  }
  return csv
}

/** Trigger a browser download of the CSV. */
export function downloadCSV(csv: string, filename = 'dh-emr-export.csv'): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
