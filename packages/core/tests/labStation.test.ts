/**
 * The Lab role's home on the board.
 *
 * The shipped station list used to be Check-in, Triage, Provider, Pharmacy,
 * Done: a lab account had no column of its own and every visit waiting on
 * results sat in the Provider column. The default list now carries a Lab
 * station between Provider and Pharmacy. These cases pin what that must
 * mean for the pieces that read the defaults:
 *
 *  - homeStationFor matches a role to a station by name, case-insensitively,
 *    so the lab role now has a home on the shipped list (and still has none
 *    on a list without a Lab column: nothing is renamed or invented);
 *  - the Board renders the "your station" tag on the Lab column for a lab
 *    account, with the column in board order;
 *  - the Settings stations editor's default text is the new list, one
 *    station per line, so an admin who has never customized the board sees
 *    exactly what the board shows.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, records, setCurrentDeviceId, settings } from '../src/kernel'
import { DEFAULT_FLOW_STATIONS } from '../src/config/keys'
import { boardGroups, resolveStations } from '../src/domain/flow'
import { todayLocal } from '../src/domain/today'
import BoardScreen from '../src/ui/board/BoardScreen'
import { homeStationFor } from '../src/ui/board/boardRole'
import SettingsScreen from '../src/ui/settings/SettingsScreen'
import { pendingLabs, visitsWaitingOnLabs } from '../src/ui/lab/labModel'
import type { ActiveProfile } from '../src/auth'
import type { PatientRecord } from '../src/types/record'

const h = React.createElement
const TODAY = todayLocal()

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

function profile(role: string, over: Partial<ActiveProfile> = {}): ActiveProfile {
  return {
    userId: 'u1',
    displayName: 'Peter',
    role,
    isAdmin: false,
    confirmedAt: new Date().toISOString(),
    ...over,
  }
}

beforeEach(async () => {
  await resetStorage()
  await config.remove('flowStations')
  setCurrentDeviceId('dev-1')
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

describe('the lab role has a home column on the shipped station list', () => {
  it('every station role finds its column by name on the defaults; reception owns the first', () => {
    expect(homeStationFor('reception', DEFAULT_FLOW_STATIONS)).toBe('Check-in')
    expect(homeStationFor('triage', DEFAULT_FLOW_STATIONS)).toBe('Triage')
    expect(homeStationFor('provider', DEFAULT_FLOW_STATIONS)).toBe('Provider')
    expect(homeStationFor('lab', DEFAULT_FLOW_STATIONS)).toBe('Lab')
    expect(homeStationFor('pharmacy', DEFAULT_FLOW_STATIONS)).toBe('Pharmacy')
  })

  it('matches case-insensitively, so a stored role of any case lands on the Lab column', () => {
    expect(homeStationFor('LAB', DEFAULT_FLOW_STATIONS)).toBe('Lab')
    expect(homeStationFor('Lab', DEFAULT_FLOW_STATIONS)).toBe('Lab')
    expect(homeStationFor('lab', ['Front desk', 'LAB', 'Out'])).toBe('LAB')
  })

  it('still has no home on an org list without a Lab column: nothing is invented', () => {
    expect(homeStationFor('lab', ['Check-in', 'Triage', 'Provider', 'Pharmacy', 'Done'])).toBeNull()
    expect(resolveStations(null)).toContain('Lab')
  })

  it('a visit waiting on results sits in the Lab column, and the Lab queue reads it from any column', () => {
    const atLab = makeRecord({
      id: 'lab1',
      flow_station: 'Lab',
      flow_updated_at: `${TODAY}T09:00:00.000Z`,
      labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: '' } },
    })
    // Ordered by a provider who kept the patient in the room: still queued.
    const atProvider = makeRecord({
      id: 'lab2',
      flow_station: 'Provider',
      flow_updated_at: `${TODAY}T09:05:00.000Z`,
      labs: { Hemoglobin: { ordered: true, type: 'numeric', value: '', unit: 'g/dL' } },
    })
    const g = boardGroups([atLab, atProvider], DEFAULT_FLOW_STATIONS, TODAY)
    expect(g.columns.map((c) => c.station)).toEqual(DEFAULT_FLOW_STATIONS)
    expect(g.columns.find((c) => c.station === 'Lab')?.visits.map((r) => r.id)).toEqual(['lab1'])
    expect(g.columns.find((c) => c.station === 'Provider')?.visits.map((r) => r.id)).toEqual(['lab2'])
    expect(visitsWaitingOnLabs([atLab, atProvider], TODAY).map((r) => r.id)).toEqual(['lab1', 'lab2'])
    expect(pendingLabs(atProvider)).toEqual(['Hemoglobin'])
  })
})

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

describe('the board for a lab account', () => {
  it('renders the Lab column in board order with the "your station" tag', async () => {
    await records.save(
      makeRecord({
        id: 'b1',
        flow_station: 'Lab',
        flow_updated_at: `${TODAY}T08:00:00.000Z`,
        labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: '' } },
      }),
    )
    const { container } = render(
      h(BoardScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('lab') }),
    )
    await screen.findByText('Test Patient')
    const names = [...container.querySelectorAll('.board-col-name')].map(
      (el) => el.firstChild?.textContent ?? '',
    )
    expect(names).toEqual(DEFAULT_FLOW_STATIONS)
    const mine = container.querySelector('.board-col-mine') as HTMLElement
    expect(mine).not.toBeNull()
    expect(within(mine).getByText('Lab', { selector: '.board-col-name' })).toBeTruthy()
    expect(within(mine).getByText('your station')).toBeTruthy()
    expect(within(mine).getByText('Test Patient')).toBeTruthy()
    // One home column, never two.
    expect(container.querySelectorAll('.board-col-mine')).toHaveLength(1)
    expect(screen.getAllByText('your station')).toHaveLength(1)
  })

  it('an org list without a Lab column highlights nothing for a lab account', async () => {
    await config.set('flowStations', ['Check-in', 'Triage', 'Provider', 'Pharmacy', 'Done'])
    await records.save(
      makeRecord({ id: 'b2', flow_station: 'Provider', flow_updated_at: `${TODAY}T08:00:00.000Z` }),
    )
    const { container } = render(
      h(BoardScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('lab') }),
    )
    await screen.findByText('Test Patient')
    await screen.findByText('Pharmacy', { selector: '.board-col-name' })
    expect(container.querySelector('.board-col-mine')).toBeNull()
    expect(screen.queryByText('your station')).toBeNull()
    expect(screen.queryByText('Lab', { selector: '.board-col-name' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The Settings stations editor
// ---------------------------------------------------------------------------

describe('the Settings stations editor', () => {
  it('shows the shipped list, one station per line, when the org has not customized the board', async () => {
    await settings.set('deviceRole', 'admin')
    render(h(SettingsScreen, { product: 'clinic', account: null }))
    const box = (await screen.findByLabelText(
      'Patient flow stations (clinic mode board)',
    )) as HTMLTextAreaElement
    expect(box.value).toBe('Check-in\nTriage\nProvider\nLab\nPharmacy\nDone')
    expect(box.value).toBe(DEFAULT_FLOW_STATIONS.join('\n'))
    expect(screen.getByText(/the last station means done for the day/)).toBeTruthy()
  })
})
