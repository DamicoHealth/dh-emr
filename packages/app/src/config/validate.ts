/**
 * Builder-side guards and save-side validation for the customization model.
 *
 * Two independent protections exist for the empty-options problem, and BOTH
 * are required:
 *   - commitOptions() refuses to persist an empty choice list (builder side),
 *   - missingRequired() skips optionless selects on saved forms (record side),
 *     protecting forms already out in the field.
 * A required select with options: [] renders a label with no control, so it
 * can never be answered - historically it blocked EVERY save on every device
 * in the org until someone worked out why.
 */
import type { CustomFields } from '../types/record'
import type { CustomField, CustomValue, EffectiveSection, FieldType } from './types'

// ------------------------------------------------------- required answers ---

/** Required custom fields that were left empty. */
export function missingRequired(
  fields: CustomField[],
  answers: Record<string, CustomValue>,
): CustomField[] {
  return fields.filter((f) => {
    if (!f.required) return false
    // A required select with no choices renders a label and nothing else, so
    // it can NEVER be answered. Treating it as missing blocked every save on
    // every device in the org until an admin noticed. The builder now refuses
    // to save an empty choice list; this handles the ones already in the field.
    if ((f.type === 'select' || f.type === 'multiselect') && !(f.options || []).length) return false
    const v = answers[f.id]
    if (v === null || v === undefined || v === '') return true
    if (Array.isArray(v) && v.length === 0) return true
    return false
  })
}

// --------------------------------------------------- options list commits ---

export const EMPTY_OPTIONS_WARNING =
  'A question needs at least one choice. The previous choices have been kept.'

export const EMPTY_LIST_WARNING =
  'A list cannot be empty. The previous entries have been kept.'

/**
 * Normalize a choices textarea: one option per line, trimmed, blanks dropped,
 * de-duplicated (duplicate choices made duplicate keys/pills in the UI).
 */
export function parseOptionsText(text: string): string[] {
  return [...new Set(text.split('\n').map((o) => o.trim()).filter(Boolean))]
}

export interface CommitResult {
  /** What to persist: the parsed list, or the previous one when refused. */
  value: string[]
  refused: boolean
  warning: string | null
}

/**
 * Commit a field's choices textarea. An empty result is REFUSED: the previous
 * choices are kept and the caller shows EMPTY_OPTIONS_WARNING. This is the
 * builder-side half of the empty-options protection.
 */
export function commitOptions(text: string, previous: string[]): CommitResult {
  const next = parseOptionsText(text)
  if (!next.length) return { value: previous, refused: true, warning: EMPTY_OPTIONS_WARNING }
  return { value: next, refused: false, warning: null }
}

/**
 * Commit a clinic-list textarea (sites, providers, complaints, procedures,
 * referral destinations). Same refusal rule: saving an empty list would remove
 * the control from the encounter form for the whole organization.
 */
export function commitList(text: string, previous: string[]): CommitResult {
  const next = parseOptionsText(text)
  if (!next.length) return { value: previous, refused: true, warning: EMPTY_LIST_WARNING }
  return { value: next, refused: false, warning: null }
}

// -------------------------------------------------------- field defaults ---

/**
 * Defaults applied when a field is created as (or switched to) a type that
 * needs structure to be answerable: selects start with real choices so an
 * unanswerable optionless select never enters the schema, ranges get a width.
 */
export function fieldTypeDefaults(type: FieldType): Partial<CustomField> {
  if (type === 'select' || type === 'multiselect') return { options: ['Option 1', 'Option 2'] }
  if (type === 'range') return { min: 0, max: 10 }
  return {}
}

/**
 * Commit the range editor's min/max text buffers. Blank or non-numeric lowest
 * falls back to 0; blank highest falls back to min + 1 (NOT 10); and max is
 * clamped to at least min + 1 - a scale must have some width.
 */
export function commitRange(lo: string, hi: string): { min: number; max: number } {
  const min = Number.isFinite(Number(lo)) && lo.trim() !== '' ? Number(lo) : 0
  const parsed = Number.isFinite(Number(hi)) && hi.trim() !== '' ? Number(hi) : min + 1
  return { min, max: Math.max(min + 1, parsed) }
}

// ------------------------------------------------------ collapse behavior ---

/**
 * Built-in sections that render collapsed-by-default on the encounter form.
 * (Collapsible sections START COLLAPSED.)
 */
export const OPTIONAL_SECTIONS: ReadonlySet<string> = new Set([
  'imaging',
  'surgery',
  'referral',
  'notes',
  'procedures',
  'accessToCare',
])

/**
 * Collapsed-by-default is allowed only for sections without required fields:
 * a collapsed section would hide the input Save demands. Built-ins follow
 * OPTIONAL_SECTIONS; a custom section is collapsible iff none of its fields
 * is required AND its stored `collapsed` preference is not false (absent
 * means collapsed, the historical behavior, so old schemas render unchanged).
 * Required fields WIN over the stored flag - the flag is ignored here, not
 * rewritten, mirroring how hidden:true is ignored for required sections.
 */
export function isCollapsibleSection(
  section: Pick<EffectiveSection, 'id' | 'builtin' | 'fields' | 'collapsed'>,
): boolean {
  if (section.builtin) return OPTIONAL_SECTIONS.has(section.id)
  if (section.fields.some((f) => f.required)) return false
  return section.collapsed !== false
}

// ------------------------------------------------------- answer retention ---

/**
 * Merge a record's previous custom answers with the ones collected from the
 * form. Answers for fields the active template RENDERS (activeIds) are
 * authoritative, so clearing one truly clears it. Answers it does NOT render -
 * a hidden section, another template's fields, or a DELETED field/section -
 * are preserved untouched. This is why deleting a field or section keeps
 * saved answers: the id simply stops being active.
 */
export function mergeCustomFields(
  prev: CustomFields | undefined,
  collected: CustomFields,
  activeIds: string[],
): CustomFields {
  if (!prev) return { ...collected }
  const active = new Set(activeIds)
  const out: CustomFields = {}
  for (const k of Object.keys(prev)) {
    if (active.has(k)) continue
    const v = prev[k]
    if (v !== undefined) out[k] = v
  }
  return Object.assign(out, collected)
}
