/**
 * THE SERIALIZATION CONTRACT.
 *
 * buildRecord() is the React equivalent of collectFormData() in the legacy
 * app, and toFormState() is the equivalent of populateForm(). Together they
 * must round-trip losslessly: a record loaded, edited, and saved must keep
 * every field the form does not own.
 *
 * Both are PURE - every non-deterministic input (clock, new ids, device id,
 * config) is injected - so parity can be asserted exactly in tests.
 */
import type {
  DiagnosisCode,
  Medication,
  PatientRecord,
  Urinalysis,
} from '../../types/record'
import { generateBaseMRN, resolveMrnSuffix } from '../../domain/mrn'
import { calcMedQty, type FormularyEntry } from '../../domain/medQty'
import { mergeCustomFields } from '../../config/validate'
import { UA_PARAMS } from '../../config/defaults/lists'
import {
  type EncounterFormState,
  type LabInput,
  type MedLine,
  emptyFormState,
  isoToDOBString,
} from './formState'

// The clear-vs-preserve rule lives with the customization model; re-exported
// here so the encounter module keeps the reference surface (tests import it
// from serialize).
export { mergeCustomFields }

export interface FrequencyOption {
  value: string
  label: string
}

export interface BuildContext {
  /** the record being edited, or null for a new encounter */
  prev: PatientRecord | null
  deviceId: string | null
  templateId: string | null
  /** resolved template name; falls back to prev.templateName when deleted */
  templateName: string
  /** ids of custom fields the ACTIVE template renders (scopes the merge) */
  activeCustomFieldIds: string[]
  formulary: FormularyEntry[]
  frequencies: FrequencyOption[]
  now: string
  newId: () => string
}

function medDisplayName(medId: string, formulary: FormularyEntry[]): string {
  const f = formulary.find((x) => x.id === medId)
  return f ? f.name : medId
}

function freqLabel(freq: string, frequencies: FrequencyOption[]): string {
  const f = frequencies.find((x) => x.value === freq)
  return f ? f.label : freq
}

/** Form state -> the canonical record. Mirrors collectFormData field for field. */
export function buildRecord(state: EncounterFormState, ctx: BuildContext): PatientRecord {
  const givenName = state.givenName
  const familyName = state.familyName

  // Only ORDERED labs are stored. The legacy version wrote an entry for every
  // configured test (including {ordered:false,result:'N/A'}), which is ~25% dead
  // weight per record; consumers (CSV, analytics, lab-positive) already treat a
  // missing key exactly like an unordered one, so output is unchanged.
  const labs: PatientRecord['labs'] = {}
  for (const [name, l] of Object.entries(state.labs)) {
    if (!l || !l.ordered) continue
    labs[name] =
      l.kind === 'numeric'
        ? {
            ordered: true,
            type: 'numeric',
            value: l.value,
            unit: l.unit,
            interpretation: l.interpretation,
          }
        : { ordered: true, type: 'toggle', result: l.result }
  }

  // Legacy keeps a top-level copy of blood glucose alongside the lab entry.
  const bg = state.labs['Blood Glucose']
  const bloodGlucose = bg && bg.ordered && bg.kind === 'numeric' ? bg.value : ''

  // null (not {}) when nothing was recorded - analytics distinguishes them.
  const uaEntries = UA_PARAMS.map((p) => [p, state.urinalysis[p] || ''] as const).filter(
    ([, v]) => !!v,
  )
  const urinalysis = uaEntries.length ? (Object.fromEntries(uaEntries) as Urinalysis) : null

  const prevMeds = new Map((ctx.prev?.medications || []).map((m) => [m.id, m]))
  const medications: Medication[] = state.medications
    .filter((m) => !!m.medId)
    .map((m) => {
      // Dispensing quantity drives the pharmacy totals in analytics and the
      // donor report, so it must be computed exactly like the legacy form.
      // If it cannot be derived, keep whatever the record already had rather
      // than destroying it on resave.
      const q = calcMedQty(m.medId, m.dose, m.freq, m.duration, ctx.formulary)
      const prev = prevMeds.get(m.id)
      return {
        // Keep the saved line's id so medication identity is stable across edits;
        // the legacy version minted a fresh UUID for every med on every save.
        id: m.id || ctx.newId(),
        medId: m.medId,
        dose: m.dose,
        freq: m.freq,
        duration: m.duration,
        qty: q ? q.qty : (prev?.qty ?? null),
        qtyUnit: q ? q.unit : (prev?.qtyUnit ?? null),
      }
    })

  const treatmentLines = medications.map(
    (m) =>
      `${medDisplayName(m.medId, ctx.formulary)} ${m.dose} ${freqLabel(m.freq, ctx.frequencies)} x ${m.duration}`,
  )
  if (state.treatmentNotes.trim()) treatmentLines.push('Notes: ' + state.treatmentNotes.trim())

  const referralActive = !!state.referralType && state.referralType !== 'None'

  const rec: PatientRecord = {
    id: ctx.prev?.id ?? ctx.newId(),
    deviceId: ctx.prev?.deviceId || ctx.deviceId || '',
    mrn: state.mrn,

    site: state.site,
    date: state.date,
    provider: state.provider,

    givenName,
    familyName,
    name: [givenName, familyName].filter(Boolean).join(' '),
    sex: state.sex,
    dob: state.dobIso,
    phone: state.phone,
    ageEstimated: state.dobUnknown,

    temp: state.temp,
    bp: state.bp.trim(),
    weight: state.weight,
    pregnant: state.pregnant,
    breastfeeding: state.breastfeeding,

    allergies: state.allergies,
    currentMeds: state.currentMeds,
    pmh: state.pmh,
    chiefConcern: state.chiefConcern,

    // accessToCare is not edited by this form yet; carry the saved value through
    // untouched rather than dropping it.
    accessToCare: ctx.prev?.accessToCare ?? null,
    transport: ctx.prev?.transport ?? '',
    travelTime: ctx.prev?.travelTime ?? '',

    labs,
    labComments: state.labComments,
    urinalysis,
    bloodGlucose,

    diagnosis: state.diagnosis,
    diagnosisCodes: state.diagnosisCodes as DiagnosisCode[],
    medications,
    treatmentNotes: state.treatmentNotes,
    treatment: treatmentLines.join('; '),
    procedures: [...state.procedures],
    imaging: state.imagingType
      ? { modality: 'Ultrasound', type: state.imagingType, findings: state.imagingFindings }
      : null,
    surgery: state.surgeryPerformed
      ? { type: state.surgeryType.trim(), notes: state.surgeryNotes.trim() }
      : null,

    referralType: state.referralType,
    referralDate: referralActive ? state.referralDate : '',
    notes: state.notes,

    templateId: ctx.templateId,
    templateName: ctx.templateName,
    customFields: mergeCustomFields(ctx.prev?.customFields, state.customFields, ctx.activeCustomFieldIds),

    savedAt: ctx.now,
  }

  // Preserve fields this form does not own (set cross-device, or by features not
  // yet migrated) so a save here never silently drops them.
  if (ctx.prev?.referralStatus !== undefined) rec.referralStatus = ctx.prev.referralStatus
  if (ctx.prev?.deleted !== undefined) rec.deleted = ctx.prev.deleted

  return rec
}

/** Record -> form state. Mirrors populateForm, including legacy migrations. */
export function toFormState(rec: PatientRecord, today?: string): EncounterFormState {
  const s = emptyFormState(today)

  s.site = rec.site || ''
  s.date = rec.date || s.date
  s.provider = rec.provider || ''

  // Older records stored only a composed `name`; split it the way populateForm does.
  s.givenName = rec.givenName || (rec.name ? rec.name.split(' ')[0] || '' : '')
  s.familyName = rec.familyName || (rec.name ? rec.name.split(' ').slice(1).join(' ') : '')
  s.sex = rec.sex || ''
  s.dobIso = rec.dob || ''
  s.dobText = isoToDOBString(rec.dob || '')
  s.dobUnknown = !!rec.ageEstimated
  // Restore the estimate itself. Without it the required "Estimated age" box
  // opens empty, blocking the save of every age-estimated record, and retyping
  // the age would silently re-derive (and shift) the stored DOB and MRN.
  if (rec.ageEstimated && rec.dob) {
    const birthYear = Number(rec.dob.slice(0, 4))
    const age = Number.isFinite(birthYear) ? new Date().getFullYear() - birthYear : NaN
    s.ageEstimate = Number.isFinite(age) && age >= 0 && age < 150 ? String(age) : ''
  }
  s.phone = rec.phone || ''
  s.mrn = rec.mrn || ''

  s.temp = rec.temp || ''
  s.bp = rec.bp || ''
  // Legacy stored some weights as "58 kg"; keep the numeric part in the input.
  s.weight = String(rec.weight || '').replace(/\s*kg\s*$/i, '')
  s.pregnant = rec.pregnant || ''
  s.breastfeeding = rec.breastfeeding || ''

  s.allergies = rec.allergies || ''
  s.currentMeds = rec.currentMeds || ''
  s.pmh = rec.pmh || ''
  s.chiefConcern = rec.chiefConcern || ''
  // Pill highlight state is derived from the stored text, like populateForm did.
  s.complaints = (rec.chiefConcern || '').split(';').map((x) => x.trim()).filter(Boolean)

  const labs: Record<string, LabInput> = {}
  for (const [name, l] of Object.entries(rec.labs || {})) {
    if (!l) continue
    labs[name] =
      l.type === 'numeric'
        ? {
            kind: 'numeric',
            ordered: !!l.ordered,
            value: l.value || '',
            unit: l.unit || '',
            interpretation: l.interpretation || '',
          }
        : { kind: 'toggle', ordered: !!l.ordered, result: l.result || '' }
  }
  // Legacy migration: a record with only the top-level bloodGlucose gets it
  // surfaced back into the labs grid.
  if (rec.bloodGlucose && !labs['Blood Glucose']) {
    labs['Blood Glucose'] = {
      kind: 'numeric',
      ordered: true,
      value: rec.bloodGlucose,
      unit: 'mg/dL',
      interpretation: '',
    }
  }
  s.labs = labs
  s.labComments = rec.labComments || ''
  s.urinalysis = { ...(rec.urinalysis || {}) } as Record<string, string>

  s.diagnosis = rec.diagnosis || ''
  s.diagnosisCodes = [...(rec.diagnosisCodes || [])]
  s.medications = (rec.medications || []).map<MedLine>((m) => ({
    id: m.id,
    medId: m.medId,
    dose: m.dose,
    freq: m.freq,
    duration: m.duration,
  }))
  s.treatmentNotes = rec.treatmentNotes || ''
  s.procedures = [...(rec.procedures || [])]

  s.imagingType = rec.imaging?.type || ''
  s.imagingFindings = rec.imaging?.findings || ''
  s.surgeryPerformed = !!rec.surgery
  s.surgeryType = rec.surgery?.type || ''
  s.surgeryNotes = rec.surgery?.notes || ''

  s.referralType = rec.referralType || 'None'
  s.referralDate = rec.referralDate || ''
  s.notes = rec.notes || ''

  s.customFields = { ...(rec.customFields || {}) }
  return s
}

/**
 * A fresh encounter for a patient who is already in the chart.
 *
 * The only per-visit action used to be Edit, which OVERWRITES the visit being
 * viewed. A clinician seeing a returning patient either overwrote last month's
 * encounter or re-typed the name and date of birth exactly right to be
 * recognised as the same person. This carries identity forward and leaves
 * everything clinical blank, because today's vitals, labs, diagnosis and
 * medications must be entered for today.
 */
export function newVisitFormState(prev: PatientRecord, today?: string): EncounterFormState {
  const s = emptyFormState(today)
  s.site = prev.site || ''
  s.provider = prev.provider || ''
  s.givenName = prev.givenName || ''
  s.familyName = prev.familyName || ''
  s.sex = prev.sex || ''
  s.dobIso = prev.dob || ''
  s.dobText = isoToDOBString(prev.dob || '')
  s.dobUnknown = !!prev.ageEstimated
  s.phone = prev.phone || ''
  s.mrn = prev.mrn || ''
  // Standing history is clinical background, not a finding for this visit, so
  // it carries: re-typing a drug allergy every visit is how allergies get lost.
  s.allergies = prev.allergies || ''
  s.pmh = prev.pmh || ''
  s.currentMeds = prev.currentMeds || ''
  return s
}

/**
 * MRN derivation for the form header and the readonly Patient number input.
 *
 * Same patient (same base MRN AND same full name, compared case-insensitively)
 * reuses their stored number - which may itself carry a suffix - and `prior`
 * lists their previous visits for the returning-patient banner. A different
 * patient sharing initials+DOB gets the first free B..Z suffix via
 * resolveMrnSuffix (src/domain/mrn), which owns the letter rule.
 *
 * Caller contract: when editing, pass the edited record's id as excludeId so
 * the record never collides with itself - and keep the stored MRN verbatim
 * unless the name or DOB actually changed.
 */
export function returnPatientInfo(
  givenName: string,
  familyName: string,
  dobIso: string,
  allRecords: readonly PatientRecord[],
  excludeId: string | null,
): { mrn: string; prior: PatientRecord[] } {
  const base = generateBaseMRN(givenName, familyName, dobIso)
  if (!base) return { mrn: '', prior: [] }
  const candidates = allRecords.filter((r) => !r.deleted && r.id !== excludeId)
  const fullName = `${givenName} ${familyName}`
  const mrn = resolveMrnSuffix(base, fullName, candidates)
  const full = fullName.trim().toLowerCase()
  const prior = candidates.filter(
    (r) =>
      (r.mrn || '').replace(/[A-Z]$/, '') === base &&
      `${r.givenName || ''} ${r.familyName || ''}`.trim().toLowerCase() === full,
  )
  return { mrn, prior }
}
