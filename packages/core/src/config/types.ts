/**
 * Customization/config model types.
 *
 * The product's soul: an organization customizes the app with DATA (these
 * shapes, synced through the org config table), never with code. Every shape
 * here is stored JSON - in the kernel KV on devices and in the org's config
 * table - so renaming a key or a property silently breaks every org that has
 * already saved one. Shapes are ported field-for-field from the previous
 * implementation.
 */

// ------------------------------------------------------------ form fields ---

export type FieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'multiselect'
  | 'number'
  | 'range'
  | 'yesno'
  | 'date'

/** Builder picker entries. Labels are UI copy; keep them exact. */
export const FIELD_TYPES: { type: FieldType; label: string }[] = [
  { type: 'text', label: 'Short text' },
  { type: 'textarea', label: 'Long text' },
  { type: 'select', label: 'Single choice' },
  { type: 'multiselect', label: 'Multiple choice' },
  { type: 'number', label: 'Number' },
  { type: 'range', label: 'Scale (0-N)' },
  { type: 'yesno', label: 'Yes / No' },
  { type: 'date', label: 'Date' },
]

/**
 * An admin-defined question. The id is minted once (uid('f_')) and is
 * IMMUTABLE afterwards: records store answers keyed by field id, so any
 * operation that changes an id silently orphans real clinical data.
 */
export interface CustomField {
  id: string
  label: string
  type: FieldType
  options?: string[]
  required?: boolean
  min?: number
  max?: number
  placeholder?: string
}

/** The value of one answered custom field. Empty is EXPLICIT ('' / [] / null), never "absent". */
export type CustomValue = string | string[] | number | null

// --------------------------------------------------------------- sections ---

/**
 * Per-section role access override (Clinic product). Which station roles may
 * VIEW the section on the visit form and which may EDIT it; edit implies
 * view. 'all' means every role. ABSENT means the shipped defaults apply
 * (src/config/roles.ts), so every schema stored before roles existed renders
 * exactly as before. Stored as strings on purpose: the role list is fixed in
 * code today, but a stored value must survive a future role being added or
 * renamed without orphaning the schema.
 */
export interface SectionRoles {
  view?: string[] | 'all'
  edit?: string[] | 'all'
}

/**
 * A section as STORED. Built-in sections appear here only as SPARSE OVERRIDES
 * (just the keys the admin changed); custom sections carry their own fields.
 */
export interface RawSection {
  id: string
  title?: string
  hidden?: boolean
  order?: number
  fields?: CustomField[]
  /**
   * Custom sections only: whether the section starts collapsed on the visit
   * form. Absent means collapsed (the historical behavior for custom sections
   * without required fields), so old stored schemas render unchanged. A
   * section with a required field ALWAYS starts open regardless of this flag:
   * a collapsed section would hide the answer Save demands.
   */
  collapsed?: boolean
  /** Role access override; absent = the shipped defaults for this section. */
  roles?: SectionRoles
}

/** A section as RESOLVED for rendering. */
export interface EffectiveSection {
  id: string
  title: string
  required: boolean
  builtin: boolean
  hidden: boolean
  order: number
  fields: CustomField[]
  /**
   * Built-in section the encounter form has no rendered body for. It stays in
   * the schema so a legacy-saved arrangement round-trips, but the builder must
   * exclude it from the arrangeable list instead of offering a dead entry.
   */
  notOnForm?: boolean
  /** Custom sections: the stored collapsed-by-default preference (see RawSection). */
  collapsed?: boolean
  /** The stored role override, passed through untouched (see RawSection). */
  roles?: SectionRoles
}

// -------------------------------------------------------------- templates ---

export interface FormTemplate {
  id: string
  name: string
  enabled?: boolean
  schema: { sections: RawSection[] }
}

/** Stored under the `formTemplates` config key. */
export interface FormTemplateLibrary {
  version: number
  templates: FormTemplate[]
}

/** Compat alias: the previous implementation called this TemplateLibrary. */
export type TemplateLibrary = FormTemplateLibrary

// ------------------------------------------------------------ clinic lists ---

/**
 * One formulary row (`formulary` config key). Prescriptions store medId, so an
 * id must never be reused or regenerated once the entry exists.
 */
export interface FormularyEntry {
  id: string
  name: string
  dose?: string
  unit?: string
  category?: string
  controlled?: boolean
}

/** Compat alias: the previous implementation called this FormularyItem. */
export type FormularyItem = FormularyEntry

/** A numeric-lab reference band. min is INCLUSIVE, max is EXCLUSIVE, missing bounds are open. */
export interface LabRange {
  label: string
  min?: number
  max?: number
  color?: string
}

/** One lab-panel entry (`customLabTests` config key). */
export interface CustomLabTest {
  id: string
  name: string
  type: 'toggle' | 'numeric'
  unit?: string
  enabledByDefault?: boolean
  ranges?: LabRange[]
}

/** Compat alias: the previous implementation called this LabTest. */
export type LabTest = CustomLabTest

/** Diagnosis presets are plain names (`customDxPresets` config key). */
export type DxPreset = string

/** One medication line inside an Rx preset. medId points into the formulary. */
export interface RxPresetMed {
  medId: string
  dose: string
  freq: string
  duration: string
}

/** One prescription preset (`rxPresets` config key, legacy shape from state.js). */
export interface RxPreset {
  name: string
  rx: string
  meds: RxPresetMed[]
  notes?: string
}

/**
 * Per-category lists of preset NAMES an admin hid (`hiddenPresets` config
 * key). Known categories: diagnoses, procedures, complaints, referralTypes,
 * rxPresets, labTests - but unknown categories written by other clients must
 * be preserved, hence the open record.
 */
export type HiddenPresets = Record<string, string[]>

// Plain string lists (one entry per line in the editors).
export type SiteList = string[] // `sites`
export type ProviderList = string[] // `providers`
export type ComplaintList = string[] // `complaints`
export type ProcedureList = string[] // `procedures`
export type ReferralTypeList = string[] // `referralTypes`
