/**
 * PARITY: the Records screen data functions vs the legacy records.js behavior.
 *
 * The legacy algorithms are re-implemented here verbatim (from
 * packages/pwa/records.js, labs.js, helpers.js) as a reference oracle. Every
 * case below either proves the ported version behaves identically, or
 * documents a DELIBERATE improvement with the reason. Anything else is drift.
 */
import { describe, expect, it } from 'vitest'
import type { PatientRecord } from '../src/types/record'
import { displayName } from '../src/types/record'
import { EMPTY_FILTERS, applyFilters, calcAge, groupByPatient, hasLabPositive } from '../src/lib/patients'

// ---------------------------------------------------------------- oracles ---

/** legacy labs.js hasLabPositiveResult(): iterates the CONFIGURED test list. */
function legacyHasLabPositive(labs: Record<string, any> | null, configuredTests: string[]): boolean {
  if (!labs) return false
  return configuredTests.some((name) => {
    const d = labs[name]
    return d && d.ordered && d.result === 'POS'
  })
}

/** legacy helpers.js calcAge(): unbounded, can return negative for a future DOB. */
function legacyCalcAge(dob: string): number | null {
  if (!dob) return null
  const d = new Date(dob)
  if (isNaN(d.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - d.getFullYear()
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--
  return age
}

/** legacy records.js search haystack: raw concatenation, undefined included. */
function legacySearchMatch(r: any, search: string): boolean {
  const fullN = r.givenName ? `${r.givenName} ${r.familyName}` : r.name
  const hay = `${fullN} ${r.mrn || ''} ${r.chiefConcern} ${r.diagnosis}`.toLowerCase()
  return hay.includes(search)
}

// ----------------------------------------------------------------- corpus ---

const rec = (o: Partial<PatientRecord>): PatientRecord => ({
  id: o.id || Math.random().toString(36).slice(2),
  deviceId: 'dev', mrn: 'AMNA12041989', site: 'Clinic A', date: '2026-08-01', provider: 'Dr. A',
  givenName: 'Amara', familyName: 'Nakato', name: 'Amara Nakato', sex: 'F', dob: '1989-04-12',
  phone: '', ageEstimated: false, temp: '', bp: '', weight: '', pregnant: '', breastfeeding: '',
  allergies: '', currentMeds: '', pmh: '', chiefConcern: '', accessToCare: null, transport: '',
  travelTime: '', labs: {}, labComments: '', urinalysis: null, bloodGlucose: '', diagnosis: '',
  diagnosisCodes: [], medications: [], treatmentNotes: '', treatment: '', procedures: [],
  imaging: null, surgery: null, referralType: 'None', referralDate: '', notes: '',
  templateId: null, templateName: '', customFields: {}, savedAt: '2026-08-01T09:00:00.000Z',
  ...o,
} as PatientRecord)

const CONFIGURED = ['Malaria RDT', 'HIV Rapid Test', 'Typhoid (Widal/RDT)']

// ------------------------------------------------------------------ tests ---

describe('lab-positive badge', () => {
  it('matches legacy for labs that are in the configured test list', () => {
    const cases = [
      { 'Malaria RDT': { ordered: true, result: 'POS', type: 'toggle' } },
      { 'Malaria RDT': { ordered: true, result: 'NEG', type: 'toggle' } },
      { 'Malaria RDT': { ordered: false, result: 'POS', type: 'toggle' } },
      { 'HIV Rapid Test': { ordered: true, result: 'POS', type: 'toggle' } },
      {},
    ]
    for (const labs of cases) {
      expect(hasLabPositive(rec({ labs: labs as never })))
        .toBe(legacyHasLabPositive(labs, CONFIGURED))
    }
  })

  it('IMPROVEMENT: still flags a positive whose lab test was later deleted from config', () => {
    // Legacy iterated the configured list, so deleting a custom test silently
    // hid an existing positive result on historical records.
    const labs = { 'Retired Custom Test': { ordered: true, result: 'POS', type: 'toggle' } }
    expect(legacyHasLabPositive(labs, CONFIGURED)).toBe(false) // legacy misses it
    expect(hasLabPositive(rec({ labs: labs as never }))).toBe(true) // we do not
  })
})

describe('age', () => {
  it('matches legacy for ordinary dates of birth', () => {
    for (const dob of ['1989-04-12', '1962-09-03', '2018-06-21', '2005-12-31']) {
      expect(calcAge(dob)).toBe(legacyCalcAge(dob))
    }
  })

  it('returns null for empty/invalid input, like legacy', () => {
    expect(calcAge('')).toBeNull()
    expect(legacyCalcAge('')).toBeNull()
    expect(calcAge('not-a-date')).toBeNull()
  })

  it('IMPROVEMENT: a future DOB yields null instead of a negative age', () => {
    const future = new Date(Date.now() + 86400000 * 400).toISOString().slice(0, 10)
    expect(legacyCalcAge(future)).toBeLessThan(0) // legacy shows e.g. "-1y"
    expect(calcAge(future)).toBeNull()
  })
})

describe('search', () => {
  const corpus = [
    rec({ givenName: 'Amara', familyName: 'Nakato', mrn: 'AMNA12041989', chiefConcern: 'Fever', diagnosis: 'Malaria' }),
    rec({ givenName: 'Joseph', familyName: 'Okello', mrn: 'JOOK03091962', chiefConcern: 'Headache', diagnosis: 'Hypertension' }),
  ]

  it('matches legacy on name, MRN, concern and diagnosis queries', () => {
    for (const q of ['amara', 'okello', 'amna', 'fever', 'malaria', 'hyperten', 'zzz']) {
      const mine = applyFilters(corpus, { ...EMPTY_FILTERS, search: q }).map((r) => r.id).sort()
      const legacy = corpus.filter((r) => legacySearchMatch(r, q)).map((r) => r.id).sort()
      expect({ q, mine }).toEqual({ q, mine: legacy })
    }
  })

  it('IMPROVEMENT: searching "undefined" no longer matches records with missing fields', () => {
    // Legacy built the haystack by raw interpolation, so a missing chiefConcern
    // literally contributed the text "undefined" and matched this query.
    const sparse = [{ ...rec({ id: 'sparse' }), chiefConcern: undefined, diagnosis: undefined } as unknown as PatientRecord]
    expect(sparse.filter((r) => legacySearchMatch(r, 'undefined'))).toHaveLength(1) // legacy bug
    expect(applyFilters(sparse, { ...EMPTY_FILTERS, search: 'undefined' })).toHaveLength(0)
  })
})

describe('patient grouping', () => {
  const visits = [
    rec({ id: 'v1', mrn: 'AMNA12041989', date: '2026-06-01', labs: { 'Malaria RDT': { ordered: true, result: 'POS', type: 'toggle' } } as never }),
    rec({ id: 'v2', mrn: 'AMNA12041989', date: '2026-08-04', pregnant: 'Yes', referralType: 'Antenatal care' }),
    rec({ id: 'v3', mrn: 'JOOK03091962', givenName: 'Joseph', familyName: 'Okello', name: 'Joseph Okello', date: '2026-07-30' }),
  ]

  it('groups encounters by MRN and orders visits newest first', () => {
    const groups = groupByPatient(visits)
    expect(groups).toHaveLength(2)
    const amara = groups.find((g) => g.mrn === 'AMNA12041989')!
    expect(amara.visitCount).toBe(2)
    expect(amara.encounters[0]!.id).toBe('v2') // newest first, as legacy sorted
    expect(amara.latest.id).toBe('v2')
  })

  it('computes badges across ALL of a patient visits, like legacy', () => {
    const amara = groupByPatient(visits).find((g) => g.mrn === 'AMNA12041989')!
    expect(amara.flags.labPositive).toBe(true) // from visit 1
    expect(amara.flags.pregnant).toBe(true) // from visit 2
    expect(amara.flags.referred).toBe(true) // from visit 2
  })

  it('falls back to record id when a record has no MRN (legacy behavior)', () => {
    const noMrn = [rec({ id: 'x1', mrn: '' })]
    expect(groupByPatient(noMrn)[0]!.mrn).toBe('x1')
  })

  it('does not treat "None" referrals as referred', () => {
    const g = groupByPatient([rec({ referralType: 'None' })])[0]!
    expect(g.flags.referred).toBe(false)
  })
})

describe('display name', () => {
  it('prefers given+family and falls back to name, like legacy', () => {
    expect(displayName({ givenName: 'Amara', familyName: 'Nakato', name: 'ignored' })).toBe('Amara Nakato')
    expect(displayName({ givenName: '', familyName: '', name: 'Legacy Only' })).toBe('Legacy Only')
    expect(displayName({ givenName: '', familyName: '', name: '' })).toBe('Unknown')
  })
})

describe('filters', () => {
  const corpus = [
    rec({ id: 'a', site: 'Clinic A', provider: 'Dr. A', date: '2026-07-01', referralType: 'None' }),
    rec({ id: 'b', site: 'Clinic B', provider: 'Dr. B', date: '2026-08-15', referralType: 'District hospital' }),
  ]

  it('filters by site, provider, referral and date range', () => {
    const ids = (f: Partial<typeof EMPTY_FILTERS>) =>
      applyFilters(corpus, { ...EMPTY_FILTERS, ...f }).map((r) => r.id)
    expect(ids({ site: 'Clinic A' })).toEqual(['a'])
    expect(ids({ provider: 'Dr. B' })).toEqual(['b'])
    expect(ids({ referral: 'District hospital' })).toEqual(['b'])
    expect(ids({ dateFrom: '2026-08-01' })).toEqual(['b'])
    expect(ids({ dateTo: '2026-07-31' })).toEqual(['a'])
    expect(ids({ dateFrom: '2026-01-01', dateTo: '2026-12-31' })).toEqual(['a', 'b'])
  })

  it('combines filters (AND), like legacy', () => {
    expect(applyFilters(corpus, { ...EMPTY_FILTERS, site: 'Clinic A', provider: 'Dr. B' })).toHaveLength(0)
  })
})
