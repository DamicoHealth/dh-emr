/**
 * The station queue (src/ui/board/StationScreen.tsx): what triage and the
 * provider land on. The visits at the role's own board column, longest
 * waiting first, each one tap from the role's view of the visit; Next moves
 * a visit on; the Board stays one tap away.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, records, setCurrentDeviceId } from '../src/kernel'
import { todayLocal } from '../src/domain/today'
import { clearDraft } from '../src/ui/encounter/draft'
import StationScreen from '../src/ui/board/StationScreen'
import type { ActiveProfile } from '../src/auth'
import type { PatientRecord } from '../src/types/record'

const h = React.createElement
const TODAY = todayLocal()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

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
    allergies: '',
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
    diagnosis: '',
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

const person = (id: string, given: string, station: string | null, waitedMin: number) =>
  makeRecord({
    id,
    givenName: given,
    name: `${given} Patient`,
    mrn: `${given.slice(0, 2).toUpperCase()}PA01011990`,
    flow_station: station,
    flow_updated_at: minutesAgo(waitedMin),
  })

function profile(role: string, over: Partial<ActiveProfile> = {}): ActiveProfile {
  return { userId: 'u1', displayName: 'Dr. Amos', role, isAdmin: false, confirmedAt: new Date().toISOString(), ...over }
}

beforeEach(async () => {
  await resetStorage()
  for (const k of ['formTemplates', 'formSchema', 'flowStations', 'sites', 'providers']) await config.remove(k)
  setCurrentDeviceId('dev-1')
  clearDraft()
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearDraft()
})

async function seedClinic(): Promise<void> {
  await records.save(person('a', 'Alpha', 'Provider', 30))
  await records.save(person('b', 'Beta', 'Provider', 5))
  await records.save(person('c', 'Gamma', 'Triage', 12))
  await records.save(person('d', 'Delta', 'Pharmacy', 2))
}

describe('the station queue', () => {
  it("lists the visits waiting at the role's own station, longest-waiting first, with the upstream count", async () => {
    await seedClinic()
    render(h(StationScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('provider') }))
    await screen.findByRole('heading', { name: 'Provider' })
    expect(await screen.findByText(/2 waiting · 1 at Triage/)).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Visits waiting at Provider' })
    const names = within(list).getAllByRole('button', { name: /^Open the visit for/ }).map((b) => b.getAttribute('aria-label'))
    expect(names).toEqual(['Open the visit for Alpha Patient', 'Open the visit for Beta Patient'])
    expect(within(list).getByText('30 min')).toBeTruthy()
    expect(within(list).queryByText(/Gamma/)).toBeNull()
    expect(within(list).queryByText(/Delta/)).toBeNull()
  })

  it("Open shows the provider's view of the visit", async () => {
    await seedClinic()
    render(h(StationScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('provider') }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open the visit for Alpha Patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })
    expect(within(dialog).getByText(/Provider sections/)).toBeTruthy()
    await within(dialog).findByLabelText('Diagnosis')
  })

  it('Next moves the visit to the following station and the list shrinks', async () => {
    await seedClinic()
    const onRefresh = vi.fn()
    render(h(StationScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('provider'), onRefresh }))
    fireEvent.click(await screen.findByRole('button', { name: 'Move Alpha Patient to Lab' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open the visit for Alpha Patient' })).toBeNull())
    expect(screen.getByText(/1 waiting/)).toBeTruthy()
    const moved = (await records.getActive()).find((r) => r.id === 'a')
    expect(moved?.flow_station).toBe('Lab')
    expect(onRefresh).toHaveBeenCalled()
  })

  it('triage gets its own queue; the empty state points at the Board', async () => {
    await records.save(person('d', 'Delta', 'Pharmacy', 2))
    const onOpenBoard = vi.fn()
    render(h(StationScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('triage'), onOpenBoard }))
    await screen.findByRole('heading', { name: 'Triage' })
    expect(await screen.findByText('No one is waiting at Triage')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open the Board' }))
    expect(onOpenBoard).toHaveBeenCalledTimes(1)
  })

  it('a role whose station is missing from the board says so instead of showing nothing', async () => {
    await config.set('flowStations', ['Check-in', 'Doctor', 'Done'])
    render(h(StationScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('provider') }))
    expect(await screen.findByText('No Provider station on the board')).toBeTruthy()
  })
})
