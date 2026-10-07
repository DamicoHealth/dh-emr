/**
 * Pure data functions behind the Records screen: grouping encounters into
 * patients, filters, search, age, and the lab-positive badge.
 *
 * Ported from the previous implementation. tests/parity.test.ts differential
 * tests these against re-implemented legacy oracles (records.js, labs.js,
 * helpers.js): every case either proves identical behavior or documents a
 * DELIBERATE improvement with the reason.
 */
import type { PatientRecord } from '../types/record'
import { displayName } from '../types/record'

/** One patient = all encounters sharing an MRN, newest first. */
export interface PatientGroup {
  mrn: string
  name: string
  sex: string
  dob: string
  latest: PatientRecord
  encounters: PatientRecord[]
  visitCount: number
  flags: { labPositive: boolean; referred: boolean; pregnant: boolean }
}

export interface RecordFilters {
  search: string
  site: string
  provider: string
  referral: string
  dateFrom: string
  dateTo: string
}

export const EMPTY_FILTERS: RecordFilters = {
  search: '',
  site: '',
  provider: '',
  referral: '',
  dateFrom: '',
  dateTo: '',
}

/**
 * A lab counts as positive when an ordered toggle test reads POS.
 *
 * IMPROVEMENT over legacy: iterates the RECORD's own labs, not the configured
 * test list. Legacy iterated config, so deleting a custom test silently hid
 * an existing positive result on historical records.
 */
export function hasLabPositive(r: PatientRecord): boolean {
  const labs = r.labs || {}
  return Object.keys(labs).some((k) => {
    const l = labs[k]
    return !!l && l.ordered === true && String(l.result || '').toUpperCase() === 'POS'
  })
}

/**
 * Age in whole years. IMPROVEMENT over legacy: a future or absurd DOB yields
 * null instead of a negative age.
 */
export function calcAge(dobIso: string): number | null {
  if (!dobIso) return null
  const d = new Date(dobIso)
  if (Number.isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  const m = now.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--
  return age >= 0 && age < 130 ? age : null
}

export function applyFilters(records: PatientRecord[], f: RecordFilters): PatientRecord[] {
  const q = f.search.trim().toLowerCase()
  return records.filter((r) => {
    if (f.site && r.site !== f.site) return false
    if (f.provider && r.provider !== f.provider) return false
    if (f.referral && r.referralType !== f.referral) return false
    if (f.dateFrom && (r.date || '') < f.dateFrom) return false
    if (f.dateTo && (r.date || '') > f.dateTo) return false
    if (q) {
      // Build the haystack from present values only - the legacy version
      // concatenated raw fields and produced the literal string "undefined",
      // which then matched a search for "undef".
      const hay = [displayName(r), r.mrn, r.chiefConcern, r.diagnosis, r.site, r.provider]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
}

/** Group encounters by MRN into patients, newest visit first. */
export function groupByPatient(records: PatientRecord[]): PatientGroup[] {
  const map = new Map<string, PatientRecord[]>()
  for (const r of records) {
    const key = r.mrn || r.id
    const list = map.get(key)
    if (list) list.push(r)
    else map.set(key, [r])
  }
  const groups: PatientGroup[] = []
  map.forEach((encounters, mrn) => {
    encounters.sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    const latest = encounters[0] as PatientRecord
    groups.push({
      mrn,
      name: displayName(latest),
      sex: latest.sex || '',
      dob: latest.dob || '',
      latest,
      encounters,
      visitCount: encounters.length,
      flags: {
        labPositive: encounters.some(hasLabPositive),
        referred: encounters.some((e) => !!e.referralType && e.referralType !== 'None'),
        pregnant: encounters.some((e) => e.pregnant === 'Yes'),
      },
    })
  })
  // Most recently seen patients first.
  groups.sort((a, b) => (b.latest.date || '').localeCompare(a.latest.date || ''))
  return groups
}

/** DD/MM/YYYY, matching the form's date entry convention. */
export function formatDate(iso: string): string {
  if (!iso) return ''
  const parts = iso.split('-')
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`
  return iso
}

/** Distinct non-empty values of a field, for filter dropdowns. */
export function distinct(records: PatientRecord[], key: keyof PatientRecord): string[] {
  const s = new Set<string>()
  for (const r of records) {
    const v = r[key]
    if (typeof v === 'string' && v) s.add(v)
  }
  return [...s].sort((a, b) => a.localeCompare(b))
}
