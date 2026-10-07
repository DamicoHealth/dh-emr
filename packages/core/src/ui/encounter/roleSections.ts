/**
 * Role-filtered rendering and saving for the visit form (Clinic product).
 * PURE helpers; the form (EncounterForm.tsx) is the only caller.
 *
 * The one rule that matters: a role's save NEVER clears another role's
 * sections. The form state always carries every field (toFormState loads
 * the whole record), but relying on that alone is not enough - the record
 * can change underneath an open form (triage enters vitals on another iPad
 * while pharmacy has the visit open), and a save that serialized the whole
 * stale state would overwrite them. So after buildRecord, every built-in
 * section the role does NOT edit is copied back from the freshest stored
 * copy (preserveUnrenderedSections), and custom sections ride the existing
 * mergeCustomFields path with only the role's EDIT sections active.
 */
import type { PatientRecord } from '../../types/record'
import type { EffectiveSection } from '../../config/types'
import { sectionModeFor, type RoleSection } from '../../config/roles'
import type { EncounterFormState } from './formState'
import type { ValidationProblem } from './validate'

/**
 * Which record fields each built-in section OWNS. A field listed here is
 * written only by a save that renders the section in edit mode; otherwise it
 * is preserved from the stored record. accessToCare and its legacy mirrors
 * are already preserved by buildRecord (the form has no body for them).
 */
export const SECTION_RECORD_FIELDS: Record<string, readonly (keyof PatientRecord)[]> = {
  encounter: ['site', 'date', 'provider'],
  patient: ['givenName', 'familyName', 'name', 'sex', 'dob', 'phone', 'ageEstimated', 'mrn'],
  vitals: ['temp', 'bp', 'weight', 'pregnant', 'breastfeeding'],
  history: ['allergies', 'currentMeds', 'pmh'],
  chiefConcern: ['chiefConcern'],
  labs: ['labs', 'labComments', 'urinalysis', 'bloodGlucose'],
  diagnosis: ['diagnosis', 'diagnosisCodes'],
  // `treatment` is the summary line derived from the medications and the
  // treatment notes, so it belongs to the section that writes them.
  medications: ['medications', 'treatmentNotes', 'treatment'],
  procedures: ['procedures'],
  referral: ['referralType', 'referralDate'],
  imaging: ['imaging'],
  surgery: ['surgery'],
  notes: ['notes'],
}

/**
 * Which FORM STATE fields each built-in section renders, for scoping
 * validation problems: a role cannot be asked to fix a field it cannot see.
 */
export const SECTION_STATE_FIELDS: Record<string, readonly (keyof EncounterFormState)[]> = {
  encounter: ['site', 'date', 'provider'],
  patient: [
    'givenName',
    'familyName',
    'sex',
    'dobText',
    'dobIso',
    'dobUnknown',
    'ageEstimate',
    'phone',
    'mrn',
  ],
  vitals: ['temp', 'bp', 'weight', 'pregnant', 'breastfeeding'],
  history: ['allergies', 'currentMeds', 'pmh'],
  chiefConcern: ['chiefConcern', 'complaints'],
  labs: ['labs', 'labComments', 'urinalysis'],
  diagnosis: ['diagnosis', 'diagnosisCodes'],
  medications: ['medications', 'treatmentNotes'],
  procedures: ['procedures'],
  referral: ['referralType', 'referralDate'],
  imaging: ['imagingType', 'imagingFindings'],
  surgery: ['surgeryPerformed', 'surgeryType', 'surgeryNotes'],
  notes: ['notes'],
}

/**
 * The sections the form renders for one account, with modes. Same as
 * sectionsForRole with two form-only rules for a NEW visit (`creating`):
 *  - the required sections (Visit, Patient) are always editable, whatever
 *    the role: nobody can register a patient without a name, a site and a
 *    date, and Save would refuse with nothing on screen to fix;
 *  - view-only sections are omitted: there is nothing to view yet, and a
 *    reception intake form should be the short one (demographics, visit
 *    context), not twelve empty read-only cards.
 */
export function formSectionsFor(
  schema: { sections: EffectiveSection[] },
  role: string,
  isAdmin: boolean,
  creating: boolean,
): RoleSection[] {
  const out: RoleSection[] = []
  for (const s of schema.sections) {
    if (s.hidden) continue
    let mode = sectionModeFor(s, role, isAdmin)
    if (creating && s.required) mode = 'edit'
    if (mode === 'hidden') continue
    if (creating && mode === 'view') continue
    out.push({ ...s, mode })
  }
  return out
}

/** Ids of the sections rendered in edit mode. */
export function editableIdsOf(sections: readonly RoleSection[]): Set<string> {
  return new Set(sections.filter((s) => s.mode === 'edit').map((s) => s.id))
}

/**
 * Keep only the problems a role can act on. A built-in problem names a
 * state field; it stays when that field belongs to a section rendered in
 * edit mode. Custom-field problems (field 'customFields') are generated only
 * for edit sections, so they always stay.
 */
export function problemsForRole(
  problems: readonly ValidationProblem[],
  editableIds: ReadonlySet<string>,
): ValidationProblem[] {
  const visibleFields = new Set<keyof EncounterFormState>()
  for (const [id, fields] of Object.entries(SECTION_STATE_FIELDS)) {
    if (editableIds.has(id)) for (const f of fields) visibleFields.add(f)
  }
  return problems.filter((p) => p.field === 'customFields' || visibleFields.has(p.field))
}

/**
 * After buildRecord: copy every field of every built-in section the role
 * did NOT edit from `stored` (the freshest copy of the visit) onto `rec`.
 * Identity, bookkeeping and the fields buildRecord already preserves are
 * untouched. Returns a new record; neither input is mutated.
 */
export function preserveUnrenderedSections(
  rec: PatientRecord,
  stored: PatientRecord,
  editableIds: ReadonlySet<string>,
): PatientRecord {
  const out: PatientRecord = { ...rec }
  const src = stored as unknown as Record<string, unknown>
  const dst = out as unknown as Record<string, unknown>
  for (const [id, fields] of Object.entries(SECTION_RECORD_FIELDS)) {
    if (editableIds.has(id)) continue
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(src, f)) dst[f] = src[f]
    }
  }
  return out
}
