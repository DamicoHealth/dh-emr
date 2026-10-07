/**
 * Typed encounter form state.
 *
 * The legacy form kept its state in the live DOM plus a scatter of module-level
 * globals and Sets (selectedProcedures, accessPainLevel, selectedImagingType...),
 * which is the root cause of most reported entry glitches: state that survives
 * between patients, buttons whose highlight desyncs from the data, and values
 * that cannot be cleared. Here every field is explicit and serializable.
 */
import { todayLocal } from '../../domain/today'
import type { CustomFields } from '../../types/record'

export interface LabInputToggle {
  kind: 'toggle'
  ordered: boolean
  result: string
}
export interface LabInputNumeric {
  kind: 'numeric'
  ordered: boolean
  value: string
  unit: string
  interpretation: string
}
export type LabInput = LabInputToggle | LabInputNumeric

export interface MedLine {
  /** stable across edits: kept from the saved record, minted only for new lines */
  id: string
  medId: string
  dose: string
  freq: string
  duration: string
}

export interface EncounterFormState {
  // encounter
  site: string
  date: string
  provider: string
  // patient
  givenName: string
  familyName: string
  sex: string
  dobText: string // as typed, DD/MM/YYYY
  dobIso: string // resolved ISO, '' when unknown
  dobUnknown: boolean
  ageEstimate: string
  phone: string
  mrn: string
  // vitals
  temp: string
  bp: string
  weight: string
  pregnant: string
  breastfeeding: string
  // history
  allergies: string
  currentMeds: string
  pmh: string
  chiefConcern: string
  complaints: string[]
  // labs
  labs: Record<string, LabInput>
  labComments: string
  urinalysis: Record<string, string>
  // clinical
  diagnosis: string
  diagnosisCodes: { code: string; term?: string }[]
  medications: MedLine[]
  treatmentNotes: string
  procedures: string[]
  // imaging / surgery
  imagingType: string
  imagingFindings: string
  surgeryPerformed: boolean
  surgeryType: string
  surgeryNotes: string
  // referral
  referralType: string
  referralDate: string
  notes: string
  // custom (admin-defined) answers for fields the active template renders
  customFields: CustomFields
}

export function emptyFormState(today = todayLocal()): EncounterFormState {
  return {
    site: '',
    date: today,
    provider: '',
    givenName: '',
    familyName: '',
    sex: '',
    dobText: '',
    dobIso: '',
    dobUnknown: false,
    ageEstimate: '',
    phone: '',
    mrn: '',
    temp: '',
    bp: '',
    weight: '',
    pregnant: '',
    breastfeeding: '',
    allergies: '',
    currentMeds: '',
    pmh: '',
    chiefConcern: '',
    complaints: [],
    labs: {},
    labComments: '',
    urinalysis: {},
    diagnosis: '',
    diagnosisCodes: [],
    medications: [],
    treatmentNotes: '',
    procedures: [],
    imagingType: '',
    imagingFindings: '',
    surgeryPerformed: false,
    surgeryType: '',
    surgeryNotes: '',
    referralType: 'None',
    referralDate: '',
    notes: '',
    customFields: {},
  }
}

/** DD/MM/YYYY (or DDMMYYYY) -> ISO. '' when unparseable. Ported from helpers.js. */
export function parseDOBString(s: string): string {
  if (!s) return ''
  const digits = s.replace(/\D/g, '')
  if (digits.length !== 8) return ''
  const dd = digits.slice(0, 2)
  const mm = digits.slice(2, 4)
  const yyyy = digits.slice(4, 8)
  const d = Number(dd)
  const m = Number(mm)
  const y = Number(yyyy)
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return ''
  return `${yyyy}-${mm}-${dd}`
}

export function isoToDOBString(iso: string): string {
  if (!iso || iso.length < 10) return ''
  const p = iso.split('-')
  return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : ''
}

/** An age estimate synthesizes a 01/01/YYYY DOB, matching the legacy behavior. */
export function dobFromAgeEstimate(age: string, now = new Date()): string {
  const n = parseInt(age, 10)
  if (Number.isNaN(n) || n < 0 || n >= 150) return ''
  return `${now.getFullYear() - n}-01-01`
}
