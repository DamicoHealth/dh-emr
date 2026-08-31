/**
 * Dx/Rx preset editors and one-tap apply - the biggest speed lever for a
 * 60-patient day (spec section 6.2). The legacy app had full editors and
 * one-tap apply; the React port only read the keys. These tests pin the
 * restored behavior:
 *
 *  - hiddenPresets suppression ROUND-TRIPS: a removed built-in stays removed
 *    after sync on a device that still resolves the defaults - that is the
 *    key's whole job;
 *  - ids are permanent: editing or deleting a preset never re-mints or
 *    repoints a medId, and never touches the formulary;
 *  - per-line dose validation warns and never blocks;
 *  - the apply paths write through the form's two-writer discipline, so the
 *    discard guard sees an applied preset exactly like typed work.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { resetStorage } from './setup'
import { config } from '../src/kernel'
import { DX_PRESETS } from '../src/config/defaults/dxPresets'
import { RX_PRESETS } from '../src/config/defaults/rxPresets'
import { defaultHiddenPresets } from '../src/config/defaults/lists'
import type { FormularyEntry, HiddenPresets, RxPreset } from '../src/config/types'
import {
  addDxPreset,
  appendPresetNotes,
  buildMedLines,
  checkPresetLine,
  dxPartsOf,
  isPresetHidden,
  moveItem,
  removeDxPreset,
  removeRxPreset,
  resolveDxPresets,
  resolveRxPresets,
  rxSummary,
  toggleDxInText,
  visibleDxPresets,
  visibleRxPresets,
  withHidden,
} from '../src/ui/presets/presetsModel'
import { PresetEditors } from '../src/ui/presets/PresetEditors'
import { EncounterForm } from '../src/ui/encounter/EncounterForm'
import { clearDraft } from '../src/ui/encounter/draft'

const h = React.createElement

const CONFIG_KEYS = [
  'customDxPresets', 'rxPresets', 'hiddenPresets', 'formulary',
  'formTemplates', 'formSchema', 'sites', 'providers',
]

beforeEach(async () => {
  await resetStorage()
  for (const k of CONFIG_KEYS) await config.remove(k)
  clearDraft()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearDraft()
})

// ---------------------------------------------------------------------------
// Model: resolution and hiddenPresets round-trip
// ---------------------------------------------------------------------------

describe('preset resolution', () => {
  it('falls back to the built-in defaults when the org never customized', () => {
    expect(resolveDxPresets(null)).toEqual(DX_PRESETS)
    expect(resolveDxPresets([])).toEqual(DX_PRESETS)
    expect(resolveRxPresets(null).map((p) => p.name)).toEqual(RX_PRESETS.map((p) => p.name))
  })

  it('uses the org list when one is stored', () => {
    expect(resolveDxPresets(['Snakebite', 'Malaria'])).toEqual(['Snakebite', 'Malaria'])
    const stored: RxPreset[] = [{ name: 'Own', rx: 'x', meds: [] }]
    expect(resolveRxPresets(stored).map((p) => p.name)).toEqual(['Own'])
  })

  it('returns clones, never aliases of the vendored default objects', () => {
    const resolved = resolveRxPresets(null)
    const line = resolved[0]?.meds[0]
    expect(line).toBeDefined()
    if (line) line.dose = 'CHANGED'
    expect(RX_PRESETS[0]?.meds[0]?.dose).not.toBe('CHANGED')
  })
})

describe('hiddenPresets suppression', () => {
  it('removing a built-in Dx default hides it so it stays removed after sync', () => {
    // Admin device: resolves the defaults, removes one.
    const removed = removeDxPreset(resolveDxPresets(null), null, 'Scabies')
    expect(removed.list).not.toContain('Scabies')
    expect(removed.hidden['diagnoses']).toContain('Scabies')

    // Another device after sync: the org list never reached it, so it still
    // resolves the defaults - but the synced hiddenPresets suppresses the
    // removed built-in. That is hiddenPresets' whole job.
    const otherDevice = visibleDxPresets(resolveDxPresets(null), removed.hidden)
    expect(otherDevice).not.toContain('Scabies')
    expect(otherDevice).toContain('Malaria')
  })

  it('re-adding a removed built-in unhides it (the round trip)', () => {
    const removed = removeDxPreset(resolveDxPresets(null), null, 'Scabies')
    const readded = addDxPreset(removed.list, removed.hidden, 'Scabies')
    expect(readded.list).toContain('Scabies')
    expect(readded.hidden['diagnoses']).not.toContain('Scabies')
    expect(visibleDxPresets(readded.list, readded.hidden)).toContain('Scabies')
  })

  it('removing a CUSTOM entry does not grow hiddenPresets', () => {
    const removed = removeDxPreset(['Snakebite'], defaultHiddenPresets(), 'Snakebite')
    expect(removed.list).toEqual([])
    expect(removed.hidden['diagnoses']).toEqual([])
  })

  it('removing a built-in Rx preset hides it by name and keeps every other preset intact', () => {
    const before = resolveRxPresets(null)
    const removed = removeRxPreset(before, null, 'UTI')
    expect(removed.presets.some((p) => p.name === 'UTI')).toBe(false)
    expect(removed.hidden['rxPresets']).toContain('UTI')
    expect(visibleRxPresets(resolveRxPresets(null), removed.hidden).some((p) => p.name === 'UTI')).toBe(false)
    // The other presets pass through with their med lines and medIds untouched.
    const kept = removed.presets.find((p) => p.name === 'Typhoid')
    expect(kept?.meds[0]?.medId).toBe('abx-cipro')
  })

  it('materializing hiddenPresets from null keeps the default-off lab tests hidden', () => {
    // The first-ever hiddenPresets write must start from defaultHiddenPresets(),
    // not {} - otherwise saving a preset edit would surface the default-off
    // built-in lab tests (COVID, TB, Hep C) on every visit form in the org.
    const hidden = withHidden(null, 'diagnoses', 'Scabies', true)
    expect(hidden['labTests']).toContain('COVID-19 Rapid')
    expect(hidden['labTests']).toContain('TB (AFB Smear)')
  })

  it('preserves categories written by other clients on every update', () => {
    const foreign: HiddenPresets = { futureCategory: ['keep me'], diagnoses: [] }
    const updated = withHidden(foreign, 'diagnoses', 'Malaria', true)
    expect(updated['futureCategory']).toEqual(['keep me'])
    expect(isPresetHidden(updated, 'diagnoses', 'Malaria')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Model: bundle validation, summaries, apply helpers
// ---------------------------------------------------------------------------

const FORMULARY: FormularyEntry[] = [
  { id: 'med-a', name: 'Amoxicillin 500mg', dose: '500mg', unit: 'tabs', category: 'Antibiotics' },
  { id: 'med-b', name: 'Benzyl Benzoate lotion', dose: '25%', unit: 'ml', category: 'Skin' },
]

describe('per-line validation (warn, never block)', () => {
  it('shows the computed quantity for a readable line', () => {
    const check = checkPresetLine({ medId: 'med-a', dose: '500mg', freq: 'q8h', duration: '7d' }, FORMULARY)
    expect(check).toEqual({ tone: 'ok', text: '21 tabs' })
  })

  it('warns on an unparseable dose - the quantity assumes 1 per dose downstream', () => {
    const check = checkPresetLine({ medId: 'med-a', dose: 'one tablet', freq: 'q8h', duration: '7d' }, FORMULARY)
    expect(check?.tone).toBe('warn')
    expect(check?.text).toContain('assumes 1 per dose')
  })

  it('flags a free-typed drug name as recording no quantity, without blocking', () => {
    const check = checkPresetLine({ medId: 'Village herbal mix', dose: '1', freq: 'q24h', duration: '3d' }, FORMULARY)
    expect(check?.tone).toBe('muted')
    expect(check?.text).toContain('Not in the formulary')
  })

  it('reports no quantity for non-countable and ongoing lines', () => {
    expect(checkPresetLine({ medId: 'med-b', dose: '10ml', freq: 'q12h', duration: '7d' }, FORMULARY)?.tone).toBe('muted')
    expect(checkPresetLine({ medId: 'med-a', dose: '500mg', freq: 'q8h', duration: 'Ongoing' }, FORMULARY)?.text).toContain('Ongoing')
  })
})

describe('rx summary and apply helpers', () => {
  it('builds the legacy-format summary, with free drug names as typed', () => {
    const meds = [
      { medId: 'med-a', dose: '500mg', freq: 'q8h', duration: '7d' },
      { medId: 'ORS sachets', dose: '1 sachet', freq: 'q8h', duration: '3d' },
    ]
    expect(rxSummary(meds, FORMULARY)).toBe(
      'Amoxicillin 500mg 500mg Three times daily q8h 7d + ORS sachets 1 sachet Three times daily q8h 3d',
    )
    expect(rxSummary([], FORMULARY)).toBe('See treatment notes')
  })

  it('buildMedLines keeps medIds VERBATIM and mints fresh row ids on every apply', () => {
    const preset: RxPreset = {
      name: 'P', rx: 'x',
      meds: [{ medId: 'med-a', dose: '500mg', freq: 'q8h', duration: '7d' }],
    }
    let n = 0
    const first = buildMedLines(preset, () => `id-${++n}`)
    const second = buildMedLines(preset, () => `id-${++n}`)
    expect(first[0]?.medId).toBe('med-a') // the permanent formulary id, untouched
    expect(first[0]?.id).not.toBe(second[0]?.id) // rows can only APPEND, never collide
  })

  it('appends preset notes to existing treatment notes, never replacing them', () => {
    expect(appendPresetNotes('already typed', 'From preset')).toBe('already typed\nFrom preset')
    expect(appendPresetNotes('', 'From preset')).toBe('From preset')
    expect(appendPresetNotes('kept')).toBe('kept')
  })

  it('toggles a diagnosis in the free text without touching typed content', () => {
    expect(toggleDxInText('', 'Malaria')).toBe('Malaria')
    const appended = toggleDxInText('Severe dehydration', 'Malaria')
    expect(appended).toBe('Severe dehydration; Malaria')
    expect(toggleDxInText(appended, 'Malaria')).toBe('Severe dehydration')
    expect(dxPartsOf(' Malaria ;; UTI ')).toEqual(['Malaria', 'UTI'])
  })

  it('moveItem reorders in place and ignores out-of-range moves', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  })
})

// ---------------------------------------------------------------------------
// Encounter form: the apply paths
// ---------------------------------------------------------------------------

async function seedFormConfig(): Promise<void> {
  await config.set('customDxPresets', ['Malaria', 'Test Dx'])
  await config.set('rxPresets', [
    {
      name: 'Chest infection',
      rx: 'Amoxicillin 500mg Three times daily q8h 7d',
      meds: [{ medId: 'med-a', dose: '500mg', freq: 'q8h', duration: '7d' }],
      notes: 'Review in 3 days',
    },
  ] satisfies RxPreset[])
  await config.set('formulary', [
    { id: 'med-a', name: 'Amoxicillin 500mg', dose: '500mg', unit: 'tabs', category: 'Antibiotics' },
  ] satisfies FormularyEntry[])
}

function renderForm() {
  const onClose = vi.fn()
  const onSaved = vi.fn()
  const utils = render(
    h(EncounterForm, {
      editing: null,
      seedFrom: null,
      allRecords: [],
      deviceId: 'dev-1',
      onSaved,
      onClose,
    }),
  )
  return { onClose, onSaved, ...utils }
}

describe('Dx quick-picks on the visit form', () => {
  it('appends to the diagnosis text on tap and removes only that entry on re-tap', async () => {
    await seedFormConfig()
    renderForm()
    const pill = await screen.findByText('Test Dx')
    const dx = screen.getByLabelText('Diagnosis') as HTMLTextAreaElement

    // Typed narrative first; the pill must APPEND, never replace.
    fireEvent.change(dx, { target: { value: 'Severe dehydration' } })
    fireEvent.click(screen.getByText('Malaria'))
    expect(dx.value).toBe('Severe dehydration; Malaria')
    expect(screen.getByText('Malaria').getAttribute('aria-pressed')).toBe('true')

    // Re-tap removes only the exact quick-pick, keeping the typed text.
    fireEvent.click(screen.getByText('Malaria'))
    expect(dx.value).toBe('Severe dehydration')
    expect(pill.getAttribute('aria-pressed')).toBe('false')
  })

  it('a pill tap alone arms the discard guard (two-writer rule)', async () => {
    await seedFormConfig()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onClose } = renderForm()
    fireEvent.click(await screen.findByText('Malaria'))
    fireEvent.click(screen.getAllByText('Cancel')[0] as HTMLElement)
    expect(confirmSpy).toHaveBeenCalledWith('Discard this visit? Anything you have entered will be lost.')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Rx one-tap apply on the visit form', () => {
  it('appends the bundle as med rows with the computed quantity, never overwriting existing rows', async () => {
    await seedFormConfig()
    const { container } = renderForm()
    const apply = await screen.findByText('Chest infection')

    // A manual row already on the form must survive the apply untouched.
    fireEvent.click(screen.getByText('+ Add medication'))
    expect(container.querySelectorAll('.med-line')).toHaveLength(1)

    fireEvent.click(apply)
    const rows = container.querySelectorAll('.med-line')
    expect(rows).toHaveLength(2)
    const manual = rows[0] as HTMLElement
    const applied = rows[1] as HTMLElement
    expect((within(manual).getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('')
    expect((within(applied).getAllByRole('combobox')[0] as HTMLSelectElement).value).toBe('med-a')
    expect((within(applied).getByPlaceholderText('e.g. 500mg or 2 tabs') as HTMLInputElement).value).toBe('500mg')

    // The dispensing quantity flows through the SAME calcMedQty preview and
    // save-time snapshot as manual entry: 1 tab x 3/day x 7d = 21 tabs.
    expect(within(applied).getByText('21 tabs')).toBeTruthy()

    // The preset's notes appended to the treatment notes.
    expect((screen.getByLabelText('Treatment notes') as HTMLTextAreaElement).value).toBe('Review in 3 days')

    // Applying again APPENDS again - it can never overwrite rows.
    fireEvent.click(apply)
    expect(container.querySelectorAll('.med-line')).toHaveLength(3)
  })

  it('an applied preset arms the discard guard, and discarding stays cancellable', async () => {
    await seedFormConfig()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { onClose } = renderForm()
    fireEvent.click(await screen.findByText('Chest infection'))

    fireEvent.click(screen.getAllByText('Cancel')[0] as HTMLElement)
    expect(confirmSpy).toHaveBeenCalledWith('Discard this visit? Anything you have entered will be lost.')
    expect(onClose).not.toHaveBeenCalled()

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getAllByText('Cancel')[0] as HTMLElement)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// The editors, end to end through the kernel KV
// ---------------------------------------------------------------------------

describe('preset editors', () => {
  it('removing a built-in Dx quick-pick confirms what happens to saved visits, then persists list + hiddenPresets', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(h(PresetEditors, { isAdmin: true }))
    await screen.findByText('Save diagnosis quick-picks')

    const input = screen.getByDisplayValue('Scabies')
    const row = input.closest('.preset-row') as HTMLElement
    fireEvent.click(within(row).getByText('Remove'))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const msg = String(confirmSpy.mock.calls[0]?.[0])
    // The confirm quotes exactly what happens to saved answers.
    expect(msg).toContain('Diagnoses already saved on visits keep their text')
    expect(msg).toContain('stays removed for your organization after sync')

    fireEvent.click(screen.getByText('Save diagnosis quick-picks'))
    await waitFor(async () => {
      const stored = await config.get<string[]>('customDxPresets')
      expect(stored).not.toBeNull()
      expect(stored).not.toContain('Scabies')
      expect(stored).toContain('Malaria')
      const hidden = await config.get<HiddenPresets>('hiddenPresets')
      expect(hidden?.['diagnoses']).toContain('Scabies')
      // The first hiddenPresets write materialized from the defaults, so the
      // default-off lab tests stay hidden.
      expect(hidden?.['labTests']).toContain('COVID-19 Rapid')
    })
  })

  it('editing an Rx preset keeps its medIds verbatim and regenerates the summary', async () => {
    render(h(PresetEditors, { isAdmin: true }))
    await screen.findByText('Save prescription presets')

    const row = screen.getByText('UTI').closest('.preset-row') as HTMLElement
    fireEvent.click(within(row).getByText('Edit'))
    const dose = await screen.findByLabelText('Dose')
    expect((dose as HTMLInputElement).value).toBe('100mg')
    fireEvent.change(dose, { target: { value: '50mg' } })
    fireEvent.click(screen.getByText('Apply changes'))
    fireEvent.click(screen.getByText('Save prescription presets'))

    await waitFor(async () => {
      const stored = await config.get<RxPreset[]>('rxPresets')
      const uti = stored?.find((p) => p.name === 'UTI')
      expect(uti).toBeDefined()
      // The permanent id is untouched: every prescription ever written from
      // this preset still points at the same drug.
      expect(uti?.meds[0]?.medId).toBe('abx-nitro')
      expect(uti?.meds[0]?.dose).toBe('50mg')
      expect(uti?.rx).toContain('Nitrofurantoin')
      expect(uti?.rx).toContain('50mg')
    })
  })

  it('refuses to save an empty list (it would silently resolve back to the defaults)', async () => {
    await config.set('customDxPresets', ['Only one'])
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(h(PresetEditors, { isAdmin: true }))
    await screen.findByText('Save diagnosis quick-picks')

    const row = (screen.getByDisplayValue('Only one').closest('.preset-row')) as HTMLElement
    fireEvent.click(within(row).getByText('Remove'))
    expect(confirmSpy).toHaveBeenCalled()
    fireEvent.click(screen.getByText('Save diagnosis quick-picks'))
    await screen.findByText(
      'The diagnosis quick-picks cannot be saved empty. Hide entries instead if you do not want them on the visit form.',
    )
    expect(await config.get('customDxPresets')).toEqual(['Only one'])
  })

  it('non-admin devices see disabled controls WITH the reason on them, never silent ignores', async () => {
    render(h(PresetEditors, { isAdmin: false }))
    const save = await screen.findByText('Save diagnosis quick-picks')
    const reason = 'Only an admin device can change this. This device is set to standard.'
    expect(screen.getAllByText(reason)).toHaveLength(2) // one gate note per card
    expect((save as HTMLButtonElement).disabled).toBe(true)
    expect(save.getAttribute('title')).toBe(reason)
    const rxSave = screen.getByText('Save prescription presets') as HTMLButtonElement
    expect(rxSave.disabled).toBe(true)
    expect(rxSave.getAttribute('title')).toBe(reason)
  })
})
