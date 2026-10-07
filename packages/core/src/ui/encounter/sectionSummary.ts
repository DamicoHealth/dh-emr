/**
 * Compact read-only summaries of a visit's sections (Clinic role mode).
 *
 * A section a role only VIEWS used to render as the full form inside a
 * disabled fieldset: a pharmacist scrolled past a dozen greyed-out Patient
 * and Diagnosis inputs to reach Medications. A view-only section now shows
 * only what was recorded, as label: value lines, and the full read-only
 * form is one tap away (Section in EncounterForm.tsx).
 *
 * PURE: form state in, lines out (tests/sectionSummary.test.ts). Empty
 * values are skipped, so a section with nothing recorded summarizes to [].
 */
import type { EncounterFormState, LabInput } from './formState'
import type { CustomField, EffectiveSection, FormularyEntry } from '../../config/types'
import { UA_PARAMS } from '../../config/defaults/lists'

export interface SummaryLine {
  label: string
  value: string
}

export interface SummaryContext {
  formulary: readonly FormularyEntry[]
  /** Whole years from the form's date of birth; null when unknown. */
  age: number | null
}

const t = (s: string | null | undefined): string => (s ?? '').trim()

function push(out: SummaryLine[], label: string, value: string | null | undefined): void {
  const v = t(value)
  if (v) out.push({ label, value: v })
}

/** "POS", "11.2 g/dL (low)", "Awaiting result", or '' for a test that was never ordered or resulted. */
export function labResult(entry: LabInput | undefined | null): string {
  if (!entry) return ''
  if (entry.kind === 'toggle') {
    const r = t(entry.result)
    if (r) return r
    return entry.ordered ? 'Awaiting result' : ''
  }
  const v = t(entry.value)
  if (!v) return entry.ordered ? 'Awaiting result' : ''
  const unit = t(entry.unit)
  const interp = t(entry.interpretation)
  return `${v}${unit ? ` ${unit}` : ''}${interp ? ` (${interp})` : ''}`
}

function formatCustom(_f: CustomField, v: string | string[] | number | null | undefined): string {
  if (v === null || v === undefined) return ''
  if (Array.isArray(v)) return v.join(', ')
  return String(v)
}

export function summarizeSection(
  section: Pick<EffectiveSection, 'id' | 'builtin' | 'fields'>,
  state: EncounterFormState,
  ctx: SummaryContext,
): SummaryLine[] {
  const out: SummaryLine[] = []
  if (!section.builtin) {
    for (const f of section.fields) push(out, f.label, formatCustom(f, state.customFields[f.id]))
    return out
  }
  switch (section.id) {
    case 'encounter':
      push(out, 'Site', state.site)
      push(out, 'Date', state.date)
      push(out, 'Provider', state.provider)
      break
    case 'patient': {
      push(out, 'Name', `${t(state.givenName)} ${t(state.familyName)}`.trim())
      push(out, 'Sex', state.sex)
      if (state.dobUnknown) {
        push(out, 'Age', t(state.ageEstimate) ? `about ${t(state.ageEstimate)} y (estimated)` : '')
      } else {
        push(
          out,
          'Date of birth',
          t(state.dobText) ? `${t(state.dobText)}${ctx.age !== null ? ` (${ctx.age} y)` : ''}` : '',
        )
      }
      push(out, 'Phone', state.phone)
      push(out, 'Patient number', state.mrn)
      break
    }
    case 'vitals':
      push(out, 'Temperature', t(state.temp) ? `${t(state.temp)} °C` : '')
      push(out, 'Blood pressure', state.bp)
      push(out, 'Weight', t(state.weight) ? `${t(state.weight)} kg` : '')
      push(out, 'Pregnant', state.pregnant)
      push(out, 'Breastfeeding', state.breastfeeding)
      break
    case 'history':
      push(out, 'Allergies', state.allergies)
      push(out, 'Current medications', state.currentMeds)
      push(out, 'Past medical history', state.pmh)
      break
    case 'chiefConcern':
      push(out, 'Chief concern', state.chiefConcern)
      break
    case 'labs': {
      for (const [name, entry] of Object.entries(state.labs)) push(out, name, labResult(entry))
      const ua = UA_PARAMS.map((p) => (t(state.urinalysis[p]) ? `${p} ${t(state.urinalysis[p])}` : ''))
        .filter(Boolean)
        .join(', ')
      push(out, 'Urinalysis', ua)
      push(out, 'Lab comments', state.labComments)
      break
    }
    case 'diagnosis':
      push(out, 'Diagnosis', state.diagnosis)
      push(
        out,
        'Codes',
        state.diagnosisCodes.map((c) => (c.term ? `${c.code} ${c.term}` : c.code)).join(', '),
      )
      break
    case 'medications':
      for (const m of state.medications) {
        const name = ctx.formulary.find((f) => f.id === m.medId)?.name || t(m.medId)
        if (!name) continue
        push(out, name, [m.dose, m.freq, m.duration].map(t).filter(Boolean).join(' · ') || 'prescribed')
      }
      push(out, 'Treatment notes', state.treatmentNotes)
      break
    case 'procedures':
      push(out, 'Procedures', state.procedures.join(', '))
      break
    case 'referral':
      if (t(state.referralType) && state.referralType !== 'None') {
        push(out, 'Referral', `${t(state.referralType)}${t(state.referralDate) ? ` · ${t(state.referralDate)}` : ''}`)
      }
      break
    case 'imaging':
      push(out, 'Imaging', state.imagingType)
      push(out, 'Findings', state.imagingFindings)
      break
    case 'surgery':
      if (state.surgeryPerformed) {
        push(out, 'Surgery', t(state.surgeryType) || 'performed')
        push(out, 'Surgical notes', state.surgeryNotes)
      }
      break
    case 'notes':
      push(out, 'Notes', state.notes)
      break
    default:
      break
  }
  return out
}
