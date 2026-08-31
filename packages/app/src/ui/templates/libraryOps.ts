/**
 * Pure template-library operations behind the builder UI. Every function
 * returns a NEW library/schema and never mutates its input, so the component
 * can re-read fresh config, apply the op, and persist through saveLibrary.
 *
 * Rules carried over from shipped bugs (REBUILD-HANDOFF section 6):
 *  - Template ids and field ids are permanent. Records store the templateId
 *    they were filed under and answers keyed by field id, so an id must never
 *    be reused or regenerated once it exists. Duplicating a template mints
 *    FRESH custom-section and field ids for exactly that reason: a copy that
 *    kept the original ids would silently cross-link answers between forms.
 *  - The library must always keep at least one template, and at least one
 *    ENABLED template - a library with nothing enabled leaves the org with no
 *    visit form to open.
 *  - Deleting a template never touches records: visits already filed under it
 *    keep their answers and their template name (both are stored on the
 *    record itself). Every delete confirm says exactly that.
 */
import { BUILTIN_SECTIONS, uid } from '../../config/sections'
import type {
  CustomField,
  FormTemplate,
  FormTemplateLibrary,
  RawSection,
} from '../../config/types'

const BUILTIN_IDS = new Set(BUILTIN_SECTIONS.map((s) => s.id))

// ------------------------------------------------------------ UI messages ---

/** Same copy as the rest of Settings; the admin gate is per DEVICE. */
export const GATE_REASON = 'Only an admin device can change this. This device is set to standard.'

export const SYNTHESIZED_REASON =
  "Your organization's form has not synced to this device yet. Editing is turned off " +
  "until it arrives, because saving now would replace your organization's real form " +
  'with an empty one.'

export const LAST_TEMPLATE_MESSAGE =
  'At least one form must remain. Add another form before deleting this one.'

export const LAST_ENABLED_MESSAGE =
  'At least one form must stay on, or there is no visit form to open. Turn another form on first.'

export const REQUIRED_SECTION_REASON =
  'This section is always shown. Every visit needs it, so it cannot be hidden.'

export const COLLAPSED_LOCK_REASON =
  'This section has a required question, so it always starts open. A collapsed section would hide an answer Save demands.'

export const FIELD_ID_NOTE = 'The field id is permanent; saved answers stay linked to it.'

// Delete confirms. The exact answer-retention wording is contract: an admin
// must never be left guessing what happens to data already saved.
export function templateDeleteConfirm(name: string): string {
  return (
    `Delete the "${name}" form?\n\n` +
    'Visits already filed under it keep their answers and their template name. ' +
    'The form just stops being offered for new visits.'
  )
}

export function sectionDeleteConfirm(title: string, questionCount: number): string {
  const head = questionCount
    ? `Delete "${title}" and its ${questionCount} question${questionCount === 1 ? '' : 's'}?`
    : `Delete "${title}"?`
  return (
    head +
    '\n\nAnswers already saved on existing records are kept, but will no longer appear on the form.'
  )
}

export function fieldDeleteConfirm(label: string): string {
  return (
    `Remove "${label}"?\n\n` +
    'Answers already saved on existing records are kept, but this question will no longer appear.'
  )
}

// ---------------------------------------------------------- template CRUD ---

export interface LibraryOpResult {
  lib: FormTemplateLibrary
  /** Set when the operation was refused; the library is unchanged. */
  refusal: string | null
  /** The id to focus afterwards (new template, duplicate). */
  focusId?: string
  /** Name of a template auto-enabled so the library never goes all-off. */
  autoEnabled?: string
}

const unchanged = (lib: FormTemplateLibrary, refusal: string): LibraryOpResult => ({
  lib,
  refusal,
})

/** Append a new empty enabled template. An empty schema renders all built-ins. */
export function createTemplate(lib: FormTemplateLibrary, name: string): LibraryOpResult {
  const id = uid('tpl_')
  const t: FormTemplate = {
    id,
    name: name.trim() || 'New form',
    enabled: true,
    schema: { sections: [] },
  }
  return { lib: { ...lib, templates: [...lib.templates, t] }, refusal: null, focusId: id }
}

/**
 * Deep-copy a template with FRESH ids for custom sections and ALL custom
 * fields. Built-in section ids are shared vocabulary and stay; everything
 * minted by an admin gets a new id so the copy can never claim answers filed
 * under the original.
 */
export function duplicateTemplate(lib: FormTemplateLibrary, id: string): LibraryOpResult {
  const src = lib.templates.find((t) => t.id === id)
  if (!src) return unchanged(lib, 'That form no longer exists.')
  const sections: RawSection[] = (src.schema?.sections ?? []).map((s) => {
    const copy: RawSection = { ...s }
    if (!BUILTIN_IDS.has(copy.id)) copy.id = uid('s_')
    if (Array.isArray(copy.fields)) {
      copy.fields = copy.fields.map((f): CustomField => ({ ...f, id: uid('f_') }))
    }
    return copy
  })
  const copy: FormTemplate = {
    id: uid('tpl_'),
    name: `${src.name} (copy)`,
    enabled: true,
    schema: { sections },
  }
  return { lib: { ...lib, templates: [...lib.templates, copy] }, refusal: null, focusId: copy.id }
}

/** Rename in place. A blank name keeps the old one rather than saving "". */
export function renameTemplate(
  lib: FormTemplateLibrary,
  id: string,
  name: string,
): FormTemplateLibrary {
  const trimmed = name.trim()
  if (!trimmed) return lib
  return {
    ...lib,
    templates: lib.templates.map((t) => (t.id === id ? { ...t, name: trimmed } : t)),
  }
}

/** Toggle a template, refusing to switch off the last enabled one. */
export function setTemplateEnabled(
  lib: FormTemplateLibrary,
  id: string,
  enabled: boolean,
): LibraryOpResult {
  const t = lib.templates.find((x) => x.id === id)
  if (!t) return unchanged(lib, 'That form no longer exists.')
  if (!enabled) {
    const enabledCount = lib.templates.filter((x) => x.enabled !== false).length
    if (enabledCount <= 1 && t.enabled !== false) {
      return unchanged(lib, LAST_ENABLED_MESSAGE)
    }
  }
  return {
    lib: { ...lib, templates: lib.templates.map((x) => (x.id === id ? { ...x, enabled } : x)) },
    refusal: null,
  }
}

/**
 * Delete a template, refusing to delete the last one. If the deletion leaves
 * nothing enabled, the first remaining template is enabled and reported, so
 * the org always has a visit form and the formSchema mirror stays defined.
 */
export function deleteTemplate(lib: FormTemplateLibrary, id: string): LibraryOpResult {
  if (lib.templates.length <= 1) return unchanged(lib, LAST_TEMPLATE_MESSAGE)
  if (!lib.templates.some((t) => t.id === id)) {
    return unchanged(lib, 'That form no longer exists.')
  }
  let templates = lib.templates.filter((t) => t.id !== id)
  let autoEnabled: string | undefined
  if (!templates.some((t) => t.enabled !== false)) {
    const firstRemaining = templates[0]
    if (firstRemaining) {
      templates = templates.map((t, i) => (i === 0 ? { ...t, enabled: true } : t))
      autoEnabled = firstRemaining.name
    }
  }
  return { lib: { ...lib, templates }, refusal: null, autoEnabled }
}

/** Replace one template's schema (the builder's per-edit write). */
export function updateTemplateSchema(
  lib: FormTemplateLibrary,
  id: string,
  schema: { sections: RawSection[] },
): FormTemplateLibrary {
  return {
    ...lib,
    templates: lib.templates.map((t) => (t.id === id ? { ...t, schema } : t)),
  }
}

/** A template's stored schema in the shape the section helpers expect. */
export function rawSchemaOf(
  lib: FormTemplateLibrary,
  id: string | null,
): { sections: RawSection[] } {
  const t = lib.templates.find((x) => x.id === id) ?? lib.templates[0]
  const schema = t?.schema
  return schema && Array.isArray(schema.sections) ? { sections: schema.sections } : { sections: [] }
}

// ------------------------------------------------- schema-level operations ---

/**
 * Store the collapsed-by-default preference on a CUSTOM section. Custom
 * sections always have a stored entry, so no override materialization is
 * needed; a built-in id is left untouched (their collapse behavior is fixed).
 */
export function setSectionCollapsed(
  raw: { sections: RawSection[] },
  sectionId: string,
  collapsed: boolean,
): { sections: RawSection[] } {
  return {
    sections: (raw.sections || []).map((s) =>
      s.id === sectionId && !BUILTIN_IDS.has(s.id) ? { ...s, collapsed } : s,
    ),
  }
}

/**
 * Revert a built-in section's name to its canonical default by REMOVING the
 * stored title override (not by writing the default as a new title, which
 * would pin today's copy forever). An override left with nothing but its id
 * is dropped entirely, keeping the stored schema sparse.
 */
export function resetSectionTitle(
  raw: { sections: RawSection[] },
  sectionId: string,
): { sections: RawSection[] } {
  const sections: RawSection[] = []
  for (const s of raw.sections || []) {
    if (s.id !== sectionId || !BUILTIN_IDS.has(s.id)) {
      sections.push(s)
      continue
    }
    const { title: _dropped, ...rest } = s
    const meaningful = Object.keys(rest).some((k) => k !== 'id')
    if (meaningful) sections.push(rest)
    // else: the override held only the title; drop it and fall back to defaults.
  }
  return { sections }
}

/**
 * Move `id` one step among the movable ids, returning the FULL ordered id
 * list for reorderSections (which persists an explicit order on every
 * section). Sections that are not movable (notOnForm) keep their slots; the
 * moving section swaps places with its nearest movable neighbour, so the
 * visible result matches what the admin asked for even when a compat-only
 * section sits between them. Returns null at the ends.
 */
export function moveId(
  fullIds: string[],
  movableIds: string[],
  id: string,
  dir: -1 | 1,
): string[] | null {
  const mi = movableIds.indexOf(id)
  if (mi < 0) return null
  const neighbour = movableIds[mi + dir]
  if (!neighbour) return null
  const a = fullIds.indexOf(id)
  const b = fullIds.indexOf(neighbour)
  if (a < 0 || b < 0) return null
  const next = [...fullIds]
  next[a] = neighbour
  next[b] = id
  return next
}
