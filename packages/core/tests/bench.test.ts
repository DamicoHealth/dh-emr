/**
 * SCALE BENCH - not a pass/fail test, a measurement.
 *
 * The org holds ~886 records today and grows toward 5,000-10,000 on older
 * iPads. This exercises the real kernel hot paths at that size and prints
 * timings. Run with: npx vitest run tests/bench.test.ts
 *
 * Thresholds are deliberately generous - they only fail if something is
 * catastrophically slow, so this never becomes a flaky gate. Read the
 * numbers. computeAnalytics is back (single-pass, see src/lib/analytics)
 * with its 3000ms-at-10k ceiling; the remaining record-list helpers
 * (groupByPatient timing, generateCSV, the encounter serializer) still have
 * no measured rows here. The kernel ops below keep the corpus, the sizes
 * and the one hard durability check (a cold read of a 5,000-record store
 * returns exactly 5,000).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { resetStorage } from './setup'
import { records } from '../src/kernel'
import { computeAnalytics, firstSeenByPatient } from '../src/lib/analytics'
import type { PatientRecord } from '../src/types/record'

const SIZES = [1000, 5000, 10000]
const GIVEN = ['Amara', 'Joseph', 'Grace', 'Samuel', 'Miriam', 'Daniel', 'Esther', 'Peter']
const FAMILY = ['Nakato', 'Okello', 'Auma', 'Ochieng', 'Adeke', 'Kirya', 'Nabirye', 'Wanyama']
const DX = ['Malaria', 'Upper respiratory infection', 'Hypertension', 'UTI', 'Gastritis', 'Anaemia']
const SITES = ['Kabale Community Clinic', 'Rukungiri Outreach', 'Mobile Unit A']

function makeCorpus(n: number): PatientRecord[] {
  const out: PatientRecord[] = []
  for (let i = 0; i < n; i++) {
    const g = GIVEN[i % GIVEN.length]!
    const f = FAMILY[(i * 3) % FAMILY.length]!
    const p = i % Math.max(1, Math.floor(n * 0.65)) // ~1.5 visits/patient
    const yr = 1950 + (p % 70), mo = 1 + (p % 12), da = 1 + (p % 28)
    const dob = `${yr}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`
    const d = new Date(2026, 0, 1 + (i % 220)).toISOString().slice(0, 10)
    out.push({
      id: `b-${i}`, deviceId: 'bench',
      mrn: (g.slice(0, 2) + f.slice(0, 2)).toUpperCase() + String(da).padStart(2, '0') + String(mo).padStart(2, '0') + yr,
      site: SITES[i % SITES.length]!, date: d, provider: 'Dr. A. Mensah',
      givenName: g, familyName: f, name: `${g} ${f}`, sex: i % 2 ? 'F' : 'M', dob,
      phone: '070000' + (i % 1000), ageEstimated: false,
      temp: (36 + (i % 40) / 10).toFixed(1), bp: `${110 + (i % 50)}/${70 + (i % 25)}`,
      weight: String(45 + (i % 45)), pregnant: i % 11 === 0 ? 'Yes' : '', breastfeeding: '',
      allergies: 'NKDA', currentMeds: '', pmh: '', chiefConcern: DX[i % DX.length]! + ' symptoms',
      accessToCare: null, transport: '', travelTime: '',
      labs: i % 3 === 0 ? { 'Malaria RDT': { ordered: true, result: i % 9 === 0 ? 'POS' : 'NEG', type: 'toggle' } } : {},
      labComments: '', urinalysis: null, bloodGlucose: '',
      diagnosis: DX[i % DX.length]!, diagnosisCodes: [],
      medications: i % 2 === 0
        ? [{ id: 'm' + i, medId: 'abx-amox500', dose: '500mg', freq: 'q8h', duration: '5d', qty: 15, qtyUnit: 'caps' }]
        : [],
      treatmentNotes: '', treatment: '', procedures: [], imaging: null, surgery: null,
      referralType: i % 13 === 0 ? 'District hospital' : 'None', referralDate: '', notes: '',
      templateId: 'general', templateName: 'General Encounter', customFields: {},
      savedAt: new Date(2026, 0, 1 + (i % 220)).toISOString(),
      sync_version: 1, synced_version: 1,
    })
  }
  return out
}

const ms = (fn: () => unknown, runs = 5): number => {
  fn() // warm
  const t = performance.now()
  for (let i = 0; i < runs; i++) fn()
  return (performance.now() - t) / runs
}

const report: string[] = []
const row = (label: string, n: number, v: number, unit = 'ms') =>
  report.push(`  ${label.padEnd(34)} n=${String(n).padStart(6)}  ${v.toFixed(1).padStart(8)} ${unit}`)

/** Seed the store through the kernel's own sync-engine entry point. */
async function seed(corpus: PatientRecord[]): Promise<void> {
  await records.mutate((all) => {
    for (const r of corpus) all.push(r)
    return { changed: corpus, result: null }
  })
}

beforeAll(async () => { await resetStorage() })

describe('scale bench', () => {
  it('measures the pure hot paths', () => {
    report.push('\n=== PURE COMPUTE (per call, avg of 5) ===')
    for (const n of SIZES) {
      const corpus = makeCorpus(n)
      // The MRN lookup runs on EVERY keystroke of a name or the DOB.
      row('MRN scan per keystroke', n, ms(() => {
        const base = 'AMNA01011990'
        corpus.filter((r) => !r.deleted && (r.mrn || '').replace(/[A-Z]$/, '') === base)
      }, 20))
      // Full Analytics-tab recompute, including the new-vs-return baseline.
      const analyticsMs = ms(() => computeAnalytics(corpus, firstSeenByPatient(corpus)))
      row('computeAnalytics (single pass)', n, analyticsMs)
      // The only hard ceiling in this block: the single-pass rewrite exists
      // because the legacy ~50-pass version froze old iPads at this size.
      if (n === 10000) expect(analyticsMs).toBeLessThan(3000)
      const bytes = new Blob([JSON.stringify(corpus)]).size
      row('payload size', n, bytes / 1048576, 'MB')
      report.push('')
    }
  }, 120_000)

  it('measures bulk seed + a single-record save through the real kernel at each size', async () => {
    report.push('=== SAVE ONE RECORD (per-record put, not a whole-blob rewrite) ===')
    for (const n of SIZES) {
      await resetStorage()
      const corpus = makeCorpus(n)
      let t = performance.now()
      await seed(corpus)
      row('bulk seed via mutate', n, performance.now() - t)
      const one = { ...corpus[0]!, id: 'bench-new', diagnosis: 'Bench save' }
      t = performance.now()
      await records.save(one)
      row('saveRecord (1 patient)', n, performance.now() - t)
    }
    report.push('')
  }, 300_000)

  it('measures a cold read and a Save & Next burst', async () => {
    report.push('=== READ + BURST ===')
    await resetStorage()
    const corpus = makeCorpus(5000)
    await seed(corpus)

    records.invalidate()
    let t = performance.now()
    const back = await records.getAll()
    const cold = performance.now() - t
    row('cold getAll (cache invalidated)', 5000, cold)
    // The one hard durability check in this file: nothing dropped at scale.
    expect(back.length).toBe(5000)
    // Generous ceiling: only a catastrophe fails (kernel-op stand-in for the
    // old groupByPatient/computeAnalytics ceilings).
    expect(cold).toBeLessThan(3000)

    t = performance.now()
    for (let i = 0; i < 10; i++) {
      await records.save({ ...corpus[0]!, id: `burst-${i}`, givenName: `Burst${i}` })
    }
    const burst = performance.now() - t
    row('Save & Next x10 (total)', 5000, burst)
    row('  -> per patient', 5000, burst / 10)
    report.push('')
    // eslint-disable-next-line no-console
    console.log(report.join('\n'))
  }, 300_000)
})
