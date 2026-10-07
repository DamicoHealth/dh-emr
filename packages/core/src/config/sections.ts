/**
 * The form-schema engine: built-in sections, sparse-override resolution, and
 * every builder mutation, ported from the previous implementation.
 *
 * DATA COMPATIBILITY IS THE POINT. Orgs already have templates stored in the
 * synced `formTemplates` config key, and existing records reference field ids
 * inside `customFields`. So:
 *   - the stored JSON shape is unchanged
 *   - field ids are STABLE: editing a field keeps its id, or previously saved
 *     answers orphan (the legacy builder forced delete + re-add, which did
 *     exactly that)
 *   - saving mirrors templates[0].schema back to the legacy `formSchema` key
 *     (see saveLibrary in keys.ts), so an older client still reads the form
 */
import type {
  CustomField,
  EffectiveSection,
  FormTemplateLibrary,
  RawSection,
  SectionRoles,
} from './types'

export type {
  CustomField,
  CustomValue,
  EffectiveSection,
  FieldType,
  FormTemplate,
  FormTemplateLibrary,
  RawSection,
  SectionRoles,
  TemplateLibrary,
} from './types'
export { FIELD_TYPES } from './types'

/**
 * The 16 built-in clinical sections, in their canonical order.
 *
 * LOAD-BEARING ORDER: the array index IS the default render order. Do not
 * alphabetize or renumber - addCustomSection seeds from the array length, and
 * saved schemas assume 'encounter' is index 0 and 'notes' is index 15.
 *
 * `notOnForm` marks a section the encounter form has no rendered body for
 * (i.e. hasBody would be false: accessToCare, rxPresets, physician). They stay
 * in the list so a schema saved by the legacy app round-trips unchanged, but
 * the builder must not offer them as arrangeable: an admin who reordered or
 * renamed "Rx Presets" saw nothing change on the form, because the encounter
 * form has no body for it and silently drops it.
 */
export const BUILTIN_SECTIONS: {
  id: string
  title: string
  required?: boolean
  notOnForm?: boolean
}[] = [
  { id: 'encounter', title: 'Visit', required: true },
  { id: 'patient', title: 'Patient', required: true },
  { id: 'vitals', title: 'Vitals' },
  { id: 'accessToCare', title: 'Access to Care', notOnForm: true },
  { id: 'history', title: 'History' },
  { id: 'chiefConcern', title: 'Chief Concern' },
  { id: 'labs', title: 'Labs' },
  { id: 'diagnosis', title: 'Diagnosis' },
  { id: 'rxPresets', title: 'Rx Presets', notOnForm: true },
  { id: 'medications', title: 'Medications' },
  { id: 'procedures', title: 'Procedures' },
  { id: 'referral', title: 'Referral' },
  { id: 'physician', title: 'Provider', notOnForm: true },
  { id: 'imaging', title: 'Imaging' },
  { id: 'surgery', title: 'Surgery' },
  { id: 'notes', title: 'Notes' },
]

const BUILTIN_IDS = new Set(BUILTIN_SECTIONS.map((s) => s.id))

export function uid(prefix: string): string {
  const r =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return prefix + r
}

/** Back-compat: a lone legacy `formSchema` becomes one "General Encounter". */
export function normalizeLibrary(templates: unknown, legacySchema: unknown): FormTemplateLibrary {
  const t = templates as FormTemplateLibrary | null
  if (t && Array.isArray(t.templates) && t.templates.length) {
    return { version: t.version || 1, templates: t.templates }
  }
  const legacy = legacySchema as { sections?: RawSection[] } | null
  const schema =
    legacy && Array.isArray(legacy.sections) ? { sections: legacy.sections } : { sections: [] }
  // Gives a brand-new org an empty General Encounter rather than nothing;
  // an empty schema renders all 16 built-ins.
  return { version: 1, templates: [{ id: 'general', name: 'General Encounter', enabled: true, schema }] }
}

/**
 * Resolve a stored schema into the ordered section list to render.
 * Built-ins default to their canonical index; custom sections default to
 * 100+i. Sorting by `order` interleaves them, so a custom section placed at
 * order 3 appears mid-form during ENTRY as well as in the chart - the legacy
 * live form always dumped every custom section at the end regardless of order.
 */
export function getEffectiveSchema(raw: { sections?: RawSection[] } | null | undefined): {
  version: number
  sections: EffectiveSection[]
} {
  const overrides: Record<string, RawSection> = {}
  const customSections: RawSection[] = []
  if (raw && Array.isArray(raw.sections)) {
    for (const s of raw.sections) {
      if (!s || !s.id) continue
      if (BUILTIN_IDS.has(s.id)) overrides[s.id] = s
      else customSections.push(s)
    }
  }
  const builtins: EffectiveSection[] = BUILTIN_SECTIONS.map((b, i) => {
    const o: Partial<RawSection> = overrides[b.id] ?? {}
    return {
      id: b.id,
      title: o.title || b.title,
      required: !!b.required,
      builtin: true,
      // Required sections can never be hidden. The stored override may still
      // say hidden: true and must be IGNORED here, not rewritten.
      hidden: b.required ? false : !!o.hidden,
      order: typeof o.order === 'number' ? o.order : i,
      fields: [],
      notOnForm: !!b.notOnForm,
      // The role override rides along untouched; src/config/roles resolves
      // it. Only set when stored, so a schema without one is unchanged.
      ...(o.roles ? { roles: o.roles } : {}),
    }
  })
  const custom: EffectiveSection[] = customSections.map((s, i) => ({
    id: s.id,
    title: s.title || 'Custom Section',
    required: false,
    builtin: false,
    hidden: !!s.hidden,
    order: typeof s.order === 'number' ? s.order : 100 + i,
    fields: Array.isArray(s.fields) ? s.fields : [],
    // Pass the stored collapsed-by-default preference through untouched;
    // isCollapsibleSection (src/config/validate) decides what it may mean.
    collapsed: s.collapsed,
    ...(s.roles ? { roles: s.roles } : {}),
  }))
  return {
    version: 1,
    sections: [...builtins, ...custom].sort((a, b) => a.order - b.order),
  }
}

/**
 * Ids of every custom field the given schema RENDERS (visible custom sections
 * only). Hidden sections are excluded ON PURPOSE: their answers must be
 * preserved through mergeCustomFields on save, not cleared.
 */
export function activeCustomFieldIds(sections: EffectiveSection[]): string[] {
  const ids: string[] = []
  for (const s of sections) {
    if (s.builtin || s.hidden) continue
    for (const f of s.fields) if (f?.id) ids.push(f.id)
  }
  return ids
}

/**
 * Persist an explicit `order` on EVERY section after a reorder, so the stored
 * schema is unambiguous and a later render cannot fall back to index defaults.
 * Built-ins with no stored override get one materialized ({ id, order }).
 */
export function reorderSections(
  raw: { sections: RawSection[] },
  orderedIds: string[],
): { sections: RawSection[] } {
  const bySection = new Map<string, RawSection>()
  for (const s of raw.sections || []) if (s?.id) bySection.set(s.id, s)
  const out: RawSection[] = []
  orderedIds.forEach((id, i) => {
    const existing = bySection.get(id)
    if (existing) out.push({ ...existing, order: i })
    else if (BUILTIN_IDS.has(id)) out.push({ id, order: i }) // materialize the override
    bySection.delete(id)
  })
  // Anything stored but not listed keeps its entry, appended.
  let n = orderedIds.length
  for (const s of bySection.values()) out.push({ ...s, order: n++ })
  return { sections: out }
}

/** Move a field within its section, preserving ids (and therefore answers). */
export function reorderFields(
  raw: { sections: RawSection[] },
  sectionId: string,
  orderedFieldIds: string[],
): { sections: RawSection[] } {
  return {
    sections: (raw.sections || []).map((s) => {
      if (s.id !== sectionId || !Array.isArray(s.fields)) return s
      const byId = new Map<string, CustomField>(s.fields.map((f) => [f.id, f]))
      const fields: CustomField[] = []
      for (const id of orderedFieldIds) {
        const f = byId.get(id)
        if (f) fields.push(f)
      }
      // Any field missing from the ordered list is appended, never dropped.
      for (const f of s.fields) if (!orderedFieldIds.includes(f.id)) fields.push(f)
      return { ...s, fields }
    }),
  }
}

/**
 * Update a field IN PLACE. The id never changes, so saved answers stay linked.
 * The trailing `id: f.id` comes AFTER the patch spread on purpose: even a
 * patch containing `id` cannot overwrite it. Moving it before the spread
 * reintroduces the orphaned-answers bug the tests exist for.
 */
export function updateField(
  raw: { sections: RawSection[] },
  sectionId: string,
  fieldId: string,
  patch: Partial<CustomField>,
): { sections: RawSection[] } {
  return {
    sections: (raw.sections || []).map((s) =>
      s.id !== sectionId || !Array.isArray(s.fields)
        ? s
        : {
            ...s,
            fields: s.fields.map((f) => (f.id === fieldId ? { ...f, ...patch, id: f.id } : f)),
          },
    ),
  }
}

/** Hide/show a section, materializing a sparse override if none is stored. */
export function setSectionHidden(
  raw: { sections: RawSection[] },
  sectionId: string,
  hidden: boolean,
): { sections: RawSection[] } {
  const sections = [...(raw.sections || [])]
  const i = sections.findIndex((s) => s.id === sectionId)
  const existing = i >= 0 ? sections[i] : undefined
  if (existing) sections[i] = { ...existing, hidden }
  else sections.push({ id: sectionId, hidden })
  return { sections }
}

/**
 * Store a role access override on a section, materializing a sparse override
 * for a built-in with none stored. Same persistence path as every other
 * section edit (saveLibrary); ids are never touched.
 */
export function setSectionRoles(
  raw: { sections: RawSection[] },
  sectionId: string,
  roles: SectionRoles,
): { sections: RawSection[] } {
  const sections = [...(raw.sections || [])]
  const i = sections.findIndex((s) => s.id === sectionId)
  const existing = i >= 0 ? sections[i] : undefined
  if (existing) sections[i] = { ...existing, roles }
  else sections.push({ id: sectionId, roles })
  return { sections }
}

/**
 * "Reset to default": REMOVE the stored role override so the shipped defaults
 * apply again (not write the defaults as an override, which would pin
 * today's defaults forever). A built-in override left with nothing but its
 * id is dropped, keeping the stored schema sparse; custom sections keep
 * their entry.
 */
export function clearSectionRoles(
  raw: { sections: RawSection[] },
  sectionId: string,
): { sections: RawSection[] } {
  const sections: RawSection[] = []
  for (const s of raw.sections || []) {
    if (s.id !== sectionId) {
      sections.push(s)
      continue
    }
    const { roles: _dropped, ...rest } = s
    const meaningful = !BUILTIN_IDS.has(s.id) || Object.keys(rest).some((k) => k !== 'id')
    if (meaningful) sections.push(rest)
  }
  return { sections }
}

/** Rename a section, materializing a sparse override if none is stored. */
export function setSectionTitle(
  raw: { sections: RawSection[] },
  sectionId: string,
  title: string,
): { sections: RawSection[] } {
  const sections = [...(raw.sections || [])]
  const i = sections.findIndex((s) => s.id === sectionId)
  const existing = i >= 0 ? sections[i] : undefined
  if (existing) sections[i] = { ...existing, title }
  else sections.push({ id: sectionId, title })
  return { sections }
}

/**
 * Append a new custom section AFTER everything currently shown. Built-ins that
 * carry no explicit override still occupy orders 0..15, so the max-order seed
 * starts at BUILTIN_SECTIONS.length - 1; seeding from the stored sections
 * alone would drop a new section into the middle of the form.
 */
export function addCustomSection(
  raw: { sections: RawSection[] },
  title: string,
): { sections: RawSection[] } {
  const maxOrder = (raw.sections || []).reduce(
    (m, s) => Math.max(m, s.order ?? 0),
    BUILTIN_SECTIONS.length - 1,
  )
  return {
    sections: [...(raw.sections || []), { id: uid('s_'), title, order: maxOrder + 1, fields: [] }],
  }
}

/**
 * Remove a section from the schema. Answers already saved on records are KEPT
 * (mergeCustomFields preserves keys that are no longer active); the questions
 * just stop appearing on the form.
 */
export function deleteSection(
  raw: { sections: RawSection[] },
  sectionId: string,
): { sections: RawSection[] } {
  return { sections: (raw.sections || []).filter((s) => s.id !== sectionId) }
}

/** Append a new field with a freshly minted 'f_' id. */
export function addField(
  raw: { sections: RawSection[] },
  sectionId: string,
  field: Omit<CustomField, 'id'>,
): { sections: RawSection[] } {
  return {
    sections: (raw.sections || []).map((s) =>
      s.id !== sectionId ? s : { ...s, fields: [...(s.fields || []), { ...field, id: uid('f_') }] },
    ),
  }
}

/**
 * Remove a field from the schema. As with deleteSection, answers already saved
 * on records are kept; the question just stops appearing.
 */
export function removeField(
  raw: { sections: RawSection[] },
  sectionId: string,
  fieldId: string,
): { sections: RawSection[] } {
  return {
    sections: (raw.sections || []).map((s) =>
      s.id !== sectionId ? s : { ...s, fields: (s.fields || []).filter((f) => f.id !== fieldId) },
    ),
  }
}
