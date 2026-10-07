/**
 * Patient-flow board logic (src/domain/flow.ts). Pure and deterministic:
 * every clock and calendar value is passed in.
 *
 * The day-scoping rules matter clinically: yesterday's un-discharged
 * patients must never haunt today's columns, and a visit stranded on a
 * renamed station must surface for re-check-in instead of vanishing.
 */
import { describe, expect, it } from 'vitest'
import {
  boardGroups,
  formatWait,
  isDone,
  movePatch,
  nextStation,
  resolveStations,
  waitMinutes,
} from '../src/domain/flow'
import { DEFAULT_FLOW_STATIONS } from '../src/config/keys'
import type { PatientRecord } from '../src/types/record'

const TODAY = '2026-08-31'
const STATIONS = ['Check-in', 'Triage', 'Provider', 'Lab', 'Pharmacy', 'Done']

type AnyRec = Record<string, unknown>

function makeRecord(over: AnyRec = {}): PatientRecord {
  return {
    id: `id-${Math.random().toString(36).slice(2)}`,
    site: 'Clinic A',
    date: TODAY,
    mrn: 'TEPA01011990',
    givenName: 'Test',
    familyName: 'Patient',
    name: 'Test Patient',
    sex: 'F',
    dob: '1990-01-01',
    phone: '',
    temp: '37.0',
    bp: '120/80',
    weight: '60',
    allergies: '',
    currentMeds: '',
    pmh: '',
    chiefConcern: 'Fever',
    labs: {},
    urinalysis: null,
    accessToCare: null,
    diagnosis: '',
    diagnosisCodes: [],
    medications: [],
    procedures: [],
    imaging: null,
    surgery: null,
    referralType: 'None',
    referralDate: '',
    provider: 'Dr. A',
    notes: '',
    ageEstimated: false,
    bloodGlucose: '',
    templateId: null,
    templateName: '',
    customFields: {},
    treatmentNotes: '',
    treatment: '',
    transport: '',
    travelTime: '',
    labComments: '',
    savedAt: `${TODAY}T08:00:00.000Z`,
    ...over,
  } as unknown as PatientRecord
}

// ---------------------------------------------------------------------------
// resolveStations
// ---------------------------------------------------------------------------

describe('resolveStations', () => {
  it('returns the configured list in order', () => {
    expect(resolveStations(['Desk', 'Doctor', 'Out'])).toEqual(['Desk', 'Doctor', 'Out'])
  })

  it('falls back to the defaults when nothing is configured', () => {
    expect(resolveStations(null)).toEqual(DEFAULT_FLOW_STATIONS)
    expect(resolveStations(undefined)).toEqual(DEFAULT_FLOW_STATIONS)
  })

  it('the shipped defaults give every station role a column, Lab between Provider and Pharmacy, Done last', () => {
    // The lab role had no column before: visits waiting on results sat in
    // the Provider column and a lab account had no "your station". The
    // order is the clinical flow: results come back before dispensing.
    expect(DEFAULT_FLOW_STATIONS).toEqual(['Check-in', 'Triage', 'Provider', 'Lab', 'Pharmacy', 'Done'])
    expect(nextStation('Provider', DEFAULT_FLOW_STATIONS)).toBe('Lab')
    expect(nextStation('Lab', DEFAULT_FLOW_STATIONS)).toBe('Pharmacy')
    expect(isDone('Lab', DEFAULT_FLOW_STATIONS)).toBe(false)
    expect(isDone('Done', DEFAULT_FLOW_STATIONS)).toBe(true)
  })

  it('refuses an empty configured list by falling back', () => {
    expect(resolveStations([])).toEqual(DEFAULT_FLOW_STATIONS)
  })

  it('drops blank lines and trims whitespace', () => {
    expect(resolveStations(['  Triage  ', '', '   ', 'Provider'])).toEqual([
      'Triage',
      'Provider',
    ])
  })

  it('refuses a blank-only list by falling back', () => {
    expect(resolveStations(['', '   ', '\t'])).toEqual(DEFAULT_FLOW_STATIONS)
  })

  it('drops non-string entries from malformed synced config', () => {
    expect(
      resolveStations([1, null, 'Triage', { name: 'x' }] as unknown as string[]),
    ).toEqual(['Triage'])
  })

  it('de-duplicates repeated names, keeping first position', () => {
    expect(resolveStations(['A', 'B', 'A', 'C', 'B'])).toEqual(['A', 'B', 'C'])
  })

  it('never returns the DEFAULT_FLOW_STATIONS array itself (mutation safety)', () => {
    const out = resolveStations(null)
    expect(out).not.toBe(DEFAULT_FLOW_STATIONS)
    out.push('Mutated')
    expect(DEFAULT_FLOW_STATIONS).not.toContain('Mutated')
  })

  it('does not mutate the configured input', () => {
    const input = ['  A ', '', 'B']
    resolveStations(input)
    expect(input).toEqual(['  A ', '', 'B'])
  })
})

// ---------------------------------------------------------------------------
// boardGroups
// ---------------------------------------------------------------------------

describe('boardGroups', () => {
  it('produces one column per station, in station order, even when empty', () => {
    const g = boardGroups([], STATIONS, TODAY)
    expect(g.columns.map((c) => c.station)).toEqual(STATIONS)
    expect(g.columns.every((c) => c.visits.length === 0)).toBe(true)
    expect(g.offBoard).toEqual([])
  })

  it('groups today visits under their station', () => {
    const a = makeRecord({ id: 'a', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const b = makeRecord({ id: 'b', flow_station: 'Provider', flow_updated_at: '2026-08-31T09:05:00.000Z' })
    const g = boardGroups([a, b], STATIONS, TODAY)
    expect(g.columns.find((c) => c.station === 'Triage')?.visits.map((r) => r.id)).toEqual(['a'])
    expect(g.columns.find((c) => c.station === 'Provider')?.visits.map((r) => r.id)).toEqual(['b'])
  })

  it('sorts each column by flow_updated_at ascending: longest wait first', () => {
    const late = makeRecord({ id: 'late', flow_station: 'Triage', flow_updated_at: '2026-08-31T10:30:00.000Z' })
    const early = makeRecord({ id: 'early', flow_station: 'Triage', flow_updated_at: '2026-08-31T08:15:00.000Z' })
    const mid = makeRecord({ id: 'mid', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const g = boardGroups([late, early, mid], STATIONS, TODAY)
    expect(g.columns.find((c) => c.station === 'Triage')?.visits.map((r) => r.id)).toEqual([
      'early',
      'mid',
      'late',
    ])
  })

  it('falls back to savedAt for the order of a stationed row missing flow_updated_at', () => {
    const stamped = makeRecord({ id: 'stamped', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const legacy = makeRecord({ id: 'legacy', flow_station: 'Triage', flow_updated_at: null, savedAt: '2026-08-31T07:00:00.000Z' })
    const g = boardGroups([stamped, legacy], STATIONS, TODAY)
    expect(g.columns.find((c) => c.station === 'Triage')?.visits.map((r) => r.id)).toEqual([
      'legacy',
      'stamped',
    ])
  })

  it('NEVER shows a previous day on the board, regardless of station', () => {
    const yesterday = makeRecord({
      id: 'ghost',
      date: '2026-08-30',
      flow_station: 'Provider',
      flow_updated_at: '2026-08-30T16:00:00.000Z',
    })
    const g = boardGroups([yesterday], STATIONS, TODAY)
    expect(g.columns.every((c) => c.visits.length === 0)).toBe(true)
    // And not off-board either: the board is a today-only surface. The
    // Records screen still shows everything.
    expect(g.offBoard).toEqual([])
  })

  it('excludes future-dated visits too (a mis-set device clock elsewhere)', () => {
    const tomorrow = makeRecord({ id: 't', date: '2026-09-01', flow_station: 'Triage' })
    const g = boardGroups([tomorrow], STATIONS, TODAY)
    expect(g.columns.every((c) => c.visits.length === 0)).toBe(true)
    expect(g.offBoard).toEqual([])
  })

  it('excludes soft-deleted visits everywhere', () => {
    const deletedOn = makeRecord({ id: 'd1', deleted: true, flow_station: 'Triage' })
    const deletedOff = makeRecord({ id: 'd2', deleted: true, flow_station: null })
    const g = boardGroups([deletedOn, deletedOff], STATIONS, TODAY)
    expect(g.columns.every((c) => c.visits.length === 0)).toBe(true)
    expect(g.offBoard).toEqual([])
  })

  it('lists today visits with no station as off-board check-in candidates', () => {
    const noStation = makeRecord({ id: 'n1', flow_station: null })
    const absent = makeRecord({ id: 'n2' }) // field absent entirely
    const empty = makeRecord({ id: 'n3', flow_station: '' })
    const g = boardGroups([noStation, absent, empty], STATIONS, TODAY)
    expect(g.offBoard.map((r) => r.id).sort()).toEqual(['n1', 'n2', 'n3'])
  })

  it('sorts off-board by savedAt ascending: first come, first checked in', () => {
    const second = makeRecord({ id: 'second', savedAt: '2026-08-31T09:00:00.000Z' })
    const first = makeRecord({ id: 'first', savedAt: '2026-08-31T08:00:00.000Z' })
    const g = boardGroups([second, first], STATIONS, TODAY)
    expect(g.offBoard.map((r) => r.id)).toEqual(['first', 'second'])
  })

  it('surfaces a visit stranded on a removed/renamed station as off-board, never hides it', () => {
    const stranded = makeRecord({ id: 's', flow_station: 'Old Lab', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const g = boardGroups([stranded], STATIONS, TODAY)
    expect(g.columns.every((c) => c.visits.length === 0)).toBe(true)
    expect(g.offBoard.map((r) => r.id)).toEqual(['s'])
  })

  it('does not mutate the input records array', () => {
    const a = makeRecord({ id: 'a', flow_station: 'Triage', flow_updated_at: '2026-08-31T10:00:00.000Z' })
    const b = makeRecord({ id: 'b', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const input = [a, b]
    boardGroups(input, STATIONS, TODAY)
    expect(input.map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('duplicate station names in the list do not double a visit', () => {
    // resolveStations de-duplicates, but boardGroups must stay safe if
    // handed a raw list.
    const a = makeRecord({ id: 'a', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const g = boardGroups([a], ['Triage', 'Triage'], TODAY)
    const total = g.columns.reduce((n, c) => n + c.visits.length, 0)
    expect(total).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// movePatch
// ---------------------------------------------------------------------------

describe('movePatch', () => {
  const NOW = '2026-08-31T10:15:00.000Z'

  it('returns the two-field patch for a known station', () => {
    expect(movePatch('Provider', STATIONS, NOW)).toEqual({
      flow_station: 'Provider',
      flow_updated_at: NOW,
    })
  })

  it('stamps exactly the nowIso it was given (no clock of its own)', () => {
    const p = movePatch('Triage', STATIONS, '2026-08-31T23:59:59.999Z')
    expect(p?.flow_updated_at).toBe('2026-08-31T23:59:59.999Z')
  })

  it('returns null for an unknown station so the record stays untouched', () => {
    expect(movePatch('Radiology', STATIONS, NOW)).toBeNull()
  })

  it('is case-sensitive: station names are identity', () => {
    expect(movePatch('provider', STATIONS, NOW)).toBeNull()
  })

  it('does not trim: only the exact configured name moves a record', () => {
    expect(movePatch(' Provider', STATIONS, NOW)).toBeNull()
  })

  it('returns null against an empty station list', () => {
    expect(movePatch('Provider', [], NOW)).toBeNull()
  })

  it('allows a move to the same station (re-stamps the wait clock)', () => {
    expect(movePatch('Triage', STATIONS, NOW)).toEqual({
      flow_station: 'Triage',
      flow_updated_at: NOW,
    })
  })
})

// ---------------------------------------------------------------------------
// waitMinutes
// ---------------------------------------------------------------------------

describe('waitMinutes', () => {
  const now = new Date('2026-08-31T10:32:30.000Z')

  it('reports whole minutes since the move stamp', () => {
    const r = makeRecord({ flow_updated_at: '2026-08-31T10:00:30.000Z' })
    expect(waitMinutes(r, now)).toBe(32)
  })

  it('floors partial minutes rather than rounding up', () => {
    const r = makeRecord({ flow_updated_at: '2026-08-31T10:31:31.000Z' })
    expect(waitMinutes(r, now)).toBe(0)
  })

  it('reports 0 immediately after a move', () => {
    const r = makeRecord({ flow_updated_at: '2026-08-31T10:32:30.000Z' })
    expect(waitMinutes(r, now)).toBe(0)
  })

  it('clamps a future stamp (cross-device clock skew) to 0, never negative', () => {
    const r = makeRecord({ flow_updated_at: '2026-08-31T11:00:00.000Z' })
    expect(waitMinutes(r, now)).toBe(0)
  })

  it('returns null when there is no move stamp', () => {
    expect(waitMinutes(makeRecord({ flow_updated_at: null }), now)).toBeNull()
    expect(waitMinutes(makeRecord({}), now)).toBeNull()
    expect(waitMinutes(makeRecord({ flow_updated_at: '' }), now)).toBeNull()
  })

  it('returns null for an unparseable stamp', () => {
    expect(waitMinutes(makeRecord({ flow_updated_at: 'not-a-date' }), now)).toBeNull()
  })

  it('counts across hours', () => {
    const r = makeRecord({ flow_updated_at: '2026-08-31T08:02:30.000Z' })
    expect(waitMinutes(r, now)).toBe(150)
  })
})

// ---------------------------------------------------------------------------
// formatWait
// ---------------------------------------------------------------------------

describe('formatWait', () => {
  it('renders sub-hour waits in minutes', () => {
    expect(formatWait(0)).toBe('0 min')
    expect(formatWait(32)).toBe('32 min')
    expect(formatWait(59)).toBe('59 min')
  })

  it('renders exact hours without a minutes tail', () => {
    expect(formatWait(60)).toBe('1 h')
    expect(formatWait(120)).toBe('2 h')
  })

  it('renders mixed waits as hours and minutes', () => {
    expect(formatWait(65)).toBe('1 h 5 min')
    expect(formatWait(125)).toBe('2 h 5 min')
  })
})

// ---------------------------------------------------------------------------
// isDone / nextStation
// ---------------------------------------------------------------------------

describe('isDone', () => {
  it('is true only for the last station', () => {
    expect(isDone('Done', STATIONS)).toBe(true)
    expect(isDone('Pharmacy', STATIONS)).toBe(false)
    expect(isDone('Check-in', STATIONS)).toBe(false)
  })

  it('is false for an unknown station', () => {
    expect(isDone('Radiology', STATIONS)).toBe(false)
  })

  it('is false against an empty station list', () => {
    expect(isDone('Done', [])).toBe(false)
  })

  it('a single-station board is all done', () => {
    expect(isDone('Only', ['Only'])).toBe(true)
  })
})

describe('nextStation', () => {
  it('advances one station in board order', () => {
    expect(nextStation('Check-in', STATIONS)).toBe('Triage')
    expect(nextStation('Triage', STATIONS)).toBe('Provider')
    expect(nextStation('Provider', STATIONS)).toBe('Lab')
    expect(nextStation('Lab', STATIONS)).toBe('Pharmacy')
    expect(nextStation('Pharmacy', STATIONS)).toBe('Done')
  })

  it('has nowhere to go from the last station', () => {
    expect(nextStation('Done', STATIONS)).toBeNull()
  })

  it('refuses to guess from an unknown station', () => {
    expect(nextStation('Radiology', STATIONS)).toBeNull()
  })

  it('returns null on an empty or single-station list', () => {
    expect(nextStation('Only', [])).toBeNull()
    expect(nextStation('Only', ['Only'])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The move + regroup round trip (the board's whole write path in one place)
// ---------------------------------------------------------------------------

describe('move then regroup', () => {
  it('a moved record lands in its new column with a fresh wait clock', () => {
    const r = makeRecord({ id: 'p1', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const patch = movePatch('Provider', STATIONS, '2026-08-31T10:00:00.000Z')
    expect(patch).not.toBeNull()
    const moved = { ...r, ...patch }
    const g = boardGroups([moved], STATIONS, TODAY)
    expect(g.columns.find((c) => c.station === 'Provider')?.visits.map((x) => x.id)).toEqual(['p1'])
    expect(g.columns.find((c) => c.station === 'Triage')?.visits).toEqual([])
    expect(waitMinutes(moved, new Date('2026-08-31T10:07:00.000Z'))).toBe(7)
  })

  it('checking in an off-board visit places it at station 1', () => {
    const r = makeRecord({ id: 'p2' })
    const first = STATIONS[0] as string
    const patch = movePatch(first, STATIONS, '2026-08-31T08:30:00.000Z')
    const checkedIn = { ...r, ...patch }
    const g = boardGroups([checkedIn], STATIONS, TODAY)
    expect(g.offBoard).toEqual([])
    expect(g.columns[0]?.visits.map((x) => x.id)).toEqual(['p2'])
  })

  it('a refused move leaves the record exactly where it was', () => {
    const r = makeRecord({ id: 'p3', flow_station: 'Triage', flow_updated_at: '2026-08-31T09:00:00.000Z' })
    const patch = movePatch('Nowhere', STATIONS, '2026-08-31T10:00:00.000Z')
    expect(patch).toBeNull()
    // The UI writes nothing when the patch is null; the board is unchanged.
    const g = boardGroups([r], STATIONS, TODAY)
    expect(g.columns.find((c) => c.station === 'Triage')?.visits.map((x) => x.id)).toEqual(['p3'])
  })
})
