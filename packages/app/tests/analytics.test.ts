/**
 * Analytics aggregation - the metric definitions are FROZEN.
 *
 * computeAnalytics was ported from the reference single-pass implementation.
 * Orgs read reports built on these exact rules; a quietly "improved"
 * definition changes every number they have been comparing across months.
 * If one of these tests is in your way, the change is wrong, not the test.
 */
import { describe, expect, it } from 'vitest'
import {
  AGE_BANDS,
  applyAnalyticsFilters,
  calcAgeAt,
  computeAnalytics,
  EMPTY_ANALYTICS_FILTERS,
  firstSeenByPatient,
  type AnalyticsFilters,
} from '../src/lib/analytics'
import type { PatientRecord } from '../src/types/record'

// ---------------------------------------------------------------------------
// Fixture corpus helpers (fully deterministic, no Date.now / Math.random)
// ---------------------------------------------------------------------------

let seq = 0
function makeRec(over: Partial<PatientRecord> = {}): PatientRecord {
  seq++
  return {
    id: `r-${seq}`,
    deviceId: 'test-dev',
    mrn: `MRN${seq}`,
    site: 'Kabale Community Clinic',
    date: '2026-06-01',
    provider: 'Dr. A. Mensah',
    givenName: 'Pat',
    familyName: `Fam${seq}`,
    name: `Pat Fam${seq}`,
    sex: 'F',
    dob: '1990-01-01',
    phone: '',
    ageEstimated: false,
    temp: '36.8',
    bp: '120/80',
    weight: '60',
    pregnant: '',
    breastfeeding: '',
    allergies: '',
    currentMeds: '',
    pmh: '',
    chiefConcern: 'Cough',
    accessToCare: null,
    transport: '',
    travelTime: '',
    labs: {},
    labComments: '',
    urinalysis: null,
    bloodGlucose: '',
    diagnosis: 'URTI',
    diagnosisCodes: [],
    medications: [],
    treatmentNotes: '',
    treatment: '',
    procedures: [],
    imaging: null,
    surgery: null,
    referralType: 'None',
    referralDate: '',
    notes: '',
    templateId: 'general',
    templateName: 'General Encounter',
    customFields: {},
    savedAt: '2026-06-01T10:00:00.000Z',
    sync_version: 1,
    synced_version: 1,
    ...over,
  }
}

const f = (over: Partial<AnalyticsFilters> = {}): AnalyticsFilters => ({
  ...EMPTY_ANALYTICS_FILTERS,
  ...over,
})

// ---------------------------------------------------------------------------
// calcAgeAt
// ---------------------------------------------------------------------------

describe('calcAgeAt', () => {
  it('ages at the given date, honoring the birthday boundary', () => {
    expect(calcAgeAt('1990-06-15', '2020-06-15')).toBe(30)
    expect(calcAgeAt('1990-06-15', '2020-06-14')).toBe(29)
    expect(calcAgeAt('1990-06-15', '2020-07-01')).toBe(30)
    expect(calcAgeAt('1990-12-31', '2020-01-01')).toBe(29)
  })

  it('returns 0 for infants under one year', () => {
    expect(calcAgeAt('2026-01-01', '2026-06-01')).toBe(0)
  })

  it('clamps to the 0-129 window: future DOBs and absurd ages are null', () => {
    expect(calcAgeAt('2026-06-02', '2026-06-01')).toBe(null) // dob after visit
    expect(calcAgeAt('1897-01-01', '2026-06-01')).toBe(129) // oldest allowed
    expect(calcAgeAt('1896-01-01', '2026-06-01')).toBe(null) // 130 = clamped
  })

  it('is null for missing or unparseable inputs', () => {
    expect(calcAgeAt('', '2026-06-01')).toBe(null)
    expect(calcAgeAt('not-a-date', '2026-06-01')).toBe(null)
    expect(calcAgeAt('1990-06-15', 'not-a-date')).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Age bands
// ---------------------------------------------------------------------------

describe('age bands', () => {
  it('pins the seven frozen band edges', () => {
    expect(AGE_BANDS.map(([b]) => b)).toEqual(['<1', '1-4', '5-14', '15-24', '25-44', '45-64', '65+'])
  })

  it('places every inclusive-lower / exclusive-upper edge in the right band', () => {
    // date 2020-06-01, dob Jan 1 of (2020 - age): birthday already passed.
    const at = (age: number, sex: string) =>
      makeRec({ sex, date: '2020-06-01', dob: `${2020 - age}-01-01` })
    const recs = [
      at(0, 'F'), // <1
      at(1, 'M'), at(4, 'M'), // 1-4
      at(5, 'F'), at(14, 'F'), // 5-14
      at(15, 'M'), at(24, 'M'), // 15-24
      at(25, 'F'), at(44, 'F'), // 25-44
      at(45, 'M'), at(64, 'M'), // 45-64
      at(65, 'F'), at(129, 'F'), // 65+
    ]
    const a = computeAnalytics(recs)
    expect(a.ageBands).toEqual([
      { band: '<1', male: 0, female: 1 },
      { band: '1-4', male: 2, female: 0 },
      { band: '5-14', male: 0, female: 2 },
      { band: '15-24', male: 2, female: 0 },
      { band: '25-44', male: 0, female: 2 },
      { band: '45-64', male: 2, female: 0 },
      { band: '65+', male: 0, female: 2 },
    ])
  })

  it('always returns all seven bands, zero-filled, even with no data', () => {
    const a = computeAnalytics([])
    expect(a.ageBands).toHaveLength(7)
    expect(a.ageBands.every((b) => b.male === 0 && b.female === 0)).toBe(true)
  })

  it('counts an unknown sex in ages and pediatric but in neither band column', () => {
    const a = computeAnalytics([makeRec({ sex: '', date: '2020-06-01', dob: '2010-01-01' })])
    expect(a.ageBands.find((b) => b.band === '5-14')).toEqual({ band: '5-14', male: 0, female: 0 })
    expect(a.pediatric).toBe(1)
    expect(a.medianAge).toBe(10)
  })

  it('drops clamped and missing DOBs from every age metric', () => {
    const a = computeAnalytics([
      makeRec({ dob: '', date: '2020-06-01' }),
      makeRec({ dob: '2021-01-01', date: '2020-06-01' }), // future dob -> null
    ])
    expect(a.medianAge).toBe(null)
    expect(a.pediatric).toBe(0)
    expect(a.ageBands.every((b) => b.male === 0 && b.female === 0)).toBe(true)
  })

  it('ages at the ENCOUNTER date, not today: old visits keep their bands', () => {
    // Born 2000: a 2014 visit is pediatric (14, band 5-14) forever.
    const a = computeAnalytics([makeRec({ dob: '2000-01-01', date: '2014-06-01', sex: 'M' })])
    expect(a.pediatric).toBe(1)
    expect(a.ageBands.find((b) => b.band === '5-14')?.male).toBe(1)
  })

  it('pediatric is strictly under 18 at the visit', () => {
    const a = computeAnalytics([
      makeRec({ dob: '2002-01-01', date: '2019-06-01' }), // 17
      makeRec({ dob: '2001-01-01', date: '2019-06-01' }), // 18
    ])
    expect(a.pediatric).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

describe('trend', () => {
  it('groups by date with per-date unique patients, sorted ascending', () => {
    const recs = [
      makeRec({ mrn: 'P1', date: '2026-06-02' }),
      makeRec({ mrn: 'P1', date: '2026-06-01' }),
      makeRec({ mrn: 'P2', date: '2026-06-01' }),
      makeRec({ mrn: 'P1', date: '2026-06-01' }), // same patient twice that day
    ]
    expect(computeAnalytics(recs).trend).toEqual([
      { date: '2026-06-01', encounters: 3, patients: 2 },
      { date: '2026-06-02', encounters: 1, patients: 1 },
    ])
  })

  it('buckets records without a date under the empty string, first', () => {
    const recs = [makeRec({ date: '2026-06-01' }), makeRec({ date: '' })]
    const trend = computeAnalytics(recs).trend
    expect(trend[0]).toEqual({ date: '', encounters: 1, patients: 1 })
    expect(trend).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Lab positivity
// ---------------------------------------------------------------------------

describe('lab positivity', () => {
  it('computes positive/tested/rate per POS-NEG test, ordered tests only', () => {
    const recs = [
      makeRec({ labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: 'POS' } } }),
      makeRec({ labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: 'pos' } } }), // case-blind
      makeRec({ labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: 'NEG' } } }),
      makeRec({ labs: { 'Malaria RDT': { ordered: false, type: 'toggle', result: 'POS' } } }), // not ordered
      makeRec({ labs: { 'HIV Rapid Test': { ordered: true, type: 'toggle', result: 'NEG' } } }),
    ]
    const a = computeAnalytics(recs)
    expect(a.labStats).toEqual([
      { name: 'Malaria RDT', positive: 2, tested: 3, rate: 2 / 3 },
      { name: 'HIV Rapid Test', positive: 0, tested: 1, rate: 0 },
    ])
  })

  it('excludes numeric tests from the denominator (they always read 0%)', () => {
    const recs = [
      makeRec({
        labs: {
          'Blood Glucose': { ordered: true, type: 'numeric', value: '104', unit: 'mg/dL' },
          // legacy shape: no type discriminant worth trusting, value but no result
          Haemoglobin: { ordered: true, type: 'toggle', value: '12.1' },
        },
      }),
    ]
    expect(computeAnalytics(recs).labStats).toEqual([])
  })

  it('never lists a test nobody ordered', () => {
    const a = computeAnalytics([makeRec({ labs: {} }), makeRec({ labs: {} })])
    expect(a.labStats).toEqual([])
  })

  it('sorts by rate, then by volume tested', () => {
    const mk = (name: string, results: string[]) =>
      results.map((result) => makeRec({ labs: { [name]: { ordered: true, type: 'toggle' as const, result } } }))
    const recs = [
      ...mk('A', ['POS', 'NEG']), // 50% of 2
      ...mk('B', ['POS', 'POS', 'NEG', 'NEG']), // 50% of 4 -> ahead of A
      ...mk('C', ['POS']), // 100%
    ]
    expect(computeAnalytics(recs).labStats.map((l) => l.name)).toEqual(['C', 'B', 'A'])
  })

  it('labPositive KPI counts VISITS with any positive, not positive tests', () => {
    const a = computeAnalytics([
      makeRec({
        labs: {
          'Malaria RDT': { ordered: true, type: 'toggle', result: 'POS' },
          Syphilis: { ordered: true, type: 'toggle', result: 'POS' },
        },
      }),
      makeRec(),
    ])
    expect(a.labPositive).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Top-N lists
// ---------------------------------------------------------------------------

describe('top-N lists', () => {
  it('splits free-text diagnoses on comma, semicolon and newline, trimmed', () => {
    const a = computeAnalytics([
      makeRec({ diagnosis: 'Malaria, URTI; Anaemia\n Dehydration ' }),
      makeRec({ diagnosis: 'Malaria' }),
    ])
    expect(a.topDiagnoses).toEqual([
      { name: 'Malaria', value: 2 },
      { name: 'Anaemia', value: 1 },
      { name: 'Dehydration', value: 1 },
      { name: 'URTI', value: 1 },
    ])
  })

  it('breaks ties by name so record order never reorders a report', () => {
    const a = computeAnalytics([
      makeRec({ diagnosis: 'Zoster' }),
      makeRec({ diagnosis: 'Asthma' }),
    ])
    expect(a.topDiagnoses.map((d) => d.name)).toEqual(['Asthma', 'Zoster'])
  })

  it('caps diagnoses at 10 and keeps the highest counts', () => {
    const recs: PatientRecord[] = []
    for (let i = 0; i < 12; i++) {
      for (let n = 0; n <= i; n++) recs.push(makeRec({ diagnosis: `Dx${String(i).padStart(2, '0')}` }))
    }
    const top = computeAnalytics(recs).topDiagnoses
    expect(top).toHaveLength(10)
    expect(top[0]).toEqual({ name: 'Dx11', value: 12 })
    expect(top.some((d) => d.name === 'Dx00' || d.name === 'Dx01')).toBe(false)
  })

  it('counts medications by medId and skips rows without one', () => {
    const med = (medId: string) => ({ id: `m-${medId}-${seq}`, medId, dose: '', freq: '', duration: '', qty: null, qtyUnit: null })
    const a = computeAnalytics([
      makeRec({ medications: [med('abx-amox500'), med('ana-para500')] }),
      makeRec({ medications: [med('abx-amox500'), med('')] }),
    ])
    expect(a.topMedications).toEqual([
      { name: 'abx-amox500', value: 2 },
      { name: 'ana-para500', value: 1 },
    ])
  })

  it('trims site and provider names and counts blank providers as missing', () => {
    const a = computeAnalytics([
      makeRec({ site: ' Mobile Unit A ', provider: 'Dr. B' }),
      makeRec({ site: 'Mobile Unit A', provider: '  ' }),
    ])
    expect(a.bySite).toEqual([{ name: 'Mobile Unit A', value: 2 }])
    expect(a.byProvider).toEqual([{ name: 'Dr. B', value: 1 }])
    expect(a.dataQuality.missingProvider).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Totals, new vs return, median
// ---------------------------------------------------------------------------

describe('totals', () => {
  it('a patient is NEW only when their first-ever visit is inside the filter', () => {
    const all = [
      makeRec({ mrn: 'P1', date: '2026-01-10' }),
      makeRec({ mrn: 'P1', date: '2026-03-05' }),
      makeRec({ mrn: 'P2', date: '2026-03-10' }),
    ]
    const filtered = applyAnalyticsFilters(all, f({ from: '2026-03-01' }))
    const a = computeAnalytics(filtered, firstSeenByPatient(all))
    expect(a.encounters).toBe(2)
    expect(a.patients).toBe(2)
    expect(a.newPatients).toBe(1) // P2 only; P1 was first seen in January
    expect(a.returnVisits).toBe(1) // encounters - newPatients
  })

  it('without a whole-dataset baseline, every patient in view counts as new', () => {
    const recs = [makeRec({ mrn: 'P1' }), makeRec({ mrn: 'P2' })]
    expect(computeAnalytics(recs).newPatients).toBe(2)
  })

  it('falls back to the record id when the patient number is blank', () => {
    const a = computeAnalytics([makeRec({ mrn: '' }), makeRec({ mrn: '' })])
    expect(a.patients).toBe(2)
  })

  it('median age: odd, even and empty inputs', () => {
    const at = (age: number) => makeRec({ date: '2020-06-01', dob: `${2020 - age}-01-01` })
    expect(computeAnalytics([at(10), at(40), at(20)]).medianAge).toBe(20)
    expect(computeAnalytics([at(10), at(20), at(30), at(40)]).medianAge).toBe(25)
    expect(computeAnalytics([]).medianAge).toBe(null)
  })

  it('referrals count everything except None and blank', () => {
    const a = computeAnalytics([
      makeRec({ referralType: 'District hospital' }),
      makeRec({ referralType: 'None' }),
      makeRec({ referralType: '' }),
    ])
    expect(a.referrals).toBe(1)
  })

  it('counts female visits and vitals-free visits', () => {
    const a = computeAnalytics([
      makeRec({ sex: 'F' }),
      makeRec({ sex: 'M', temp: '', bp: '', weight: '' }),
      makeRec({ sex: 'F', temp: '', bp: '', weight: '55' }), // one vital present
    ])
    expect(a.female).toBe(2)
    expect(a.dataQuality.missingVitals).toBe(1)
  })

  it('missing diagnosis counts blank and whitespace-only', () => {
    const a = computeAnalytics([makeRec({ diagnosis: '' }), makeRec({ diagnosis: '   ' })])
    expect(a.dataQuality.missingDiagnosis).toBe(2)
    expect(a.topDiagnoses).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe('applyAnalyticsFilters', () => {
  const recs = [
    makeRec({ mrn: 'A', date: '2026-06-01', site: 'S1', provider: 'Dr. X', sex: 'F' }),
    makeRec({ mrn: 'B', date: '2026-06-15', site: 'S2', provider: 'Dr. Y', sex: 'M' }),
    makeRec({ mrn: 'C', date: '2026-07-01', site: 'S1', provider: 'Dr. Y', sex: 'F' }),
  ]

  it('date bounds are inclusive on both ends', () => {
    expect(applyAnalyticsFilters(recs, f({ from: '2026-06-15' })).map((r) => r.mrn)).toEqual(['B', 'C'])
    expect(applyAnalyticsFilters(recs, f({ to: '2026-06-15' })).map((r) => r.mrn)).toEqual(['A', 'B'])
    expect(
      applyAnalyticsFilters(recs, f({ from: '2026-06-01', to: '2026-06-01' })).map((r) => r.mrn),
    ).toEqual(['A'])
  })

  it('site, provider and sex each filter exactly', () => {
    expect(applyAnalyticsFilters(recs, f({ site: 'S1' })).map((r) => r.mrn)).toEqual(['A', 'C'])
    expect(applyAnalyticsFilters(recs, f({ provider: 'Dr. Y' })).map((r) => r.mrn)).toEqual(['B', 'C'])
    expect(applyAnalyticsFilters(recs, f({ sex: 'M' })).map((r) => r.mrn)).toEqual(['B'])
  })

  it('filters compose (AND) and empty filters pass everything', () => {
    expect(
      applyAnalyticsFilters(recs, f({ site: 'S1', provider: 'Dr. Y', from: '2026-06-10' })).map((r) => r.mrn),
    ).toEqual(['C'])
    expect(applyAnalyticsFilters(recs, EMPTY_ANALYTICS_FILTERS)).toHaveLength(3)
  })

  it('a record with no date survives only when no date filter is set', () => {
    const dateless = makeRec({ date: '' })
    expect(applyAnalyticsFilters([dateless], f({ from: '2026-01-01' }))).toHaveLength(0)
    expect(applyAnalyticsFilters([dateless], f())).toHaveLength(1)
  })
})

describe('firstSeenByPatient', () => {
  it('keeps the earliest date per patient number, across the whole set', () => {
    const m = firstSeenByPatient([
      makeRec({ mrn: 'P1', date: '2026-03-05' }),
      makeRec({ mrn: 'P1', date: '2026-01-10' }),
      makeRec({ mrn: 'P2', date: '2026-02-01' }),
    ])
    expect(m.get('P1')).toBe('2026-01-10')
    expect(m.get('P2')).toBe('2026-02-01')
  })

  it('keys blank patient numbers by record id', () => {
    const r = makeRec({ mrn: '', date: '2026-01-01' })
    expect(firstSeenByPatient([r]).get(r.id)).toBe('2026-01-01')
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  function corpus(): PatientRecord[] {
    const out: PatientRecord[] = []
    for (let i = 0; i < 60; i++) {
      out.push(
        makeRec({
          id: `d-${i}`,
          mrn: `P${i % 20}`,
          date: `2026-06-${String((i % 12) + 1).padStart(2, '0')}`,
          dob: `${1950 + (i % 60)}-01-01`,
          sex: i % 2 ? 'F' : 'M',
          site: `Site ${i % 3}`,
          provider: `Dr. ${i % 4}`,
          diagnosis: `Dx${i % 7}`,
          referralType: i % 5 === 0 ? 'District hospital' : 'None',
          labs:
            i % 3 === 0
              ? { 'Malaria RDT': { ordered: true, type: 'toggle', result: i % 6 === 0 ? 'POS' : 'NEG' } }
              : {},
          medications:
            i % 2 === 0
              ? [{ id: `m-${i}`, medId: `med-${i % 5}`, dose: '', freq: '', duration: '', qty: null, qtyUnit: null }]
              : [],
        }),
      )
    }
    return out
  }

  it('same records in, byte-identical analytics out', () => {
    const recs = corpus()
    expect(computeAnalytics(recs, firstSeenByPatient(recs))).toEqual(
      computeAnalytics(recs, firstSeenByPatient(recs)),
    )
  })

  it('record ORDER never changes a single metric', () => {
    const recs = corpus()
    // Fixed deterministic permutation: reverse, then interleave halves.
    const rev = [...recs].reverse()
    const shuffled: PatientRecord[] = []
    const half = Math.ceil(rev.length / 2)
    for (let i = 0; i < half; i++) {
      shuffled.push(rev[i]!)
      const j = half + i
      if (j < rev.length) shuffled.push(rev[j]!)
    }
    expect(computeAnalytics(shuffled, firstSeenByPatient(shuffled))).toEqual(
      computeAnalytics(recs, firstSeenByPatient(recs)),
    )
  })
})

// ---------------------------------------------------------------------------
// Empty corpus
// ---------------------------------------------------------------------------

describe('empty corpus', () => {
  it('returns a fully zeroed, render-safe shape', () => {
    const a = computeAnalytics([])
    expect(a.encounters).toBe(0)
    expect(a.patients).toBe(0)
    expect(a.newPatients).toBe(0)
    expect(a.returnVisits).toBe(0)
    expect(a.referrals).toBe(0)
    expect(a.labPositive).toBe(0)
    expect(a.medianAge).toBe(null)
    expect(a.trend).toEqual([])
    expect(a.topDiagnoses).toEqual([])
    expect(a.labStats).toEqual([])
    expect(a.topMedications).toEqual([])
    expect(a.dataQuality).toEqual({ missingDiagnosis: 0, missingVitals: 0, missingProvider: 0 })
  })
})
