/**
 * Role workspaces (DH EMR Clinic): the role visibility model, role-filtered
 * rendering and saving on the visit form, dispensing, and the Lab, Pharmacy
 * and Board workspace logic. Every behavior here is one that, reverted,
 * turns Clinic back into a shared form:
 *
 *  - the resolver ships DEFAULTS per role and honors a sparse per-section
 *    override stored in the template schema (immutable ids, same
 *    persistence path, the formSchema mirror still written);
 *  - a role's save NEVER clears another role's sections: a pharmacy save
 *    keeps the vitals, including vitals triage wrote on another device
 *    while the pharmacy form was open;
 *  - on a NEW visit the required sections are editable for every role;
 *  - dispensing is stored on the medication line through records.update
 *    (sync_version bumps) and survives a provider's resave;
 *  - the Lab and Pharmacy queues select exactly "ordered, no result" and
 *    "prescribed, not dispensed" on today's visits;
 *  - the board's home column follows the role, reception first.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, records, setCurrentDeviceId } from '../src/kernel'
import { getConfig, loadLibrary, saveLibrary } from '../src/config/keys'
import { clearSectionRoles, getEffectiveSchema, setSectionRoles } from '../src/config/sections'
import {
  DEFAULT_ROLE_ACCESS,
  ROLES,
  canRegisterVisit,
  canSeeAnalytics,
  defaultSectionMode,
  materializeRoles,
  normalizeRole,
  roleGridFor,
  sectionModeFor,
  sectionsForRole,
  toggleGridCell,
  workspaceForRole,
  type Role,
  type SectionMode,
} from '../src/config/roles'
import type { FormTemplateLibrary, RawSection } from '../src/config/types'
import {
  editableIdsOf,
  formSectionsFor,
  preserveUnrenderedSections,
  problemsForRole,
} from '../src/ui/encounter/roleSections'
import { buildRecord, toFormState, type BuildContext } from '../src/ui/encounter/serialize'
import { emptyFormState } from '../src/ui/encounter/formState'
import { validateEncounter } from '../src/ui/encounter/validate'
import { EncounterForm } from '../src/ui/encounter/EncounterForm'
import { clearDraft } from '../src/ui/encounter/draft'
import TemplateBuilder from '../src/ui/templates/TemplateBuilder'
import BoardScreen from '../src/ui/board/BoardScreen'
import { checkInIsPrimary, homeStationFor } from '../src/ui/board/boardRole'
import LabScreen from '../src/ui/lab/LabScreen'
import {
  isLabPending,
  pendingLabs,
  resultedLabs,
  visitsResultedToday,
  visitsWaitingOnLabs,
} from '../src/ui/lab/labModel'
import PharmacyScreen from '../src/ui/pharmacy/PharmacyScreen'
import {
  dispensePatch,
  dispensedLines,
  medName,
  parseQty,
  suggestedQty,
  undispensePatch,
  undispensedLines,
  visitsAwaitingDispense,
  visitsDispensedToday,
} from '../src/ui/pharmacy/pharmacyModel'
import { STATION_ROLES } from '../src/ui/staff/staffApi'
import { todayLocal } from '../src/domain/today'
import type { ActiveProfile } from '../src/auth'
import type { Medication, PatientRecord } from '../src/types/record'

const h = React.createElement
const TODAY = todayLocal()

/**
 * Read-only sections disable their controls through a disabled <fieldset>:
 * the control's own `disabled` property stays false (it reflects only the
 * attribute), while :disabled matches, in jsdom as in browsers.
 */
const inert = (el: HTMLElement): boolean => el.matches(':disabled')

// ---------------------------------------------------------------- fixtures ---

type AnyRec = Partial<Record<keyof PatientRecord, unknown>>

function makeRecord(over: AnyRec = {}): PatientRecord {
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

function med(over: Partial<Medication> = {}): Medication {
  return {
    id: 'm1',
    medId: 'med-a',
    dose: '500mg',
    freq: 'q8h',
    duration: '7d',
    qty: 21,
    qtyUnit: 'tabs',
    ...over,
  }
}

function profile(role: string, over: Partial<ActiveProfile> = {}): ActiveProfile {
  return {
    userId: 'u1',
    displayName: 'Grace',
    role,
    isAdmin: false,
    confirmedAt: new Date().toISOString(),
    ...over,
  }
}

const BUILTIN_ON_FORM = [
  'encounter',
  'patient',
  'vitals',
  'history',
  'chiefConcern',
  'labs',
  'diagnosis',
  'medications',
  'procedures',
  'referral',
  'imaging',
  'surgery',
  'notes',
]

/** The effective schema of a template with one custom section. */
function schemaWith(sections: RawSection[] = []) {
  return getEffectiveSchema({
    sections: [
      ...sections,
      { id: 's_custom', title: 'Community Screening', fields: [{ id: 'f_water', label: 'Water', type: 'text' }] },
    ],
  })
}

function modesFor(role: string, isAdmin = false, raw: RawSection[] = []): Record<string, SectionMode> {
  const out: Record<string, SectionMode> = {}
  for (const s of schemaWith(raw).sections) out[s.id] = sectionModeFor(s, role, isAdmin)
  return out
}

/** Seed the kernel and return the stored copy (savedAt and versions stamped by the kernel). */
async function seed(rec: PatientRecord): Promise<PatientRecord> {
  await records.save(rec)
  const stored = (await records.getAll()).find((r) => r.id === rec.id)
  if (!stored) throw new Error('seed failed')
  return stored
}

async function stored(id: string): Promise<PatientRecord> {
  const r = (await records.getAll()).find((x) => x.id === id)
  if (!r) throw new Error(`record ${id} not stored`)
  return r
}

const CONFIG_KEYS = ['formTemplates', 'formSchema', 'formulary', 'flowStations', 'sites', 'providers']

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

// ---------------------------------------------------------------------------
// The resolver: defaults
// ---------------------------------------------------------------------------

describe('role resolver: shipped defaults', () => {
  it('reception edits Visit and Patient and views everything else, custom sections included', () => {
    const m = modesFor('reception')
    expect(m['encounter']).toBe('edit')
    expect(m['patient']).toBe('edit')
    for (const id of BUILTIN_ON_FORM.filter((x) => x !== 'encounter' && x !== 'patient')) {
      expect(m[id], id).toBe('view')
    }
    expect(m['s_custom']).toBe('view')
  })

  it('triage edits vitals, history, chief concern and labs, views the patient, sees nothing else', () => {
    const m = modesFor('triage')
    expect(m['vitals']).toBe('edit')
    expect(m['history']).toBe('edit')
    expect(m['chiefConcern']).toBe('edit')
    expect(m['labs']).toBe('edit')
    expect(m['patient']).toBe('view')
    expect(m['encounter']).toBe('hidden')
    expect(m['diagnosis']).toBe('hidden')
    expect(m['medications']).toBe('hidden')
    expect(m['s_custom']).toBe('hidden')
  })

  it('provider edits everything', () => {
    const m = modesFor('provider')
    for (const id of [...BUILTIN_ON_FORM, 's_custom']) expect(m[id], id).toBe('edit')
  })

  it('lab edits labs and views patient + chief concern only', () => {
    const m = modesFor('lab')
    expect(m['labs']).toBe('edit')
    expect(m['patient']).toBe('view')
    expect(m['chiefConcern']).toBe('view')
    expect(m['vitals']).toBe('hidden')
    expect(m['diagnosis']).toBe('hidden')
    expect(m['medications']).toBe('hidden')
    expect(m['s_custom']).toBe('hidden')
  })

  it('pharmacy edits medications and views patient + diagnosis only', () => {
    const m = modesFor('pharmacy')
    expect(m['medications']).toBe('edit')
    expect(m['patient']).toBe('view')
    expect(m['diagnosis']).toBe('view')
    expect(m['vitals']).toBe('hidden')
    expect(m['labs']).toBe('hidden')
    expect(m['s_custom']).toBe('hidden')
  })

  it('an admin edits everything whatever the role says, overrides included', () => {
    const m = modesFor('pharmacy', true, [{ id: 'vitals', roles: { view: [], edit: [] } }])
    for (const id of [...BUILTIN_ON_FORM, 's_custom']) expect(m[id], id).toBe('edit')
  })

  it('the pre-split nurse role is triage; an unknown role is the full form, never a stranded one', () => {
    expect(normalizeRole('nurse')).toBe('triage')
    expect(normalizeRole('Nurse ')).toBe('triage')
    expect(normalizeRole('volunteer')).toBe('provider')
    expect(normalizeRole('')).toBe('provider')
    expect(normalizeRole(null)).toBe('provider')
    expect(modesFor('nurse')['vitals']).toBe('edit')
    expect(modesFor('nurse')['diagnosis']).toBe('hidden')
    expect(modesFor('volunteer')['diagnosis']).toBe('edit')
  })

  it('defaultSectionMode is the table, verbatim', () => {
    for (const r of ROLES) {
      const d = DEFAULT_ROLE_ACCESS[r]
      for (const id of BUILTIN_ON_FORM) {
        const expected: SectionMode =
          d.edit === 'all' || d.edit.includes(id)
            ? 'edit'
            : d.view === 'all' || d.view.includes(id)
              ? 'view'
              : 'hidden'
        expect(defaultSectionMode(id, r), `${r}/${id}`).toBe(expected)
      }
    }
  })

  it('sectionsForRole omits hidden-for-role sections AND sections the admin hid for everyone', () => {
    const schema = schemaWith([{ id: 'history', hidden: true }])
    const provider = sectionsForRole(schema, 'provider', false).map((s) => s.id)
    expect(provider).not.toContain('history') // admin-hidden beats "provider edits all"
    expect(provider).toContain('vitals')
    const admin = sectionsForRole(schema, 'provider', true).map((s) => s.id)
    expect(admin).not.toContain('history')
    const pharmacy = sectionsForRole(schema, 'pharmacy', false)
    expect(pharmacy.map((s) => s.id)).toEqual(expect.arrayContaining(['patient', 'diagnosis', 'medications']))
    expect(pharmacy.find((s) => s.id === 'patient')?.mode).toBe('view')
    expect(pharmacy.find((s) => s.id === 'medications')?.mode).toBe('edit')
    expect(pharmacy.map((s) => s.id)).not.toContain('vitals')
    // Schema order is kept: diagnosis comes before medications.
    expect(pharmacy.findIndex((s) => s.id === 'diagnosis')).toBeLessThan(
      pharmacy.findIndex((s) => s.id === 'medications'),
    )
  })

  it('the roles are fixed and the staff role picker offers exactly them', () => {
    expect([...ROLES]).toEqual(['reception', 'triage', 'provider', 'lab', 'pharmacy'])
    expect(STATION_ROLES).toBe(ROLES)
  })
})

// ---------------------------------------------------------------------------
// The resolver: overrides
// ---------------------------------------------------------------------------

describe('role resolver: per-section overrides', () => {
  it('a full override replaces the defaults for both keys', () => {
    const raw: RawSection[] = [{ id: 'diagnosis', roles: { view: ['pharmacy'], edit: ['triage'] } }]
    expect(modesFor('triage', false, raw)['diagnosis']).toBe('edit')
    expect(modesFor('pharmacy', false, raw)['diagnosis']).toBe('view')
    expect(modesFor('reception', false, raw)['diagnosis']).toBe('hidden') // default was view
    expect(modesFor('lab', false, raw)['diagnosis']).toBe('hidden')
  })

  it('a partial override falls back to the default for the key it leaves out', () => {
    const raw: RawSection[] = [{ id: 'diagnosis', roles: { edit: ['lab'] } }]
    expect(modesFor('lab', false, raw)['diagnosis']).toBe('edit')
    expect(modesFor('reception', false, raw)['diagnosis']).toBe('view') // default view kept
    expect(modesFor('provider', false, raw)['diagnosis']).toBe('view') // edit list replaced, view default kept
    expect(modesFor('triage', false, raw)['diagnosis']).toBe('hidden')
  })

  it('edit implies view even when the view list leaves the role out, and all means every role', () => {
    const raw: RawSection[] = [{ id: 'notes', roles: { view: [], edit: ['lab'] } }]
    expect(modesFor('lab', false, raw)['notes']).toBe('edit')
    expect(modesFor('pharmacy', false, raw)['notes']).toBe('hidden')
    const all: RawSection[] = [{ id: 'notes', roles: { view: 'all', edit: [] } }]
    for (const r of ROLES) expect(modesFor(r, false, all)['notes'], r).toBe('view')
  })

  it('overrides apply to custom sections too', () => {
    const schema = getEffectiveSchema({
      sections: [
        {
          id: 's_tri',
          title: 'Triage extras',
          fields: [{ id: 'f_pain', label: 'Pain', type: 'number' }],
          roles: { view: ['provider'], edit: ['triage'] },
        },
      ],
    })
    const sec = schema.sections.find((s) => s.id === 's_tri')!
    expect(sec.roles).toEqual({ view: ['provider'], edit: ['triage'] })
    expect(sectionModeFor(sec, 'triage', false)).toBe('edit')
    expect(sectionModeFor(sec, 'provider', false)).toBe('view')
    expect(sectionModeFor(sec, 'reception', false)).toBe('hidden')
  })

  it('setSectionRoles materializes a sparse override for a built-in and keeps the id; clearSectionRoles drops it', () => {
    const base = { sections: [] as RawSection[] }
    const set = setSectionRoles(base, 'vitals', { view: ['lab'], edit: ['triage'] })
    expect(set.sections).toEqual([{ id: 'vitals', roles: { view: ['lab'], edit: ['triage'] } }])
    // An existing override keeps its other keys.
    const renamed = setSectionRoles({ sections: [{ id: 'vitals', title: 'Obs' }] }, 'vitals', { view: 'all', edit: [] })
    expect(renamed.sections).toEqual([{ id: 'vitals', title: 'Obs', roles: { view: 'all', edit: [] } }])
    // Reset removes the key; a bare built-in override disappears entirely.
    expect(clearSectionRoles(set, 'vitals').sections).toEqual([])
    expect(clearSectionRoles(renamed, 'vitals').sections).toEqual([{ id: 'vitals', title: 'Obs' }])
    // A custom section keeps its entry (and its fields) minus the roles key.
    const custom = {
      sections: [{ id: 's_x', title: 'X', fields: [{ id: 'f_1', label: 'Q', type: 'text' as const }], roles: { view: [], edit: [] } }],
    }
    expect(clearSectionRoles(custom, 's_x').sections).toEqual([
      { id: 's_x', title: 'X', fields: [{ id: 'f_1', label: 'Q', type: 'text' }] },
    ])
  })

  it('the builder grid: Edit ticks View, clearing View clears Edit, and materialize writes both lists', () => {
    const sec = { id: 'diagnosis' as const }
    const grid = roleGridFor(sec)
    expect(grid).toEqual({ reception: 'view', triage: 'hidden', provider: 'edit', lab: 'hidden', pharmacy: 'view' })
    const triageEdit = toggleGridCell(grid, 'triage', 'edit', true)
    expect(triageEdit.triage).toBe('edit')
    expect(materializeRoles(triageEdit)).toEqual({
      view: ['reception', 'triage', 'provider', 'pharmacy'],
      edit: ['triage', 'provider'],
    })
    const providerNoView = toggleGridCell(grid, 'provider', 'view', false)
    expect(providerNoView.provider).toBe('hidden')
    const providerNoEdit = toggleGridCell(grid, 'provider', 'edit', false)
    expect(providerNoEdit.provider).toBe('view')
    const labView = toggleGridCell(grid, 'lab', 'view', true)
    expect(labView.lab).toBe('view')
  })

  it('persists through saveLibrary with the formSchema mirror still written', async () => {
    const lib: FormTemplateLibrary = {
      version: 1,
      templates: [
        {
          id: 'general',
          name: 'General',
          enabled: true,
          schema: { sections: [{ id: 'vitals', roles: { view: ['lab'], edit: ['triage'] } }] },
        },
      ],
    }
    await saveLibrary(config, lib)
    const back = await loadLibrary(config)
    const sec = getEffectiveSchema(back.templates[0]!.schema).sections.find((s) => s.id === 'vitals')!
    expect(sec.roles).toEqual({ view: ['lab'], edit: ['triage'] })
    expect(sectionModeFor(sec, 'lab', false)).toBe('view')
    expect(sectionModeFor(sec, 'pharmacy', false)).toBe('hidden')
    const mirror = (await getConfig(config, 'formSchema')) as { sections: RawSection[] } | null
    expect(mirror?.sections).toEqual([{ id: 'vitals', roles: { view: ['lab'], edit: ['triage'] } }])
  })
})

// ---------------------------------------------------------------------------
// Workspace routing (pure)
// ---------------------------------------------------------------------------

describe('workspace routing', () => {
  it('lab and pharmacy land on their own screens, everyone else on the board', () => {
    expect(workspaceForRole('lab')).toBe('lab')
    expect(workspaceForRole('pharmacy')).toBe('pharmacy')
    expect(workspaceForRole('reception')).toBe('board')
    expect(workspaceForRole('triage')).toBe('board')
    expect(workspaceForRole('provider')).toBe('board')
    expect(workspaceForRole('nurse')).toBe('board')
    expect(workspaceForRole('whatever')).toBe('board')
  })

  it('analytics is for providers and admins; registration for reception, providers and admins', () => {
    expect(canSeeAnalytics('provider', false)).toBe(true)
    expect(canSeeAnalytics('reception', true)).toBe(true)
    expect(canSeeAnalytics('reception', false)).toBe(false)
    expect(canSeeAnalytics('lab', false)).toBe(false)
    expect(canRegisterVisit('reception', false)).toBe(true)
    expect(canRegisterVisit('provider', false)).toBe(true)
    expect(canRegisterVisit('pharmacy', true)).toBe(true)
    expect(canRegisterVisit('triage', false)).toBe(false)
    expect(canRegisterVisit('lab', false)).toBe(false)
    expect(canRegisterVisit('pharmacy', false)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Form helpers (pure)
// ---------------------------------------------------------------------------

describe('form helpers', () => {
  it('on a NEW visit the required sections are editable for every role and view-only sections are omitted', () => {
    const schema = schemaWith()
    for (const r of ROLES) {
      const secs = formSectionsFor(schema, r, false, true)
      const ids = secs.map((s) => s.id)
      expect(ids, r).toContain('encounter')
      expect(ids, r).toContain('patient')
      expect(secs.every((s) => s.mode === 'edit'), r).toBe(true)
    }
    // Reception's intake form is the short one.
    expect(formSectionsFor(schema, 'reception', false, true).map((s) => s.id)).toEqual(['encounter', 'patient'])
    // Lab's new visit: identity plus its own section.
    expect(formSectionsFor(schema, 'lab', false, true).map((s) => s.id)).toEqual(['encounter', 'patient', 'labs'])
    // Editing an existing visit: the plain resolver verdict.
    const pharmacyEdit = formSectionsFor(schema, 'pharmacy', false, false)
    expect(pharmacyEdit.map((s) => s.id)).toEqual(['patient', 'diagnosis', 'medications'])
    expect(pharmacyEdit.find((s) => s.id === 'patient')?.mode).toBe('view')
    expect([...editableIdsOf(pharmacyEdit)]).toEqual(['medications'])
  })

  it('problemsForRole keeps only the problems the role can fix', () => {
    const s = emptyFormState(TODAY)
    // No name, no site, no sex: three required problems in two sections.
    const all = validateEncounter(s)
    expect(all.map((p) => p.field)).toEqual(expect.arrayContaining(['givenName', 'familyName', 'site', 'sex']))
    const forPharmacy = problemsForRole(all, new Set(['medications']))
    expect(forPharmacy).toEqual([])
    const forReception = problemsForRole(all, new Set(['encounter', 'patient']))
    expect(forReception.map((p) => p.field)).toEqual(all.map((p) => p.field))
    const custom = problemsForRole([{ field: 'customFields', message: 'x', fieldId: 'f' }], new Set())
    expect(custom).toHaveLength(1)
  })

  it('preserveUnrenderedSections copies every unedited built-in section from the stored visit', () => {
    const storedRec = makeRecord({
      id: 'r1',
      temp: '39.5',
      bp: '100/60',
      labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: 'POS' } },
      bloodGlucose: '',
      notes: 'provider note',
      medications: [med()],
    })
    // A pharmacy state whose vitals are blank (the hazard: a stale snapshot).
    const s = toFormState(storedRec)
    s.temp = ''
    s.bp = ''
    s.labs = {}
    s.notes = ''
    s.treatmentNotes = 'take with food'
    const ctx: BuildContext = {
      prev: storedRec,
      deviceId: 'dev-1',
      templateId: null,
      templateName: '',
      activeCustomFieldIds: [],
      formulary: [{ id: 'med-a', name: 'Amoxicillin 500mg', unit: 'tabs' }],
      frequencies: [{ value: 'q8h', label: 'Three times daily q8h' }],
      now: '2026-10-06T10:00:00.000Z',
      newId: () => 'n',
    }
    const naked = buildRecord(s, ctx)
    expect(naked.temp).toBe('') // without preservation the save blanks the vitals
    const safe = preserveUnrenderedSections(naked, storedRec, new Set(['medications']))
    expect(safe.temp).toBe('39.5')
    expect(safe.bp).toBe('100/60')
    expect(safe.labs).toEqual(storedRec.labs)
    expect(safe.notes).toBe('provider note')
    // The edited section is the form's.
    expect(safe.treatmentNotes).toBe('take with food')
    expect(safe.treatment).toContain('take with food')
    expect(safe.medications[0]?.medId).toBe('med-a')
    // Identity and bookkeeping untouched; inputs not mutated.
    expect(safe.id).toBe('r1')
    expect(safe.savedAt).toBe('2026-10-06T10:00:00.000Z')
    expect(naked.temp).toBe('')
    expect(storedRec.treatmentNotes).toBe('')
  })

  it('buildRecord keeps a line\'s dispensed mark across a provider resave', () => {
    const prev = makeRecord({
      medications: [med({ dispensed: { qty: 21, by: 'Grace', at: '2026-10-06T09:00:00.000Z' } }), med({ id: 'm2', medId: 'med-b', qty: null, qtyUnit: null })],
    })
    const s = toFormState(prev)
    s.treatmentNotes = 'edited by the provider'
    const rec = buildRecord(s, {
      prev,
      deviceId: 'dev-1',
      templateId: null,
      templateName: '',
      activeCustomFieldIds: [],
      formulary: [],
      frequencies: [],
      now: '2026-10-06T10:00:00.000Z',
      newId: () => 'n',
    })
    expect(rec.medications[0]?.dispensed).toEqual({ qty: 21, by: 'Grace', at: '2026-10-06T09:00:00.000Z' })
    expect(rec.medications[1]?.dispensed).toBeUndefined()
    expect('dispensed' in rec.medications[1]!).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The visit form in role mode (RTL)
// ---------------------------------------------------------------------------

function renderForm(editing: PatientRecord | null, role: string, isAdmin = false) {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  const utils = render(
    h(EncounterForm, {
      editing,
      seedFrom: null,
      allRecords: editing ? [editing] : [],
      deviceId: 'dev-1',
      onSaved,
      onClose,
      role,
      isAdmin,
    }),
  )
  return { onSaved, onClose, ...utils }
}

describe('visit form in role mode', () => {
  it('pharmacy sees Medications editable, Patient and Diagnosis read-only, and no Vitals', async () => {
    const rec = await seed(makeRecord({ id: 'p1', medications: [med()] }))
    renderForm(rec, 'pharmacy')
    const notes = await screen.findByLabelText('Treatment notes')
    expect(inert(notes)).toBe(false)
    // Read-only sections: the native disabled fieldset, with the chip.
    expect(inert(screen.getByLabelText(/^Given name/))).toBe(true)
    expect(inert(screen.getByLabelText('Diagnosis'))).toBe(true)
    expect(inert(screen.getByLabelText(/^Patient number/))).toBe(true)
    expect(screen.getAllByText('View only')).toHaveLength(2)
    expect(screen.getByRole('region', { name: 'Patient (view only)' })).toBeTruthy()
    // Hidden for the role: not in the DOM at all.
    expect(screen.queryByLabelText(/Temperature/)).toBeNull()
    expect(screen.queryByLabelText('Allergies')).toBeNull()
    expect(screen.queryByText('Lab comments')).toBeNull()
    expect(screen.getByText(/Pharmacy sections/)).toBeTruthy()
  })

  it('a pharmacy save does not blank the vitals', async () => {
    const rec = await seed(makeRecord({ id: 'p2', medications: [med()] }))
    const { onSaved } = renderForm(rec, 'pharmacy')
    const notes = (await screen.findByLabelText('Treatment notes')) as HTMLTextAreaElement
    fireEvent.change(notes, { target: { value: 'take with food' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const after = await stored('p2')
    expect(after.temp).toBe('37.2')
    expect(after.bp).toBe('120/80')
    expect(after.weight).toBe('60')
    expect(after.allergies).toBe('Penicillin')
    expect(after.chiefConcern).toBe('Fever')
    expect(after.diagnosis).toBe('Malaria')
    expect(after.treatmentNotes).toBe('take with food')
    expect(after.medications[0]?.medId).toBe('med-a')
    expect(after.sync_version).toBe(2)
  })

  it('a pharmacy save keeps vitals triage wrote on another device while the form was open', async () => {
    const rec = await seed(makeRecord({ id: 'p3', medications: [med()] }))
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const { onSaved } = renderForm(rec, 'pharmacy')
    const notes = (await screen.findByLabelText('Treatment notes')) as HTMLTextAreaElement
    // Triage, elsewhere: new vitals land in the store after this form opened.
    await records.update('p3', (r) => ({ ...r, temp: '39.5', bp: '100/60', chiefConcern: 'Fever and rigors' }))
    fireEvent.change(notes, { target: { value: 'take with food' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const after = await stored('p3')
    // The sections pharmacy does not edit come back from the FRESH copy...
    expect(after.temp).toBe('39.5')
    expect(after.bp).toBe('100/60')
    expect(after.chiefConcern).toBe('Fever and rigors')
    // ...and pharmacy's own section is what was on its screen.
    expect(after.treatmentNotes).toBe('take with food')
    // The stale-edit guard still spoke (the medications themselves could have changed too).
    expect(confirm).toHaveBeenCalled()
  })

  it('a triage NEW visit has Visit and Patient editable plus its own sections, nothing read-only', async () => {
    renderForm(null, 'triage')
    const given = await screen.findByLabelText(/^Given name/)
    expect(inert(given)).toBe(false)
    expect(inert(screen.getByLabelText(/Temperature/))).toBe(false)
    expect(inert(screen.getByLabelText('Allergies'))).toBe(false)
    expect(screen.queryByText('View only')).toBeNull()
    expect(screen.queryByLabelText('Diagnosis')).toBeNull()
    expect(screen.queryByLabelText('Treatment notes')).toBeNull()
    // Site is required and must be reachable: the Visit section is on screen.
    expect(screen.getByText('Select a site')).toBeTruthy()
  })

  it('a reception NEW visit is the short intake form, and without a role the full form renders as before', async () => {
    renderForm(null, 'reception')
    await screen.findByLabelText(/^Given name/)
    expect(screen.queryByLabelText(/Temperature/)).toBeNull()
    expect(screen.queryByLabelText('Diagnosis')).toBeNull()
    expect(screen.queryByLabelText('Notes')).toBeNull()
    cleanup()
    render(
      h(EncounterForm, {
        editing: null,
        seedFrom: null,
        allRecords: [],
        deviceId: 'dev-1',
        onSaved: vi.fn(),
        onClose: vi.fn(),
      }),
    )
    await screen.findByLabelText(/^Given name/)
    expect(screen.getByLabelText(/Temperature/)).toBeTruthy()
    expect(screen.getByLabelText('Diagnosis')).toBeTruthy()
    expect(screen.getByLabelText('Treatment notes')).toBeTruthy()
    expect(screen.queryByText('View only')).toBeNull()
    // No Ordered control outside role mode: Field never produces a pending order.
    expect(screen.queryByLabelText(/^Ordered:/)).toBeNull()
  })

  it('role mode offers an Ordered control per lab test that stores an ordered, unresulted entry', async () => {
    const rec = await seed(makeRecord({ id: 'o1' }))
    const { onSaved } = renderForm(rec, 'provider')
    const order = (await screen.findByLabelText('Ordered: Malaria RDT')) as HTMLInputElement
    expect(order.checked).toBe(false)
    fireEvent.click(order)
    expect(screen.getByText('Awaiting result')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
    const after = await stored('o1')
    expect(after.labs['Malaria RDT']).toEqual({ ordered: true, type: 'toggle', result: '' })
    expect(pendingLabs(after)).toEqual(['Malaria RDT'])
  })
})

// ---------------------------------------------------------------------------
// Lab workspace
// ---------------------------------------------------------------------------

describe('lab workspace logic', () => {
  it('isLabPending: ordered with no result or value; resulted and unordered are not', () => {
    expect(isLabPending({ ordered: true, type: 'toggle', result: '' })).toBe(true)
    expect(isLabPending({ ordered: true, type: 'toggle' })).toBe(true)
    expect(isLabPending({ ordered: true, type: 'numeric', value: '' })).toBe(true)
    expect(isLabPending({ ordered: true, type: 'toggle', result: 'NEG' })).toBe(false)
    expect(isLabPending({ ordered: true, type: 'numeric', value: '104', unit: 'mg/dL' })).toBe(false)
    expect(isLabPending({ ordered: false, type: 'toggle', result: '' })).toBe(false)
    expect(isLabPending(undefined)).toBe(false)
    // Legacy rows without a type: value present means numeric.
    expect(isLabPending({ ordered: true, value: '' } as never)).toBe(true)
  })

  it('visitsWaitingOnLabs: today only, not deleted, at least one pending lab, longest-waiting first', () => {
    const pending = (over: AnyRec) =>
      makeRecord({ labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: '' } }, ...over })
    const a = pending({ id: 'a', flow_updated_at: `${TODAY}T09:30:00.000Z` })
    const b = pending({ id: 'b', flow_updated_at: `${TODAY}T08:10:00.000Z` })
    const resulted = makeRecord({ id: 'r', labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: 'POS' } } })
    const yesterday = pending({ id: 'y', date: '2020-01-01' })
    const gone = pending({ id: 'd', deleted: true })
    const none = makeRecord({ id: 'n' })
    const out = visitsWaitingOnLabs([a, resulted, yesterday, gone, none, b], TODAY)
    expect(out.map((r) => r.id)).toEqual(['b', 'a'])
    expect(pendingLabs(a)).toEqual(['Malaria RDT'])
    expect(resultedLabs(resulted)).toEqual(['Malaria RDT'])
    expect(visitsResultedToday([a, resulted, yesterday, none], TODAY).map((r) => r.id)).toEqual(['r'])
  })

  it('the Lab screen lists the waiting visits and opens one in the lab role to enter the result', async () => {
    await seed(
      makeRecord({
        id: 'w1',
        givenName: 'Amara',
        familyName: 'Nakato',
        name: 'Amara Nakato',
        labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: '' } },
        flow_station: 'Provider',
      }),
    )
    await seed(
      makeRecord({
        id: 'w2',
        givenName: 'Joseph',
        familyName: 'Okello',
        name: 'Joseph Okello',
        labs: { 'Malaria RDT': { ordered: true, type: 'toggle', result: 'NEG' } },
      }),
    )
    const onRefresh = vi.fn()
    render(h(LabScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('lab'), onRefresh }))
    await screen.findByText('Amara Nakato')
    expect(screen.getByText(/1 waiting on results/)).toBeTruthy()
    const list = screen.getByRole('list', { name: 'Visits waiting on lab results' })
    expect(within(list).queryByText('Joseph Okello')).toBeNull()
    expect(within(list).getByText('Malaria RDT')).toBeTruthy()
    expect(within(list).getByText(/Provider/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Enter results for Amara Nakato' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })
    expect(within(dialog).getByText(/Lab sections/)).toBeTruthy()
    // Lab's slice: Labs editable, Patient and Chief Concern read-only, no Vitals.
    const order = within(dialog).getByLabelText('Ordered: Malaria RDT') as HTMLInputElement
    expect(order.checked).toBe(true)
    expect(inert(order)).toBe(false)
    expect(inert(within(dialog).getByLabelText(/^Given name/))).toBe(true)
    expect(inert(within(dialog).getByLabelText('Chief concern'))).toBe(true)
    expect(within(dialog).queryByLabelText(/Temperature/)).toBeNull()
    expect(within(dialog).queryByLabelText('Diagnosis')).toBeNull()

    const tile = within(dialog).getByText('Malaria RDT').closest('.lab') as HTMLElement
    fireEvent.click(within(tile).getByRole('button', { name: 'POS' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit visit' })).toBeNull())
    const after = await stored('w1')
    expect(after.labs['Malaria RDT']).toEqual({ ordered: true, type: 'toggle', result: 'POS' })
    expect(after.temp).toBe('37.2') // vitals preserved by the lab save
    expect(after.diagnosis).toBe('Malaria')
    expect(onRefresh).toHaveBeenCalled()
    // The visit leaves the queue.
    await screen.findByText('No visits are waiting on lab results')
  })
})

// ---------------------------------------------------------------------------
// Pharmacy workspace
// ---------------------------------------------------------------------------

describe('pharmacy workspace logic', () => {
  it('selects undispensed lines and today\'s visits that carry one', () => {
    const open = makeRecord({ id: 'o', medications: [med(), med({ id: 'm2', dispensed: { qty: 1, by: 'x', at: 't' } })] })
    const done = makeRecord({ id: 'd', medications: [med({ dispensed: { qty: 21, by: 'x', at: 't' } })] })
    const blank = makeRecord({ id: 'b', medications: [med({ medId: '' })] })
    const old = makeRecord({ id: 'y', date: '2020-01-01', medications: [med()] })
    const gone = makeRecord({ id: 'g', deleted: true, medications: [med()] })
    expect(undispensedLines(open).map((m) => m.id)).toEqual(['m1'])
    expect(dispensedLines(open).map((m) => m.id)).toEqual(['m2'])
    expect(visitsAwaitingDispense([done, old, gone, blank, open], TODAY).map((r) => r.id)).toEqual(['o'])
    expect(visitsDispensedToday([done, old, gone, blank, open], TODAY).map((r) => r.id)).toEqual(['d', 'o'])
  })

  it('dispensePatch marks exactly one line, ignores unknown ids and mutates nothing; undispensePatch removes the mark', () => {
    const rec = makeRecord({ medications: [med(), med({ id: 'm2' })] })
    const mark = { qty: 21, by: 'Grace', at: '2026-10-06T09:00:00.000Z' }
    const marked = dispensePatch(rec, 'm1', mark)
    expect(marked.medications[0]?.dispensed).toEqual(mark)
    expect(marked.medications[1]?.dispensed).toBeUndefined()
    expect(rec.medications[0]?.dispensed).toBeUndefined()
    expect(marked).not.toBe(rec)
    const stale = dispensePatch(rec, 'm-gone', mark)
    expect(stale.medications).toEqual(rec.medications)
    const undone = undispensePatch(marked, 'm1')
    expect('dispensed' in undone.medications[0]!).toBe(false)
    expect(undispensePatch(rec, 'm1').medications).toEqual(rec.medications)
  })

  it('quantity helpers', () => {
    expect(suggestedQty(med())).toBe(21)
    expect(suggestedQty(med({ qty: null }))).toBeNull()
    expect(parseQty('14')).toBe(14)
    expect(parseQty(' 2.5 ')).toBe(2.5)
    expect(parseQty('')).toBeNull()
    expect(parseQty('abc')).toBeNull()
    expect(parseQty('-1')).toBeNull()
    expect(medName(med(), [{ id: 'med-a', name: 'Amoxicillin 500mg' }])).toBe('Amoxicillin 500mg')
    expect(medName(med({ medId: 'Ibuprofen' }), [])).toBe('Ibuprofen')
  })

  it('the Pharmacy screen marks lines dispensed through records.update (synced) and can undo', async () => {
    await config.set('formulary', [
      { id: 'med-a', name: 'Amoxicillin 500mg', dose: '500mg', unit: 'tabs' },
      { id: 'med-b', name: 'Paracetamol 500mg', dose: '500mg', unit: 'tabs' },
    ])
    await seed(
      makeRecord({
        id: 'rx1',
        medications: [med(), med({ id: 'm2', medId: 'med-b', qty: null, qtyUnit: null })],
      }),
    )
    const onRefresh = vi.fn()
    render(h(PharmacyScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('pharmacy'), onRefresh }))
    await screen.findByText('Test Patient')
    expect(screen.getByText(/1 waiting · 2 lines to dispense/)).toBeTruthy()
    expect(screen.getByText(/Allergies: Penicillin/)).toBeTruthy()
    const qtyA = screen.getByLabelText('Quantity dispensed: Amoxicillin 500mg') as HTMLInputElement
    expect(qtyA.value).toBe('21')

    fireEvent.click(screen.getByRole('button', { name: 'Mark Amoxicillin 500mg dispensed for Test Patient' }))
    await waitFor(async () => {
      const r = await stored('rx1')
      expect(r.medications[0]?.dispensed?.qty).toBe(21)
    })
    let r = await stored('rx1')
    expect(r.medications[0]?.dispensed?.by).toBe('Grace')
    expect(Date.parse(r.medications[0]?.dispensed?.at ?? '')).not.toBeNaN()
    expect(r.medications[1]?.dispensed).toBeUndefined()
    expect(r.sync_version).toBe(2) // records.update: the mark syncs like any edit
    // onRefresh fires after the update promise settles, one tick after the
    // stored write the waitFor above observed; assert it the same way.
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))

    // The second line had no computed quantity: the pharmacist types it.
    await screen.findByText(/1 waiting · 1 line to dispense/)
    const qtyB = screen.getByLabelText('Quantity dispensed: Paracetamol 500mg') as HTMLInputElement
    expect(qtyB.value).toBe('')
    fireEvent.change(qtyB, { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Mark Paracetamol 500mg dispensed for Test Patient' }))
    await screen.findByText('Nothing is waiting to be dispensed')
    r = await stored('rx1')
    expect(r.medications[1]?.dispensed?.qty).toBe(10)
    expect(r.sync_version).toBe(3)

    // Undo from the dispensed-today list puts the line back in the queue.
    fireEvent.click(screen.getByRole('button', { name: /Show dispensed today/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo dispensing Amoxicillin 500mg for Test Patient' }))
    await screen.findByText(/1 waiting · 1 line to dispense/)
    r = await stored('rx1')
    expect(r.medications[0]?.dispensed).toBeUndefined()
    expect(r.medications[1]?.dispensed?.qty).toBe(10)
    expect(r.sync_version).toBe(4)
  })

  it('the Pharmacy screen opens a visit in the pharmacy role', async () => {
    await seed(makeRecord({ id: 'rx2', medications: [med()] }))
    render(h(PharmacyScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('pharmacy') }))
    fireEvent.click(await screen.findByRole('button', { name: 'Open the visit for Test Patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })
    expect(within(dialog).getByText(/Pharmacy sections/)).toBeTruthy()
    expect(inert(within(dialog).getByLabelText('Treatment notes'))).toBe(false)
    expect(inert(within(dialog).getByLabelText('Diagnosis'))).toBe(true)
    expect(within(dialog).queryByLabelText(/Temperature/)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Board: the role's home column
// ---------------------------------------------------------------------------

describe('board home column', () => {
  const stations = ['Check-in', 'Triage', 'Provider', 'Pharmacy', 'Done']

  it('reception is the first station; others match by name; no match means no home', () => {
    expect(homeStationFor('reception', stations)).toBe('Check-in')
    expect(homeStationFor('triage', stations)).toBe('Triage')
    expect(homeStationFor('nurse', stations)).toBe('Triage')
    expect(homeStationFor('provider', stations)).toBe('Provider')
    expect(homeStationFor('pharmacy', stations)).toBe('Pharmacy')
    expect(homeStationFor('lab', stations)).toBeNull()
    expect(homeStationFor('lab', ['Front desk', 'Lab', 'Out'])).toBe('Lab')
    expect(homeStationFor('reception', ['Front desk', 'Lab', 'Out'])).toBe('Front desk')
    expect(homeStationFor('reception', [])).toBeNull()
    expect(checkInIsPrimary('reception')).toBe(true)
    expect(checkInIsPrimary('provider')).toBe(false)
  })

  it('the board highlights the role\'s column, makes Check in primary for reception, and opens a visit in role mode', async () => {
    await seed(makeRecord({ id: 'b1', flow_station: 'Check-in', flow_updated_at: `${TODAY}T08:00:00.000Z` }))
    const { container } = render(
      h(BoardScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('reception') }),
    )
    await screen.findByText('Test Patient')
    const mine = container.querySelector('.board-col-mine') as HTMLElement
    expect(mine).not.toBeNull()
    expect(within(mine).getByText('Check-in', { selector: '.board-col-name' })).toBeTruthy()
    expect(within(mine).getByText('your station')).toBeTruthy()
    const checkIn = screen.getByRole('button', { name: /^Check in/ })
    expect(checkIn.className).toBe('btn')
    expect(screen.getByRole('button', { name: '+ New patient' }).className).toBe('btn btn-ghost')

    fireEvent.click(screen.getByRole('button', { name: 'Open the visit for Test Patient' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit visit' })
    expect(within(dialog).getByText(/Reception sections/)).toBeTruthy()
    expect(inert(within(dialog).getByLabelText(/^Given name/))).toBe(false)
    expect(inert(within(dialog).getByLabelText(/Temperature/))).toBe(true)
  })

  it('a provider gets the Provider column and the usual primary New patient button', async () => {
    render(h(BoardScreen, { deviceId: 'dev-1', refreshSignal: 0, profile: profile('provider') }))
    await screen.findByText('Patient flow')
    expect(screen.getByRole('button', { name: /^Check in/ }).className).toBe('btn btn-ghost')
    expect(screen.getByRole('button', { name: '+ New patient' }).className).toBe('btn')
  })
})

// ---------------------------------------------------------------------------
// Template builder: the role grid
// ---------------------------------------------------------------------------

describe('template builder role grid', () => {
  async function seedLib(): Promise<void> {
    await saveLibrary(config, {
      version: 1,
      templates: [{ id: 'general', name: 'General Visit', enabled: true, schema: { sections: [] } }],
    })
  }
  const readLib = () => getConfig(config, 'formTemplates') as Promise<FormTemplateLibrary | null>
  const diagnosisOverride = async () =>
    (await readLib())?.templates[0]?.schema.sections.find((s) => s.id === 'diagnosis')

  it('shows the defaults, stores a materialized override on a tick, and Reset removes it', async () => {
    await seedLib()
    render(h(TemplateBuilder, { isAdmin: true, onClose: vi.fn() }))
    await screen.findByText('Sections of "General Visit"')
    fireEvent.click(screen.getByRole('button', { name: 'Roles for the Diagnosis section' }))
    expect(screen.getByText(/These are the built-in defaults/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Reset the roles of Diagnosis to default' })).toBeNull()
    const triageEdit = screen.getByLabelText('Triage can edit Diagnosis') as HTMLInputElement
    const pharmacyView = screen.getByLabelText('Pharmacy can view Diagnosis') as HTMLInputElement
    const providerEdit = screen.getByLabelText('Provider can edit Diagnosis') as HTMLInputElement
    expect(triageEdit.checked).toBe(false)
    expect(pharmacyView.checked).toBe(true)
    expect(providerEdit.checked).toBe(true)

    fireEvent.click(triageEdit)
    await waitFor(async () => {
      expect((await diagnosisOverride())?.roles).toEqual({
        view: ['reception', 'triage', 'provider', 'pharmacy'],
        edit: ['triage', 'provider'],
      })
    })
    await screen.findByRole('button', { name: 'Reset the roles of Diagnosis to default' })
    expect((screen.getByLabelText('Triage can view Diagnosis') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('Roles changed')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Reset the roles of Diagnosis to default' }))
    await waitFor(async () => {
      expect(await diagnosisOverride()).toBeUndefined()
    })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reset the roles of Diagnosis to default' })).toBeNull(),
    )
  })

  it('is read-only on a standard device, like every other control', async () => {
    await seedLib()
    render(h(TemplateBuilder, { isAdmin: false, onClose: vi.fn() }))
    await screen.findByText('Sections of "General Visit"')
    fireEvent.click(screen.getByRole('button', { name: 'Roles for the Vitals section' }))
    const box = screen.getByLabelText('Triage can edit Vitals') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    fireEvent.click(box)
    expect((await readLib())?.templates[0]?.schema.sections).toEqual([])
  })
})
