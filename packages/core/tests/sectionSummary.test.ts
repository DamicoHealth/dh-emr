/**
 * Compact summaries of view-only sections (src/ui/encounter/sectionSummary.ts).
 * Pure: form state in, label/value lines out.
 */
import { describe, expect, it } from 'vitest'
import { emptyFormState } from '../src/ui/encounter/formState'
import { labResult, summarizeSection } from '../src/ui/encounter/sectionSummary'

const builtin = (id: string) => ({ id, builtin: true as const, fields: [] })
const ctx = { formulary: [{ id: 'med-a', name: 'Amoxicillin 500 mg' }], age: 36 }

describe('section summaries (view-only sections in role mode)', () => {
  it('patient: name, sex, date of birth with age, phone, patient number; blanks skipped', () => {
    const st = {
      ...emptyFormState(),
      givenName: 'Grace',
      familyName: 'Auma',
      sex: 'F',
      dobText: '20/02/1996',
      dobIso: '1996-02-20',
      mrn: 'GRAU20021996',
    }
    expect(summarizeSection(builtin('patient'), st, ctx)).toEqual([
      { label: 'Name', value: 'Grace Auma' },
      { label: 'Sex', value: 'F' },
      { label: 'Date of birth', value: '20/02/1996 (36 y)' },
      { label: 'Patient number', value: 'GRAU20021996' },
    ])
  })

  it('an estimated age reads as an estimate', () => {
    const st = { ...emptyFormState(), givenName: 'A', familyName: 'B', dobUnknown: true, ageEstimate: '40' }
    expect(summarizeSection(builtin('patient'), st, { ...ctx, age: 40 })).toContainEqual({
      label: 'Age',
      value: 'about 40 y (estimated)',
    })
  })

  it('vitals carry their units; blanks are skipped', () => {
    const st = { ...emptyFormState(), temp: '38.4', bp: '', weight: '12', pregnant: '' }
    expect(summarizeSection(builtin('vitals'), st, ctx)).toEqual([
      { label: 'Temperature', value: '38.4 °C' },
      { label: 'Weight', value: '12 kg' },
    ])
  })

  it('labs: results, numeric with unit and interpretation, awaiting, never-ordered skipped, urinalysis and comments', () => {
    const st = {
      ...emptyFormState(),
      labs: {
        'Malaria RDT': { kind: 'toggle' as const, ordered: true, result: 'POS' },
        Hemoglobin: { kind: 'numeric' as const, ordered: true, value: '9.1', unit: 'g/dL', interpretation: 'low' },
        HIV: { kind: 'toggle' as const, ordered: true, result: '' },
        Glucose: { kind: 'numeric' as const, ordered: false, value: '', unit: '', interpretation: '' },
      },
      urinalysis: { protein: '+', glucose: '' },
      labComments: 'repeat in a week',
    }
    const lines = summarizeSection(builtin('labs'), st, ctx)
    expect(lines).toEqual([
      { label: 'Malaria RDT', value: 'POS' },
      { label: 'Hemoglobin', value: '9.1 g/dL (low)' },
      { label: 'HIV', value: 'Awaiting result' },
      { label: 'Urinalysis', value: 'protein +' },
      { label: 'Lab comments', value: 'repeat in a week' },
    ])
    expect(labResult(null)).toBe('')
    expect(labResult({ kind: 'toggle', ordered: false, result: 'NEG' })).toBe('NEG') // a legacy result still shows
  })

  it('medications name the drug from the formulary and join dose, frequency and duration', () => {
    const st = {
      ...emptyFormState(),
      medications: [
        { id: 'l1', medId: 'med-a', dose: '500 mg', freq: 'q8h', duration: '7 d' },
        { id: 'l2', medId: 'unknown-id', dose: '', freq: '', duration: '' },
      ],
      treatmentNotes: 'with food',
    }
    expect(summarizeSection(builtin('medications'), st, ctx)).toEqual([
      { label: 'Amoxicillin 500 mg', value: '500 mg · q8h · 7 d' },
      { label: 'unknown-id', value: 'prescribed' },
      { label: 'Treatment notes', value: 'with food' },
    ])
  })

  it('referral None is not a referral; surgery only when performed; diagnosis codes join', () => {
    const base = emptyFormState()
    expect(summarizeSection(builtin('referral'), { ...base, referralType: 'None' }, ctx)).toEqual([])
    expect(
      summarizeSection(builtin('referral'), { ...base, referralType: 'Hospital', referralDate: '2026-10-08' }, ctx),
    ).toEqual([{ label: 'Referral', value: 'Hospital · 2026-10-08' }])
    expect(summarizeSection(builtin('surgery'), { ...base, surgeryType: 'I&D' }, ctx)).toEqual([])
    expect(summarizeSection(builtin('surgery'), { ...base, surgeryPerformed: true, surgeryType: 'I&D' }, ctx)).toEqual([
      { label: 'Surgery', value: 'I&D' },
    ])
    expect(
      summarizeSection(
        builtin('diagnosis'),
        { ...base, diagnosis: 'Malaria', diagnosisCodes: [{ code: 'B54', term: 'Malaria, unspecified' }, { code: 'R50' }] },
        ctx,
      ),
    ).toEqual([
      { label: 'Diagnosis', value: 'Malaria' },
      { label: 'Codes', value: 'B54 Malaria, unspecified, R50' },
    ])
  })

  it('custom sections list answered fields only, arrays joined', () => {
    const sec = {
      id: 's1',
      builtin: false as const,
      fields: [
        { id: 'f1', label: 'Bed net at home', type: 'yesno' as const },
        { id: 'f2', label: 'Symptoms', type: 'multiselect' as const, options: ['Cough', 'Fever'] },
        { id: 'f3', label: 'Unanswered', type: 'text' as const },
      ],
    }
    const st = { ...emptyFormState(), customFields: { f1: 'Yes', f2: ['Cough', 'Fever'], f3: '' } }
    expect(summarizeSection(sec, st, ctx)).toEqual([
      { label: 'Bed net at home', value: 'Yes' },
      { label: 'Symptoms', value: 'Cough, Fever' },
    ])
  })

  it('a section with nothing recorded summarizes to nothing (the Visit section always has its date)', () => {
    for (const id of ['patient', 'vitals', 'history', 'chiefConcern', 'labs', 'notes', 'imaging']) {
      expect(summarizeSection(builtin(id), emptyFormState(), ctx), id).toEqual([])
    }
    expect(summarizeSection(builtin('encounter'), emptyFormState(), ctx).map((l) => l.label)).toEqual(['Date'])
  })
})
