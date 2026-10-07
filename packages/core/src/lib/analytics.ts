/**
 * Analytics aggregation.
 *
 * Ported from the reference implementation (screens/Analytics/aggregate.ts).
 * The legacy screen before THAT ran ~50 independent passes over the record
 * array plus 18 regexes per record on every render. This computes everything
 * in ONE pass and is memoized by the caller, so opening the tab stays instant
 * at thousands of records. Keep it single-pass.
 *
 * METRIC DEFINITIONS ARE FROZEN: orgs have been reading reports built on
 * these exact rules. A quietly "improved" definition silently changes every
 * historical number they compare against. tests/analytics.test.ts pins them.
 */
import type { PatientRecord } from '../types/record'
import { hasLabPositive } from './patients'

/**
 * Age on a given date (the encounter date), falling back to today. Same
 * 0-129 clamp as calcAge in lib/patients, which is the as-of-today variant
 * and therefore NOT reusable here: across multi-year datasets an as-of-today
 * age silently moves patients between bands.
 */
export function calcAgeAt(dobIso: string, onIso?: string): number | null {
  if (!dobIso) return null
  const d = new Date(dobIso)
  const on = onIso ? new Date(onIso) : new Date()
  if (Number.isNaN(d.getTime()) || Number.isNaN(on.getTime())) return null
  let age = on.getFullYear() - d.getFullYear()
  const m = on.getMonth() - d.getMonth()
  if (m < 0 || (m === 0 && on.getDate() < d.getDate())) age--
  return age >= 0 && age < 130 ? age : null
}

/**
 * Reference filters plus `provider`, which this app's Analytics screen
 * exposes. Empty string = no constraint, so the reference behavior is a
 * strict subset.
 */
export interface AnalyticsFilters {
  from: string
  to: string
  site: string
  provider: string
  sex: string
}

export const EMPTY_ANALYTICS_FILTERS: AnalyticsFilters = {
  from: '',
  to: '',
  site: '',
  provider: '',
  sex: '',
}

export interface Counted {
  name: string
  value: number
}
export interface TrendPoint {
  date: string
  encounters: number
  patients: number
}
export interface AgeBand {
  band: string
  male: number
  female: number
}
export interface LabStat {
  name: string
  positive: number
  tested: number
  rate: number
}

export interface Analytics {
  encounters: number
  patients: number
  newPatients: number
  returnVisits: number
  referrals: number
  labPositive: number
  pediatric: number
  female: number
  medianAge: number | null
  trend: TrendPoint[]
  topDiagnoses: Counted[]
  bySite: Counted[]
  byProvider: Counted[]
  ageBands: AgeBand[]
  labStats: LabStat[]
  topMedications: Counted[]
  dataQuality: { missingDiagnosis: number; missingVitals: number; missingProvider: number }
}

/** [label, inclusive lower, exclusive upper] - band edges are frozen. */
export const AGE_BANDS: [string, number, number][] = [
  ['<1', 0, 1],
  ['1-4', 1, 5],
  ['5-14', 5, 15],
  ['15-24', 15, 25],
  ['25-44', 25, 45],
  ['45-64', 45, 65],
  ['65+', 65, 200],
]

/** Ties break by name so the result never depends on record order. */
function topN(map: Map<string, number>, n: number): Counted[] {
  return [...map.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name))
    .slice(0, n)
}

export function applyAnalyticsFilters(
  records: PatientRecord[],
  f: AnalyticsFilters,
): PatientRecord[] {
  return records.filter((r) => {
    if (f.site && r.site !== f.site) return false
    if (f.provider && r.provider !== f.provider) return false
    if (f.sex && r.sex !== f.sex) return false
    if (f.from && (r.date || '') < f.from) return false
    if (f.to && (r.date || '') > f.to) return false
    return true
  })
}

/** First-seen date per patient across the WHOLE dataset (not the filtered set). */
export function firstSeenByPatient(all: PatientRecord[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of all) {
    const key = r.mrn || r.id
    const d = r.date || ''
    const prev = m.get(key)
    if (prev === undefined || d < prev) m.set(key, d)
  }
  return m
}

export function computeAnalytics(
  records: PatientRecord[],
  firstSeen?: Map<string, string>,
): Analytics {
  const byDate = new Map<string, { encounters: number; patients: Set<string> }>()
  const diagnoses = new Map<string, number>()
  const sites = new Map<string, number>()
  const providers = new Map<string, number>()
  const meds = new Map<string, number>()
  const labTested = new Map<string, number>()
  const labPos = new Map<string, number>()
  const bands = new Map<string, { male: number; female: number }>()
  const patientFirstSeen = new Map<string, string>()
  const ages: number[] = []

  let referrals = 0
  let labPositiveCount = 0
  let pediatric = 0
  let female = 0
  let missingDiagnosis = 0
  let missingVitals = 0
  let missingProvider = 0

  for (const r of records) {
    const mrn = r.mrn || r.id
    const date = r.date || ''

    // trend
    let d = byDate.get(date)
    if (!d) {
      d = { encounters: 0, patients: new Set() }
      byDate.set(date, d)
    }
    d.encounters++
    d.patients.add(mrn)

    // first-seen date decides new vs return
    const prev = patientFirstSeen.get(mrn)
    if (!prev || date < prev) patientFirstSeen.set(mrn, date)

    // simple counters
    if (r.referralType && r.referralType !== 'None') referrals++
    if (hasLabPositive(r)) labPositiveCount++
    if (r.sex === 'F') female++

    // Age AT THE ENCOUNTER, not today: across multi-year datasets an
    // as-of-today age silently moves patients between bands.
    const age = calcAgeAt(r.dob, r.date)
    if (age !== null) {
      ages.push(age)
      if (age < 18) pediatric++
      const band = AGE_BANDS.find(([, lo, hi]) => age >= lo && age < hi)
      if (band) {
        let b = bands.get(band[0])
        if (!b) {
          b = { male: 0, female: 0 }
          bands.set(band[0], b)
        }
        if (r.sex === 'M') b.male++
        else if (r.sex === 'F') b.female++
      }
    }

    // Split free-text diagnoses on the same separators the app writes.
    const dx = (r.diagnosis || '').trim()
    if (dx) {
      for (const part of dx.split(/[,;\n]/)) {
        const name = part.trim()
        if (name) diagnoses.set(name, (diagnoses.get(name) || 0) + 1)
      }
    } else missingDiagnosis++

    const site = (r.site || '').trim()
    const provider = (r.provider || '').trim()
    if (site) sites.set(site, (sites.get(site) || 0) + 1)
    if (provider) providers.set(provider, (providers.get(provider) || 0) + 1)
    else missingProvider++
    if (!r.temp && !r.bp && !r.weight) missingVitals++

    for (const m of r.medications || []) {
      if (m.medId) meds.set(m.medId, (meds.get(m.medId) || 0) + 1)
    }

    for (const [name, lab] of Object.entries(r.labs || {})) {
      if (!lab || !lab.ordered) continue
      // Only POS/NEG tests have a positivity rate. Numeric tests (glucose,
      // haemoglobin) were inflating the denominator and always showing 0%.
      const isNumeric = lab.type === 'numeric' || (lab.value !== undefined && lab.result === undefined)
      if (isNumeric) continue
      labTested.set(name, (labTested.get(name) || 0) + 1)
      if (String(lab.result || '').toUpperCase() === 'POS') {
        labPos.set(name, (labPos.get(name) || 0) + 1)
      }
    }
  }

  const patients = patientFirstSeen.size
  // A patient is NEW if their first-ever visit falls inside the current filter.
  // Comparing against the filtered set alone made this identical to the patient
  // count, so the KPI was meaningless under any date filter.
  const baseline = firstSeen ?? patientFirstSeen
  let newPatients = 0
  for (const [key, firstInView] of patientFirstSeen) {
    const everFirst = baseline.get(key)
    if (everFirst === undefined || everFirst >= firstInView) newPatients++
  }

  ages.sort((a, b) => a - b)
  const medianAge = ages.length
    ? ages.length % 2
      ? ages[(ages.length - 1) / 2]!
      : (ages[ages.length / 2 - 1]! + ages[ages.length / 2]!) / 2
    : null

  return {
    encounters: records.length,
    patients,
    newPatients,
    returnVisits: records.length - newPatients,
    referrals,
    labPositive: labPositiveCount,
    pediatric,
    female,
    medianAge,
    trend: [...byDate.entries()]
      .map(([date, v]) => ({ date, encounters: v.encounters, patients: v.patients.size }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    topDiagnoses: topN(diagnoses, 10),
    bySite: topN(sites, 12),
    byProvider: topN(providers, 12),
    ageBands: AGE_BANDS.map(([band]) => ({
      band,
      male: bands.get(band)?.male ?? 0,
      female: bands.get(band)?.female ?? 0,
    })),
    labStats: [...labTested.entries()]
      .map(([name, tested]) => {
        const positive = labPos.get(name) || 0
        return { name, tested, positive, rate: tested ? positive / tested : 0 }
      })
      .filter((l) => l.tested > 0)
      .sort((a, b) => b.rate - a.rate || b.tested - a.tested),
    topMedications: topN(meds, 10),
    dataQuality: { missingDiagnosis, missingVitals, missingProvider },
  }
}
