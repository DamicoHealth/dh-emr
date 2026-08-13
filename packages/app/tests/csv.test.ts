/**
 * CSV GOLDEN TEST.
 *
 * The real legacy generateCSV() from the old app (vendored VERBATIM at
 * tests/fixtures/legacy/csv-export.js) is loaded and run side by side with
 * the TypeScript port. The output must be BYTE-IDENTICAL: orgs analyse these
 * files downstream, so a shifted or renamed column silently corrupts
 * someone's analysis.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import type { PatientRecord } from '../src/types/record'
import type { LabTest } from '../src/config/types'
import { DEFAULT_LAB_TESTS } from '../src/config/defaults/labTests'
import { UA_PARAMS } from '../src/config/defaults/lists'
import { csvEscape, generateCSV } from '../src/lib/csv'

// The repo ships no @types/node (the app is browser-only), so node builtins
// come in through an untyped dynamic import. Vitest runs tests in Node,
// where it always resolves.
const { readFileSync } = (await import('node:fs' as string)) as {
  readFileSync: (p: string, enc: 'utf8') => string
}

// The intermediate variable keeps vite's static `new URL(x, import.meta.url)`
// asset rewriting away from a plain filesystem path computation.
const metaUrl: string = import.meta.url
const LEGACY = decodeURIComponent(new URL('fixtures/legacy/csv-export.js', metaUrl).pathname)

/** The legacy exporter, captured off globalThis after the eval below. */
const legacyGen = () =>
  (globalThis as unknown as { legacyGenerateCSV?: (r: unknown[]) => string }).legacyGenerateCSV!

beforeAll(() => {
  // generateCSV() reads these as free globals; provide them exactly as
  // state.js would, then evaluate the real file and capture its function.
  const g = globalThis as unknown as Record<string, unknown>
  g.DEFAULT_LAB_TESTS = DEFAULT_LAB_TESTS
  g.UA_PARAMS = UA_PARAMS
  g.records = []
  ;(window as unknown as Record<string, unknown>).FormSchema = undefined
  const code = readFileSync(LEGACY, 'utf8')
  ;(0, eval)(code + '\n;globalThis.legacyGenerateCSV = generateCSV;')
})

const rec = (o: Partial<PatientRecord>): PatientRecord => ({
  id: 'r1', deviceId: 'dev', mrn: 'AMNA12041989', site: 'Clinic A', date: '2026-08-01',
  provider: 'Dr. A', givenName: 'Amara', familyName: 'Nakato', name: 'Amara Nakato',
  sex: 'F', dob: '1989-04-12', phone: '0700', ageEstimated: false,
  temp: '38.9', bp: '118/76', weight: '58', pregnant: 'Yes', breastfeeding: '',
  allergies: 'NKDA', currentMeds: '', pmh: '', chiefConcern: 'Fever',
  accessToCare: null, transport: '', travelTime: '',
  labs: {}, labComments: '', urinalysis: null, bloodGlucose: '',
  diagnosis: 'Malaria', diagnosisCodes: [], medications: [], treatmentNotes: '',
  treatment: '', procedures: [], imaging: null, surgery: null,
  referralType: 'None', referralDate: '', notes: '',
  templateId: null, templateName: '', customFields: {},
  savedAt: '2026-08-01T09:00:00.000Z',
  ...o,
})

const CORPUS: PatientRecord[] = [
  rec({}),
  rec({
    id: 'r2', date: '2026-08-04', mrn: 'AMNA12041989', // same patient, 2nd visit
    labs: {
      'Malaria RDT': { ordered: true, result: 'POS', type: 'toggle' },
      'Blood Glucose': { ordered: true, type: 'numeric', value: '268', unit: 'mg/dL', interpretation: 'High' },
    },
    urinalysis: { protein: 'Trace', nitrite: 'POS' },
    bloodGlucose: '268',
    diagnosisCodes: [{ code: 'B54', term: 'Malaria' }],
    procedures: ['Wound suturing', 'I&D'],
    treatment: 'AL 80/480 BID x 3 days',
    referralType: 'District hospital',
    templateName: 'General Encounter',
    notes: 'needs, a comma and "quotes"',
  }),
  rec({
    id: 'r3', mrn: 'JOOK03091962', givenName: '', familyName: '', name: 'Joseph Okello',
    sex: 'M', dob: '1962-09-03', ageEstimated: true, date: '2026-07-30',
    diagnosis: '=SUM(A1:A9)', // formula-injection probe
  }),
]

describe('CSV parity with the legacy exporter', () => {
  it('produces byte-identical output for the same records', () => {
    const legacy = legacyGen()(CORPUS as unknown[])
    const ported = generateCSV(CORPUS)
    expect(ported).toBe(legacy)
  })

  it('keeps the exact legacy header, in order', () => {
    const legacyHeader = legacyGen()(CORPUS as unknown[]).split('\n')[0]
    expect(generateCSV(CORPUS).split('\n')[0]).toBe(legacyHeader)
  })

  it('numbers encounters per patient in date order', () => {
    const rows = generateCSV(CORPUS).split('\n')
    const encNumOf = (id: string) => {
      const idx = CORPUS.findIndex((r) => r.id === id)
      return rows[idx + 1]!.split(',')[1]
    }
    expect(encNumOf('r1')).toBe('1') // 2026-08-01
    expect(encNumOf('r2')).toBe('2') // 2026-08-04, same MRN
    expect(encNumOf('r3')).toBe('1') // different patient
  })
})

describe('formula injection', () => {
  it('neutralises cells that Excel would execute', () => {
    for (const bad of ['=SUM(A1)', '+1+1', '-2+3', '@SUM(A1)']) {
      expect(csvEscape(bad).startsWith("'")).toBe(true)
    }
    expect(csvEscape('Malaria')).toBe('Malaria')
  })

  it('still quotes commas, quotes and newlines correctly', () => {
    expect(csvEscape('a,b')).toBe('"a,b"')
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""')
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"')
  })
})

describe('custom columns', () => {
  const customLab: LabTest = { id: 'dengue_rdt', name: 'Dengue RDT', type: 'toggle' }
  const withCustom = [rec({
    id: 'r4',
    labs: { 'Dengue RDT': { ordered: true, result: 'POS', type: 'toggle' } },
    customFields: { f_pain: '7', f_tags: ['a', 'b'] },
  })]

  it('IMPROVEMENT: exports org-defined lab tests, which legacy dropped entirely', () => {
    const legacy = legacyGen()(withCustom as unknown[])
    expect(legacy).not.toContain('Dengue') // legacy loses the data

    const csv = generateCSV(withCustom, { customLabTests: [customLab] })
    expect(csv).toContain('Lab_DengueRDT_Ordered')
    expect(csv).toContain('Lab_DengueRDT_Result')
    expect(csv.split('\n')[1]).toContain('POS')
  })

  it('appends custom columns AFTER the legacy ones so positions never shift', () => {
    const base = generateCSV(withCustom).split('\n')[0]!.split(',')
    const extended = generateCSV(withCustom, {
      customLabTests: [customLab],
      customFields: [{ id: 'f_pain', label: 'Pain score' }],
    }).split('\n')[0]!.split(',')
    expect(extended.slice(0, base.length)).toEqual(base)
  })

  it('joins multi-select custom answers with semicolons', () => {
    const csv = generateCSV(withCustom, { customFields: [{ id: 'f_tags', label: 'Tags' }] })
    expect(csv.split('\n')[1]).toContain('a; b')
  })
})
