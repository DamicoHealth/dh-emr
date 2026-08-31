/**
 * The form template builder - full CRUD over the org's visit-form library.
 * Every guard here is a rule from REBUILD-HANDOFF section 6, each one a
 * shipped bug:
 *  - template ids/field ids are permanent; duplicates mint FRESH custom ids
 *  - deleting a template/section/field keeps saved answers, and every delete
 *    confirm says exactly that
 *  - an empty choices list is refused at persist time (nothing written)
 *  - new custom sections always land at the END of the form
 *  - encounter + patient stay visible; the control is disabled with a reason
 *  - collapsed-by-default only for sections without required fields
 *  - the library always keeps one template and one ENABLED template
 *  - formSchema mirrors the first ENABLED template on every save
 *  - a synthesized library (org config not yet synced) is read-only
 *  - admin-device-only editing, disabled-with-reason, never silently ignored
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetStorage } from './setup'
import { config } from '../src/kernel'
import { getConfig, saveLibrary, setConfig } from '../src/config/keys'
import { getEffectiveSchema } from '../src/config/sections'
import { EMPTY_OPTIONS_WARNING, isCollapsibleSection } from '../src/config/validate'
import type { FormTemplateLibrary, RawSection } from '../src/config/types'
import TemplateBuilder from '../src/ui/templates/TemplateBuilder'
import {
  COLLAPSED_LOCK_REASON,
  GATE_REASON,
  LAST_ENABLED_MESSAGE,
  LAST_TEMPLATE_MESSAGE,
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  fieldDeleteConfirm,
  moveId,
  renameTemplate,
  resetSectionTitle,
  sectionDeleteConfirm,
  setSectionCollapsed,
  setTemplateEnabled,
  templateDeleteConfirm,
} from '../src/ui/templates/libraryOps'

const h = React.createElement

/**
 * Two templates, both enabled. "Community Screening" carries a REQUIRED
 * select (the empty-options and collapse-lock guards), "Triage Extras" has
 * no required field (the collapse-allowed path).
 */
function seedLib(): FormTemplateLibrary {
  return {
    version: 1,
    templates: [
      {
        id: 'general',
        name: 'General Visit',
        enabled: true,
        schema: {
          sections: [
            {
              id: 's_screen',
              title: 'Community Screening',
              order: 16,
              fields: [
                {
                  id: 'f_choice',
                  label: 'Water source',
                  type: 'select',
                  options: ['Well', 'River'],
                  required: true,
                },
                { id: 'f_notes2', label: 'Extra detail', type: 'text' },
              ],
            },
            {
              id: 's_triage',
              title: 'Triage Extras',
              order: 17,
              fields: [{ id: 'f_danger', label: 'Danger signs', type: 'yesno' }],
            },
          ],
        },
      },
      {
        id: 'dental',
        name: 'Dental Clinic',
        enabled: true,
        schema: {
          sections: [
            {
              id: 's_dental',
              title: 'Dental Exam',
              order: 16,
              fields: [{ id: 'f_teeth', label: 'Teeth count', type: 'number' }],
            },
          ],
        },
      },
    ],
  }
}

async function seed(lib: FormTemplateLibrary = seedLib()): Promise<void> {
  await setConfig(config, 'formTemplates', lib)
}

const readLib = async (): Promise<FormTemplateLibrary | null> =>
  await getConfig(config, 'formTemplates')

const readMirror = async (): Promise<{ sections: RawSection[] } | null> =>
  await getConfig(config, 'formSchema')

function sectionsOf(lib: FormTemplateLibrary | null, templateId: string): RawSection[] {
  const t = lib?.templates.find((x) => x.id === templateId)
  return t?.schema.sections ?? []
}

/** No jest-dom in this suite; read the DOM property directly. */
function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement).disabled
}

async function openBuilder(isAdmin = true): Promise<void> {
  render(h(TemplateBuilder, { isAdmin, onClose: vi.fn() }))
  await screen.findByText('Forms')
}

beforeEach(async () => {
  await resetStorage()
  await config.remove('formTemplates')
  await config.remove('formSchema')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Pure library operations
// ---------------------------------------------------------------------------

describe('template CRUD operations (pure)', () => {
  it('createTemplate appends a fresh enabled template with an empty schema', () => {
    const r = createTemplate(seedLib(), '  Antenatal  ')
    expect(r.refusal).toBeNull()
    const added = r.lib.templates[2]!
    expect(added.name).toBe('Antenatal')
    expect(added.enabled).toBe(true)
    expect(added.schema.sections).toEqual([])
    expect(added.id.startsWith('tpl_')).toBe(true)
    expect(added.id).not.toBe('general')
    expect(r.focusId).toBe(added.id)
  })

  it('duplicateTemplate mints NEW custom-section and field ids so answers never cross-link', () => {
    const src = seedLib()
    const r = duplicateTemplate(src, 'general')
    expect(r.refusal).toBeNull()
    const copy = r.lib.templates[2]!
    expect(copy.name).toBe('General Visit (copy)')
    expect(copy.enabled).toBe(true)
    const copySections = copy.schema.sections
    expect(copySections).toHaveLength(2)
    // Same shape, different identities.
    expect(copySections[0]!.title).toBe('Community Screening')
    expect(copySections[0]!.id).not.toBe('s_screen')
    expect(copySections[0]!.id.startsWith('s_')).toBe(true)
    const copyFieldIds = copySections.flatMap((s) => (s.fields ?? []).map((f) => f.id))
    for (const id of copyFieldIds) {
      expect(['f_choice', 'f_notes2', 'f_danger']).not.toContain(id)
      expect(id.startsWith('f_')).toBe(true)
    }
    // Field CONTENT survives the copy.
    expect(copySections[0]!.fields![0]!.options).toEqual(['Well', 'River'])
    // The original is untouched.
    expect(r.lib.templates[0]).toEqual(src.templates[0])
  })

  it('renameTemplate trims, and a blank name keeps the old one', () => {
    expect(renameTemplate(seedLib(), 'general', '  Outreach  ').templates[0]!.name).toBe('Outreach')
    expect(renameTemplate(seedLib(), 'general', '   ').templates[0]!.name).toBe('General Visit')
  })

  it('refuses to switch off the last enabled template', () => {
    const one = setTemplateEnabled(seedLib(), 'dental', false)
    expect(one.refusal).toBeNull()
    const r = setTemplateEnabled(one.lib, 'general', false)
    expect(r.refusal).toBe(LAST_ENABLED_MESSAGE)
    expect(r.lib.templates[0]!.enabled).toBe(true) // unchanged
  })

  it('refuses to delete the last template', () => {
    const lib: FormTemplateLibrary = { version: 1, templates: [seedLib().templates[0]!] }
    const r = deleteTemplate(lib, 'general')
    expect(r.refusal).toBe(LAST_TEMPLATE_MESSAGE)
    expect(r.lib.templates).toHaveLength(1)
  })

  it('deleting the only enabled template turns another on, so a visit form always exists', () => {
    const start = setTemplateEnabled(seedLib(), 'dental', false).lib
    const r = deleteTemplate(start, 'general')
    expect(r.refusal).toBeNull()
    expect(r.autoEnabled).toBe('Dental Clinic')
    expect(r.lib.templates).toHaveLength(1)
    expect(r.lib.templates[0]!.enabled).toBe(true)
  })

  it('resetSectionTitle removes the override, dropping one that held only a title', () => {
    const raw = {
      sections: [
        { id: 'vitals', title: 'Vital Signs' },
        { id: 'notes', title: 'Extra Notes', hidden: true },
      ] as RawSection[],
    }
    const afterVitals = resetSectionTitle(raw, 'vitals')
    expect(afterVitals.sections.find((s) => s.id === 'vitals')).toBeUndefined()
    const afterNotes = resetSectionTitle(afterVitals, 'notes')
    // hidden survives; only the title reverts.
    expect(afterNotes.sections.find((s) => s.id === 'notes')).toEqual({ id: 'notes', hidden: true })
  })

  it('setSectionCollapsed writes on custom sections and never on built-in ids', () => {
    const raw = {
      sections: [{ id: 's_triage', title: 'Triage Extras' }, { id: 'vitals' }] as RawSection[],
    }
    const next = setSectionCollapsed(setSectionCollapsed(raw, 's_triage', false), 'vitals', false)
    expect(next.sections.find((s) => s.id === 's_triage')!.collapsed).toBe(false)
    expect(next.sections.find((s) => s.id === 'vitals')!.collapsed).toBeUndefined()
  })

  it('collapsed-by-default is honored only for sections without required fields', () => {
    const noRequired = {
      id: 's_x',
      builtin: false,
      fields: [{ id: 'f_1', label: 'Q', type: 'text' as const }],
    }
    expect(isCollapsibleSection({ ...noRequired })).toBe(true) // absent = collapsed
    expect(isCollapsibleSection({ ...noRequired, collapsed: false })).toBe(false)
    const withRequired = {
      id: 's_y',
      builtin: false,
      fields: [{ id: 'f_2', label: 'Q', type: 'text' as const, required: true }],
    }
    // Required fields WIN over any stored flag.
    expect(isCollapsibleSection(withRequired)).toBe(false)
    expect(isCollapsibleSection({ ...withRequired, collapsed: true })).toBe(false)
  })

  it('moveId swaps with the nearest movable neighbour and stops at the ends', () => {
    const full = ['a', 'skip', 'b', 'c']
    const movable = ['a', 'b', 'c']
    expect(moveId(full, movable, 'b', -1)).toEqual(['b', 'skip', 'a', 'c'])
    expect(moveId(full, movable, 'a', -1)).toBeNull()
    expect(moveId(full, movable, 'c', 1)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Persistence contract
// ---------------------------------------------------------------------------

describe('saveLibrary mirrors the first ENABLED template to formSchema', () => {
  it('mirrors templates[0] while it is enabled', async () => {
    await saveLibrary(config, seedLib())
    expect((await readMirror())?.sections).toEqual(seedLib().templates[0]!.schema.sections)
  })

  it('mirrors the next enabled template when templates[0] is off', async () => {
    const lib = seedLib()
    lib.templates[0]!.enabled = false
    await saveLibrary(config, lib)
    // A legacy client has no concept of a disabled template; it must get the
    // form the org actually uses.
    expect((await readMirror())?.sections).toEqual(seedLib().templates[1]!.schema.sections)
  })
})

// ---------------------------------------------------------------------------
// The builder UI
// ---------------------------------------------------------------------------

describe('template list (CRUD through the UI)', () => {
  it('creates a new enabled template at the end of the library', async () => {
    await seed()
    await openBuilder()
    fireEvent.change(screen.getByLabelText('New form name'), { target: { value: 'Antenatal' } })
    fireEvent.click(screen.getByText('Add form'))
    await waitFor(async () => {
      const lib = await readLib()
      expect(lib?.templates).toHaveLength(3)
      expect(lib?.templates[2]?.name).toBe('Antenatal')
      expect(lib?.templates[2]?.enabled).toBe(true)
    })
  })

  it('duplicates with fresh ids and persists the copy', async () => {
    await seed()
    await openBuilder()
    fireEvent.click(screen.getByLabelText('Duplicate form 1'))
    await waitFor(async () => {
      const lib = await readLib()
      expect(lib?.templates).toHaveLength(3)
      const copy = lib!.templates[2]!
      expect(copy.name).toBe('General Visit (copy)')
      expect(copy.schema.sections.map((s) => s.id)).not.toContain('s_screen')
      const ids = copy.schema.sections.flatMap((s) => (s.fields ?? []).map((f) => f.id))
      expect(ids).not.toContain('f_choice')
    })
    // The original template kept its ids: records answer under them.
    const lib = await readLib()
    expect(sectionsOf(lib, 'general').map((s) => s.id)).toEqual(['s_screen', 's_triage'])
  })

  it('renames a template in place', async () => {
    await seed()
    await openBuilder()
    const input = screen.getByLabelText('Form 2 name')
    fireEvent.change(input, { target: { value: 'Dental Outreach' } })
    fireEvent.blur(input)
    await waitFor(async () => {
      expect((await readLib())?.templates[1]?.name).toBe('Dental Outreach')
    })
    // The id never changes with the name: records point at it forever.
    expect((await readLib())?.templates[1]?.id).toBe('dental')
  })

  it('delete confirm states that visits keep their answers and their template name', async () => {
    await seed()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openBuilder()
    fireEvent.click(screen.getByLabelText('Delete form 2'))
    expect(confirmSpy).toHaveBeenCalledWith(templateDeleteConfirm('Dental Clinic'))
    expect(confirmSpy.mock.calls[0]![0]).toContain(
      'keep their answers and their template name',
    )
    // Cancel persisted NOTHING.
    expect(await readLib()).toEqual(seedLib())

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('Delete form 2'))
    await waitFor(async () => {
      expect((await readLib())?.templates.map((t) => t.id)).toEqual(['general'])
    })
  })

  it('refuses, with a message, to switch off the last enabled template', async () => {
    const lib = seedLib()
    lib.templates[1]!.enabled = false
    await seed(lib)
    await openBuilder()
    fireEvent.click(screen.getByLabelText('Form 1 on'))
    await screen.findByText(LAST_ENABLED_MESSAGE)
    expect((await readLib())?.templates[0]?.enabled).toBe(true) // unchanged, nothing saved
  })

  it('keeps the formSchema mirror on the first ENABLED template as toggles change', async () => {
    await seed()
    await saveLibrary(config, seedLib()) // establish the mirror
    await openBuilder()
    fireEvent.click(screen.getByLabelText('Form 1 on')) // turn General Visit off
    await waitFor(async () => {
      expect((await readLib())?.templates[0]?.enabled).toBe(false)
      expect((await readMirror())?.sections).toEqual(seedLib().templates[1]!.schema.sections)
    })
  })
})

describe('section editor', () => {
  it('lists the built-ins in canonical order and excludes the bodyless ones', async () => {
    await seed()
    await openBuilder()
    const titles = screen
      .getAllByLabelText(/^Rename the .+ section$/)
      .map((el) => (el as HTMLInputElement).value)
    expect(titles).toEqual([
      'Visit',
      'Patient',
      'Vitals',
      'History',
      'Chief Concern',
      'Labs',
      'Diagnosis',
      'Medications',
      'Procedures',
      'Referral',
      'Imaging',
      'Surgery',
      'Notes',
      'Community Screening',
      'Triage Extras',
    ])
    // The compat-only sections are named in the note, not offered as controls.
    expect(screen.getByText(/kept for compatibility/).textContent).toContain('Access to Care')
  })

  it('reorders with the up button and persists an explicit order on every section', async () => {
    await seed()
    await openBuilder()
    fireEvent.click(screen.getByLabelText('Move Vitals up'))
    await waitFor(async () => {
      const stored = sectionsOf(await readLib(), 'general')
      expect(stored.find((s) => s.id === 'vitals')?.order).toBe(1)
      expect(stored.find((s) => s.id === 'patient')?.order).toBe(2)
    })
    const effective = getEffectiveSchema({ sections: sectionsOf(await readLib(), 'general') })
    const ids = effective.sections.map((s) => s.id)
    expect(ids.indexOf('vitals')).toBeLessThan(ids.indexOf('patient'))
  })

  it('locks Visit and Patient visible, with the reason on the disabled control', async () => {
    await seed()
    await openBuilder()
    for (const name of ['Visit', 'Patient']) {
      const control = screen.getByLabelText(`Hide the ${name} section`)
      expect(isDisabled(control)).toBe(true)
      expect(control.getAttribute('title')).toContain('cannot be hidden')
      expect(control.textContent).toBe('Always shown')
    }
    // A non-required built-in CAN be hidden.
    fireEvent.click(screen.getByLabelText('Hide the Notes section'))
    await waitFor(async () => {
      expect(
        sectionsOf(await readLib(), 'general').find((s) => s.id === 'notes')?.hidden,
      ).toBe(true)
    })
  })

  it('renames a built-in and reverts to the default name by dropping the override', async () => {
    await seed()
    await openBuilder()
    const input = screen.getByLabelText('Rename the Vitals section')
    fireEvent.change(input, { target: { value: 'Vital Signs' } })
    fireEvent.blur(input)
    await waitFor(async () => {
      expect(
        sectionsOf(await readLib(), 'general').find((s) => s.id === 'vitals')?.title,
      ).toBe('Vital Signs')
    })
    fireEvent.click(await screen.findByText('Reset name'))
    await waitFor(async () => {
      // The whole override is gone, not rewritten with today's default.
      expect(
        sectionsOf(await readLib(), 'general').find((s) => s.id === 'vitals'),
      ).toBeUndefined()
    })
    expect(
      (screen.getByLabelText('Rename the Vitals section') as HTMLInputElement).value,
    ).toBe('Vitals')
  })

  it('adds a custom section at the END of the form, never mid-form', async () => {
    await seed()
    await openBuilder()
    fireEvent.click(screen.getByText('Add a section'))
    await waitFor(async () => {
      const stored = sectionsOf(await readLib(), 'general')
      expect(stored).toHaveLength(3)
      const added = stored[2]!
      expect(added.title).toBe('New section')
      // Seeded customs sit at 16 and 17; the new one lands after them.
      expect(added.order).toBe(18)
    })
    const effective = getEffectiveSchema({ sections: sectionsOf(await readLib(), 'general') })
    expect(effective.sections[effective.sections.length - 1]?.title).toBe('New section')
  })

  it('section delete confirm quotes the answers-are-kept rule; cancel persists nothing', async () => {
    await seed()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openBuilder()
    fireEvent.click(screen.getByLabelText('Delete the Community Screening section'))
    expect(confirmSpy).toHaveBeenCalledWith(sectionDeleteConfirm('Community Screening', 2))
    expect(confirmSpy.mock.calls[0]![0]).toContain(
      'Answers already saved on existing records are kept',
    )
    expect(await readLib()).toEqual(seedLib())

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('Delete the Community Screening section'))
    await waitFor(async () => {
      expect(sectionsOf(await readLib(), 'general').map((s) => s.id)).toEqual(['s_triage'])
    })
  })

  it('disables collapsed-by-default when the section has a required field, reason shown', async () => {
    await seed()
    await openBuilder()
    // Community Screening carries the required select: locked open.
    const locked = screen.getByLabelText('Starts collapsed: Community Screening')
    expect(isDisabled(locked)).toBe(true)
    expect((locked as HTMLInputElement).checked).toBe(false)
    expect(locked.closest('label')?.getAttribute('title')).toBe(COLLAPSED_LOCK_REASON)
    expect(screen.getAllByText(COLLAPSED_LOCK_REASON).length).toBeGreaterThan(0)

    // Triage Extras has no required field: the preference is editable.
    const free = screen.getByLabelText('Starts collapsed: Triage Extras')
    expect(isDisabled(free)).toBe(false)
    expect((free as HTMLInputElement).checked).toBe(true)
    fireEvent.click(free)
    await waitFor(async () => {
      expect(
        sectionsOf(await readLib(), 'general').find((s) => s.id === 's_triage')?.collapsed,
      ).toBe(false)
    })
    const effective = getEffectiveSchema({ sections: sectionsOf(await readLib(), 'general') })
    expect(isCollapsibleSection(effective.sections.find((s) => s.id === 's_triage')!)).toBe(false)
  })
})

describe('field editor', () => {
  async function openQuestions(section = 'Community Screening'): Promise<void> {
    await openBuilder()
    // The Questions toggle sits inside the section's row.
    const row = screen
      .getByLabelText(`Delete the ${section} section`)
      .closest('li') as HTMLElement
    fireEvent.click(
      Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Questions')!,
    )
  }

  it('shows the field id read-only with the permanence note', async () => {
    await seed()
    await openQuestions()
    expect(screen.getByText('f_choice')).toBeTruthy()
    expect(screen.getAllByText(/field id is permanent/).length).toBeGreaterThan(0)
    // The id is rendered as text, not as an editable control.
    expect(screen.queryByDisplayValue('f_choice')).toBeNull()
  })

  it('edits a label in place, keeping the id so saved answers stay linked', async () => {
    await seed()
    await openQuestions()
    const input = screen.getByLabelText('Question label: Water source')
    fireEvent.change(input, { target: { value: 'Drinking water source' } })
    fireEvent.blur(input)
    await waitFor(async () => {
      const fields = sectionsOf(await readLib(), 'general').find((s) => s.id === 's_screen')!
        .fields!
      expect(fields[0]).toMatchObject({ id: 'f_choice', label: 'Drinking water source' })
    })
  })

  it('REFUSES to persist an empty choices list: inline error, nothing written', async () => {
    await seed()
    await openQuestions()
    fireEvent.click(screen.getByText('Choices'))
    const box = screen.getByLabelText('Choices for Water source, one per line')
    fireEvent.change(box, { target: { value: '   \n  ' } })
    fireEvent.blur(box)
    await screen.findByText(EMPTY_OPTIONS_WARNING)
    // NOTHING was persisted - the stored library is byte-identical.
    expect(await readLib()).toEqual(seedLib())
    // And the previous choices came back into the editor.
    expect((box as HTMLTextAreaElement).value).toBe('Well\nRiver')
  })

  it('commits a cleaned choices list on blur', async () => {
    await seed()
    await openQuestions()
    fireEvent.click(screen.getByText('Choices'))
    const box = screen.getByLabelText('Choices for Water source, one per line')
    fireEvent.change(box, { target: { value: ' Well \nRiver\nWell\n\nSpring ' } })
    fireEvent.blur(box)
    await waitFor(async () => {
      const f = sectionsOf(await readLib(), 'general')
        .find((s) => s.id === 's_screen')!
        .fields!.find((x) => x.id === 'f_choice')!
      expect(f.options).toEqual(['Well', 'River', 'Spring'])
    })
  })

  it('adds questions of the structured types with answerable defaults', async () => {
    await seed()
    await openQuestions('Triage Extras')
    fireEvent.change(screen.getByLabelText('New question label'), {
      target: { value: 'Pain score' },
    })
    fireEvent.change(screen.getByLabelText('New question type'), { target: { value: 'range' } })
    fireEvent.click(screen.getByText('Add question'))
    await waitFor(async () => {
      const fields = sectionsOf(await readLib(), 'general').find((s) => s.id === 's_triage')!
        .fields!
      const added = fields[fields.length - 1]!
      expect(added).toMatchObject({ label: 'Pain score', type: 'range', min: 0, max: 10 })
      expect(added.id.startsWith('f_')).toBe(true)
    })

    fireEvent.change(screen.getByLabelText('New question label'), {
      target: { value: 'Referral reason' },
    })
    fireEvent.change(screen.getByLabelText('New question type'), { target: { value: 'select' } })
    fireEvent.click(screen.getByText('Add question'))
    await waitFor(async () => {
      const fields = sectionsOf(await readLib(), 'general').find((s) => s.id === 's_triage')!
        .fields!
      // A select is born with real choices, never optionless.
      expect(fields[fields.length - 1]).toMatchObject({
        type: 'select',
        options: ['Option 1', 'Option 2'],
      })
    })
  })

  it('field delete confirm quotes answer retention; cancel persists nothing', async () => {
    await seed()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await openQuestions()
    fireEvent.click(screen.getByLabelText('Remove the Water source question'))
    expect(confirmSpy).toHaveBeenCalledWith(fieldDeleteConfirm('Water source'))
    expect(confirmSpy.mock.calls[0]![0]).toContain(
      'Answers already saved on existing records are kept',
    )
    expect(await readLib()).toEqual(seedLib())

    confirmSpy.mockReturnValue(true)
    fireEvent.click(screen.getByLabelText('Remove the Water source question'))
    await waitFor(async () => {
      const fields = sectionsOf(await readLib(), 'general').find((s) => s.id === 's_screen')!
        .fields!
      expect(fields.map((f) => f.id)).toEqual(['f_notes2'])
    })
  })
})

describe('read-only guards', () => {
  it('a synthesized library disables the whole builder behind a banner', async () => {
    // Nothing stored: loadLibraryDetailed fabricates General Encounter and
    // flags it synthesized. Saving it would replace the org's real form.
    await openBuilder()
    await screen.findByText('Form settings have not reached this device yet')
    expect(isDisabled(screen.getByText('Add form'))).toBe(true)
    expect(isDisabled(screen.getByText('Add a section'))).toBe(true)
    expect(isDisabled(screen.getByLabelText('Form 1 on'))).toBe(true)
    expect(isDisabled(screen.getByLabelText('Rename the Vitals section'))).toBe(true)
    // Nothing was written by merely opening it.
    expect(await readLib()).toBeNull()
    expect(await readMirror()).toBeNull()
  })

  it('a standard device gets every control disabled with the admin reason on it', async () => {
    await seed()
    await openBuilder(false)
    await screen.findByText('Read only')
    expect(screen.getAllByText(GATE_REASON).length).toBeGreaterThan(0)
    for (const label of ['New form name', 'Form 1 name', 'Rename the Vitals section']) {
      const el = screen.getByLabelText(label)
      expect(isDisabled(el)).toBe(true)
      expect(el.getAttribute('title')).toBe(GATE_REASON)
    }
    expect(isDisabled(screen.getByLabelText('Delete form 1'))).toBe(true)
    expect(isDisabled(screen.getByLabelText('Duplicate form 1'))).toBe(true)
    expect(await readLib()).toEqual(seedLib()) // untouched
  })
})
