/**
 * The Visits tab in role mode (src/ui/records/RecordsScreen.tsx).
 *
 * The chart's Edit and + New visit open the visit form the way the signed-in
 * role sees it when the shell passes a role (DH EMR Clinic), and the full
 * form when it does not (DH EMR Field). Before this, Edit from the chart
 * ignored the role entirely, so a pharmacy account that could only see
 * Medications on the Board got the whole visit from the Visits tab.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, records, setCurrentDeviceId } from '../src/kernel'
import { todayLocal } from '../src/domain/today'
import { clearDraft } from '../src/ui/encounter/draft'
import RecordsScreen from '../src/ui/records/RecordsScreen'
import type { Medication, PatientRecord } from '../src/types/record'

const h = React.createElement
const TODAY = todayLocal()

/** View-only sections are a disabled fieldset: :disabled matches, .disabled does not. */
const inert = (el: HTMLElement): boolean => el.matches(':disabled')

function makeRecord(over: Partial<Record<keyof PatientRecord, unknown>> = {}): PatientRecord {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    deviceId: 'dev-1',
    site: 'Clinic A',
    date: TODAY,
    mrn: 'TEPA01011990',
    givenName: 'Test',
    familyName: 'Patient',
    name: 'Test Patient',
    sex: 'F',
    dob: '1990-01-01',
    phone: '',
    ageEstimated: false,
    temp: '37.2',
    bp: '120/80',
    weight: '60',
    pregnant: 'No',
    breastfeeding: '',
    allergies: 'Penicillin',
    currentMeds: '',
    pmh: '',
    chiefConcern: 'Fever',
    accessToCare: null,
    transport: '',
    travelTime: '',
    labs: {},
    labComments: '',
    urinalysis: null,
    bloodGlucose: '',
    diagnosis: 'Malaria',
    diagnosisCodes: [],
    medications: [],
    treatmentNotes: '',
    treatment: '',
    procedures: [],
    imaging: null,
    surgery: null,
    referralType: 'None',
    referralDate: '',
    provider: 'Dr. A',
    notes: '',
    templateId: null,
    templateName: '',
    customFields: {},
    savedAt: `${TODAY}T08:00:00.000Z`,
    ...over,
  } as PatientRecord
}

const med = (): Medication => ({
  id: 'm1',
  medId: 'med-a',
  dose: '500mg',
  freq: 'q8h',
  duration: '7d',
  qty: 21,
  qtyUnit: 'tabs',
})

const CONFIG_KEYS = ['formTemplates', 'formSchema', 'formulary', 'sites', 'providers']

beforeEach(async () => {
  await resetStorage()
  for (const k of CONFIG_KEYS) await config.remove(k)
  setCurrentDeviceId('dev-1')
  clearDraft()
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearDraft()
})

/** Render the Visits tab and open Test Patient's chart. */
async function openChart(role?: string): Promise<HTMLElement> {
  render(
    h(RecordsScreen, {
      deviceId: 'dev-1',
      refreshSignal: 0,
      ...(role ? { role } : {}),
    }),
  )
  fireEvent.click(await screen.findByRole('button', { name: /Test Patient/ }))
  return screen.findByRole('dialog', { name: 'Chart for Test Patient' })
}

describe('Visits tab in role mode', () => {
  it("Edit from the chart opens the visit in the signed-in role's view", async () => {
    await records.save(makeRecord({ id: 'v1', medications: [med()] }))
    const chart = await openChart('pharmacy')
    fireEvent.click(within(chart).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByRole('dialog', { name: 'Edit visit' })
    expect(within(form).getByText(/Pharmacy sections/)).toBeTruthy()
    // The sections render once the template library has loaded, so the first
    // query awaits the body; the rest can read synchronously.
    // Medications editable; Patient and Diagnosis read-only; Vitals hidden.
    expect(inert(await within(form).findByLabelText('Treatment notes'))).toBe(false)
    expect(inert(within(form).getByLabelText('Diagnosis'))).toBe(true)
    expect(inert(within(form).getByLabelText(/^Given name/))).toBe(true)
    expect(within(form).getAllByText('View only')).toHaveLength(2)
    expect(within(form).queryByLabelText(/Temperature/)).toBeNull()
  })

  it('+ New visit from the chart is role mode too: the required sections open for the role', async () => {
    await records.save(makeRecord({ id: 'v2' }))
    const chart = await openChart('pharmacy')
    fireEvent.click(within(chart).getByRole('button', { name: '+ New visit' }))
    const form = await screen.findByRole('dialog', { name: 'New visit' })
    expect(within(form).getByText('New visit for Test Patient')).toBeTruthy()
    expect(within(form).getByText(/Pharmacy sections/)).toBeTruthy()
    expect(inert(await within(form).findByLabelText(/^Given name/))).toBe(false)
    expect(inert(within(form).getByLabelText('Treatment notes'))).toBe(false)
    // View-only sections are omitted on a new visit; nothing is read-only.
    expect(within(form).queryByLabelText('Diagnosis')).toBeNull()
    expect(within(form).queryByText('View only')).toBeNull()
    expect(within(form).queryByLabelText(/Temperature/)).toBeNull()
  })

  it("without a role (Field) the chart's Edit opens the full form, as before", async () => {
    await records.save(makeRecord({ id: 'v3' }))
    const chart = await openChart()
    fireEvent.click(within(chart).getByRole('button', { name: 'Edit' }))
    const form = await screen.findByRole('dialog', { name: 'Edit visit' })
    expect(await within(form).findByLabelText(/Temperature/)).toBeTruthy()
    expect(inert(within(form).getByLabelText('Diagnosis'))).toBe(false)
    expect(inert(within(form).getByLabelText(/^Given name/))).toBe(false)
    expect(within(form).queryByText('View only')).toBeNull()
    expect(within(form).queryByText(/sections$/)).toBeNull()
  })
})
