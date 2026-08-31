/**
 * The lab reference-range editor (REBUILD-HANDOFF 6.2).
 *
 * Rules under test, each one from the spec:
 *  - Ranges [{label, min?, max?, color}] drive the interpretation snapshotted
 *    at ENTRY time. Editing ranges later never rewrites recorded results: the
 *    record keeps its own copy (the pinned test drives the real kernel).
 *  - min is INCLUSIVE, max EXCLUSIVE, first match wins, open bounds allowed.
 *  - Overlapping or gapped ranges WARN, never block.
 *  - Persistence goes through setLabTests with the whole CustomLabTest rows,
 *    re-reading the stored list as its base (replace semantics on a
 *    never-customized org; a staged-only test id is refused).
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, records } from '../src/kernel'
import { getConfig, setLabTests } from '../src/config/keys'
import { DEFAULT_LAB_TESTS } from '../src/config/defaults'
import { interpretLab, snapshotNumericLab } from '../src/config/labInterpret'
import type { CustomLabTest, LabRange } from '../src/config/types'
import type { PatientRecord } from '../src/types/record'
import RangeEditor from '../src/ui/labs/RangeEditor'
import {
  RANGES_SNAPSHOT_NOTE,
  RANGE_COLORS,
  UNSAVED_TEST_REASON,
  addRange,
  cleanRanges,
  draftWarnings,
  moveRange,
  rangeWarnings,
  removeRange,
  saveTestRanges,
  swatchColor,
  toDrafts,
  updateRange,
  withRanges,
  type RangeDraft,
} from '../src/ui/labs/rangesModel'

const h = React.createElement

// jsdom has no scrollTo; the shared scroll lock calls it on dialog unmount.
window.scrollTo = () => {}

beforeEach(async () => {
  await resetStorage()
  await config.remove('customLabTests')
  records.invalidate()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const GLUCOSE_RANGES: LabRange[] = [
  { label: 'Low', max: 70, color: 'var(--amber)' },
  { label: 'Normal', min: 70, max: 140, color: 'var(--green)' },
  { label: 'Elevated', min: 140, max: 200, color: 'var(--amber)' },
  { label: 'High', min: 200, color: 'var(--red)' },
]

function glucoseTest(over: Partial<CustomLabTest> = {}): CustomLabTest {
  return {
    id: 'blood_glucose',
    name: 'Blood Glucose',
    type: 'numeric',
    unit: 'mg/dL',
    enabledByDefault: true,
    ranges: GLUCOSE_RANGES.map((r) => ({ ...r })),
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Draft CRUD and ordering
// ---------------------------------------------------------------------------

describe('range draft CRUD', () => {
  it('round-trips stored ranges through drafts and back byte-identically', () => {
    const drafts = toDrafts(GLUCOSE_RANGES)
    expect(drafts).toHaveLength(4)
    expect(drafts[0]?.min).toBe('') // open bound renders as an empty buffer
    expect(drafts[0]?.max).toBe('70')
    expect(cleanRanges(drafts)).toEqual(GLUCOSE_RANGES)
  })

  it('adds an empty draft at the end and never mutates its input', () => {
    const before = toDrafts(GLUCOSE_RANGES)
    const frozen = JSON.parse(JSON.stringify(before)) as RangeDraft[]
    const after = addRange(before)
    expect(after).toHaveLength(5)
    expect(after[4]).toMatchObject({ label: '', min: '', max: '', color: '' })
    expect(JSON.parse(JSON.stringify(before))).toEqual(frozen)
  })

  it('updates only the targeted draft and removes by key', () => {
    const drafts = toDrafts(GLUCOSE_RANGES)
    const key = drafts[1]?.key ?? ''
    const updated = updateRange(drafts, key, { label: 'Fine', max: '141' })
    expect(updated[1]).toMatchObject({ label: 'Fine', min: '70', max: '141' })
    expect(updated[0]?.label).toBe('Low')
    const removed = removeRange(updated, key)
    expect(removed.map((d) => d.label)).toEqual(['Low', 'Elevated', 'High'])
  })

  it('moves a range up and down, refusing to move past the ends', () => {
    const drafts = toDrafts(GLUCOSE_RANGES)
    const first = drafts[0]?.key ?? ''
    const second = drafts[1]?.key ?? ''
    expect(moveRange(drafts, first, -1)).toBeNull()
    const down = moveRange(drafts, first, 1)
    expect(down?.map((d) => d.label)).toEqual(['Normal', 'Low', 'Elevated', 'High'])
    // Order is what interpretation matching runs on: first match wins.
    const up = moveRange(drafts, second, -1)
    expect(up?.map((d) => d.label)).toEqual(['Normal', 'Low', 'Elevated', 'High'])
    const last = drafts[3]?.key ?? ''
    expect(moveRange(drafts, last, 1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Persist shape
// ---------------------------------------------------------------------------

describe('cleanRanges persist shape', () => {
  it('parses bounds to numbers and OMITS open bounds instead of storing undefined', () => {
    const added = addRange(toDrafts([]))
    const one = updateRange(added, added[0]?.key ?? '', { label: 'High', min: '200' })
    const cleaned = cleanRanges(one)
    expect(cleaned).toEqual([{ label: 'High', min: 200 }])
    // The stored shape labInterpret matches on: absent keys, not undefined values.
    expect(Object.keys(cleaned[0] ?? {})).toEqual(['label', 'min'])
  })

  it('trims labels, keeps colors and order, and drops fully empty rows', () => {
    let drafts = toDrafts(GLUCOSE_RANGES)
    drafts = addRange(drafts) // a blank line the admin never filled in
    const cleaned = cleanRanges(
      drafts.map((d, i) => (i === 0 ? { ...d, label: '  Low  ' } : d)),
    )
    expect(cleaned).toEqual(GLUCOSE_RANGES)
  })

  it('treats a non-numeric bound as open and warns about it', () => {
    const drafts: RangeDraft[] = [
      { key: 'a', label: 'Severe', min: '', max: '7O', color: '' }, // letter O, not zero
    ]
    expect(cleanRanges(drafts)).toEqual([{ label: 'Severe' }])
    const warnings = draftWarnings(drafts)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"7O" is not a number')
  })
})

// ---------------------------------------------------------------------------
// Warnings: overlap and gaps warn, never block
// ---------------------------------------------------------------------------

describe('rangeWarnings', () => {
  it('is quiet for a clean contiguous set (the built-in glucose bands)', () => {
    expect(rangeWarnings(GLUCOSE_RANGES)).toEqual([])
  })

  it('flags an overlap and says the FIRST range wins there', () => {
    const warnings = rangeWarnings([
      { label: 'Normal', min: 70, max: 150 },
      { label: 'Elevated', min: 140, max: 200 },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('"Normal" and "Elevated" overlap')
    expect(warnings[0]).toContain('records "Normal"')
  })

  it('flags an interior gap where results record no interpretation', () => {
    const warnings = rangeWarnings([
      { label: 'Low', max: 70 },
      { label: 'High', min: 200 },
    ])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('from 70 up to 200')
    expect(warnings[0]).toContain('no interpretation')
  })

  it('flags a range that can never match and a blank label', () => {
    const warnings = rangeWarnings([
      { label: 'Backwards', min: 10, max: 5 },
      { label: '', min: 5, max: 10 },
    ])
    expect(warnings.some((w) => w.includes('"Backwards" can never match'))).toBe(true)
    expect(warnings.some((w) => w.includes('has no label'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

describe('color palette', () => {
  it('stores the legacy token spellings so lists stay compatible', () => {
    expect(RANGE_COLORS.map((c) => c.value)).toContain('var(--green)')
    expect(RANGE_COLORS.map((c) => c.value)).toContain('var(--amber)')
    expect(RANGE_COLORS.map((c) => c.value)).toContain('var(--red)')
  })

  it('paints palette tokens accessibly and passes foreign plain colors through', () => {
    expect(swatchColor('var(--green)')).toBe('#1e7d34')
    expect(swatchColor('#123456')).toBe('#123456') // another client's color survives
    expect(swatchColor('var(--mystery)')).toBe('#4a5568') // undefined var never paints as nothing
    expect(swatchColor(undefined)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Persistence through setLabTests
// ---------------------------------------------------------------------------

describe('saveTestRanges', () => {
  it('on a never-customized org, writes the whole built-in panel with the patch applied', async () => {
    const edited: LabRange[] = [
      { label: 'Low', max: 80, color: 'var(--amber)' },
      { label: 'Normal', min: 80, color: 'var(--green)' },
    ]
    const r = await saveTestRanges(config, { id: 'blood_glucose', name: 'Blood Glucose' }, edited)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('visits already saved keep the interpretation recorded at the time')
    const stored = await getConfig(config, 'customLabTests')
    expect(stored).toHaveLength(DEFAULT_LAB_TESTS.length)
    expect(stored?.find((t) => t.id === 'blood_glucose')?.ranges).toEqual(edited)
    // Every other built-in row is carried over untouched.
    expect(stored?.find((t) => t.id === 'hemoglobin')?.ranges).toEqual(
      DEFAULT_LAB_TESTS.find((t) => t.id === 'hemoglobin')?.ranges,
    )
  })

  it('on an org with its own list, patches only the one test', async () => {
    const other: CustomLabTest = { id: 'lab-xyz', name: 'CRP', type: 'numeric', unit: 'mg/L' }
    await setLabTests(config, [glucoseTest(), other])
    const edited: LabRange[] = [{ label: 'High', min: 300 }]
    const r = await saveTestRanges(config, { id: 'blood_glucose', name: 'Blood Glucose' }, edited)
    expect(r.ok).toBe(true)
    const stored = await getConfig(config, 'customLabTests')
    expect(stored?.map((t) => t.id)).toEqual(['blood_glucose', 'lab-xyz'])
    expect(stored?.[0]?.ranges).toEqual(edited)
    expect(stored?.[1]).toEqual(other)
  })

  it('refuses a test id that is not in the stored list, and writes nothing', async () => {
    await setLabTests(config, [glucoseTest()])
    const r = await saveTestRanges(config, { id: 'lab-unsaved', name: 'New Test' }, [
      { label: 'High', min: 1 },
    ])
    expect(r.ok).toBe(false)
    expect(r.message).toBe(UNSAVED_TEST_REASON)
    const stored = await getConfig(config, 'customLabTests')
    expect(stored).toEqual([glucoseTest()])
  })

  it('removes the ranges key entirely when saving an empty list', async () => {
    await setLabTests(config, [glucoseTest()])
    const r = await saveTestRanges(config, { id: 'blood_glucose', name: 'Blood Glucose' }, [])
    expect(r.ok).toBe(true)
    const stored = await getConfig(config, 'customLabTests')
    expect(stored?.[0]).toBeDefined()
    expect(stored?.[0] && 'ranges' in stored[0]).toBe(false)
  })

  it('withRanges never mutates the test it copies', () => {
    const test = glucoseTest()
    const stripped = withRanges(test, [])
    expect('ranges' in stripped).toBe(false)
    expect(test.ranges).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// THE PINNED RULE: editing ranges never rewrites a recorded interpretation
// ---------------------------------------------------------------------------

function makeRecord(over: Record<string, unknown> = {}): PatientRecord {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`,
    site: 'Clinic A', date: '2026-08-01', mrn: 'TEPA01011990',
    givenName: 'Test', familyName: 'Patient', name: 'Test Patient',
    sex: 'F', dob: '1990-01-01', phone: '',
    temp: '37.0', bp: '120/80', weight: '60',
    allergies: '', currentMeds: '', pmh: '', chiefConcern: 'Follow up',
    labs: {}, urinalysis: null, accessToCare: null,
    diagnosis: '', diagnosisCodes: [], medications: [], procedures: [],
    imaging: null, surgery: null, referralType: 'None', referralDate: '',
    provider: 'Dr. A', notes: '', ageEstimated: false, bloodGlucose: '',
    templateId: null, templateName: '', customFields: {},
    treatmentNotes: '', treatment: '', transport: '', travelTime: '', labComments: '',
    ...over,
  } as unknown as PatientRecord
}

describe('snapshot semantics through the kernel', () => {
  it('a saved visit keeps its entry-time interpretation after the ranges change', async () => {
    // The org's panel at entry time: 150 mg/dL reads "Elevated".
    await setLabTests(config, [glucoseTest()])
    const atEntry = (await getConfig(config, 'customLabTests'))?.find(
      (t) => t.id === 'blood_glucose',
    )
    expect(atEntry).toBeDefined()
    const entry = snapshotNumericLab(atEntry as CustomLabTest, '150')
    expect(entry.interpretation).toBe('Elevated')

    const rec = makeRecord({ labs: { 'Blood Glucose': entry }, bloodGlucose: '150' })
    await records.save(rec)

    // An admin later tightens the bands: 150 now reads "High".
    const edited: LabRange[] = [
      { label: 'Normal', min: 70, max: 130, color: 'var(--green)' },
      { label: 'High', min: 130, color: 'var(--red)' },
    ]
    const r = await saveTestRanges(config, { id: 'blood_glucose', name: 'Blood Glucose' }, edited)
    expect(r.ok).toBe(true)

    // The stored record is untouched: it keeps its own copy forever.
    const [saved] = await records.getActive()
    expect(saved?.labs['Blood Glucose']?.interpretation).toBe('Elevated')
    expect(saved?.labs['Blood Glucose']?.value).toBe('150')
    expect(saved?.labs['Blood Glucose']?.unit).toBe('mg/dL')

    // Only NEW results use the new ranges.
    const after = (await getConfig(config, 'customLabTests'))?.find(
      (t) => t.id === 'blood_glucose',
    )
    expect(snapshotNumericLab(after as CustomLabTest, '150').interpretation).toBe('High')
    expect(interpretLab('150', after?.ranges)).toBe('High')
  })
})

// ---------------------------------------------------------------------------
// Editor component: the snapshot note, gating, and what Save hands over
// ---------------------------------------------------------------------------

describe('RangeEditor component', () => {
  it('states prominently that editing affects new results only', () => {
    render(
      h(RangeEditor, {
        test: glucoseTest(),
        isAdmin: true,
        onClose: () => {},
        onSave: async () => ({ ok: true, message: 'ok' }),
      }),
    )
    expect(screen.getByText('Changing ranges affects new results only.')).toBeTruthy()
    expect(screen.getByText(RANGES_SNAPSHOT_NOTE)).toBeTruthy()
  })

  it('opens read-only on a standard device: controls disabled with the reason shown', () => {
    render(
      h(RangeEditor, {
        test: glucoseTest(),
        isAdmin: false,
        onClose: () => {},
        onSave: async () => ({ ok: true, message: 'ok' }),
      }),
    )
    expect(screen.getByText('Read only')).toBeTruthy()
    const label = screen.getByLabelText('Range 1 label') as HTMLInputElement
    expect(label.disabled).toBe(true)
    expect(label.title).toContain('Only an admin device')
    expect((screen.getByText('Save ranges') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hands Save the CLEANED ranges in stored shape and closes on success', async () => {
    const onSave = vi.fn(async (_ranges: LabRange[]) => ({ ok: true, message: 'ok' }))
    const onClose = vi.fn()
    render(
      h(RangeEditor, {
        test: glucoseTest({ ranges: [{ label: 'High', min: 200, color: 'var(--red)' }] }),
        isAdmin: true,
        onClose,
        onSave,
      }),
    )
    fireEvent.change(screen.getByLabelText('Range 1 up to'), { target: { value: '400' } })
    fireEvent.click(screen.getByText('Save ranges'))
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith([
      { label: 'High', min: 200, max: 400, color: 'var(--red)' },
    ])
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
  })

  it('warns about an overlap in the editor but still allows the save', async () => {
    const onSave = vi.fn(async (_ranges: LabRange[]) => ({ ok: true, message: 'ok' }))
    render(
      h(RangeEditor, {
        test: glucoseTest({
          ranges: [
            { label: 'Normal', min: 70, max: 150 },
            { label: 'Elevated', min: 140, max: 200 },
          ],
        }),
        isAdmin: true,
        onClose: () => {},
        onSave,
      }),
    )
    expect(screen.getByText(/"Normal" and "Elevated" overlap/)).toBeTruthy()
    const save = screen.getByText('Save ranges') as HTMLButtonElement
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
  })

  it('previews exactly what a value would record, through the real snapshot path', () => {
    render(
      h(RangeEditor, {
        test: glucoseTest(),
        isAdmin: true,
        onClose: () => {},
        onSave: async () => ({ ok: true, message: 'ok' }),
      }),
    )
    const tryBox = screen.getByPlaceholderText('mg/dL')
    fireEvent.change(tryBox, { target: { value: '150' } })
    expect(screen.getByText('Elevated')).toBeTruthy()
    // Snapshot semantics in miniature: what the preview shows is what
    // snapshotNumericLab would store on the visit.
    expect(snapshotNumericLab(glucoseTest(), '150')).toMatchObject({
      value: '150',
      unit: 'mg/dL',
      interpretation: 'Elevated',
    })
  })
})
