/**
 * Built-in plain-list defaults and fixed clinical constants, ported from
 * packages/pwa/state.js in the previous implementation.
 *
 * The kernel returns null for a key the org has never customized; the app
 * then falls back to these. 'Site A' / 'Physician A' are real values as far
 * as the form is concerned, so isPlaceholderConfig() (keys.ts) exists to nag
 * a device that is still filing records under them.
 */
import type { HiddenPresets } from '../types'
import { DEFAULT_LAB_TESTS } from './labTests'

export const DEFAULT_SITES: string[] = ['Site A']
export const DEFAULT_PHYSICIANS: string[] = ['Physician A']

export const DEFAULT_PROCEDURES: string[] = [
  'I&D (Incision & Drainage)',
  'Wound Closure/Sutures',
  'Wound Debridement',
  'Joint Injection',
  'Foreign Body Removal',
  'Splinting/Casting',
]

export const DEFAULT_REFERRAL_TYPES: string[] = [
  'None',
  'Surgery',
  'Follow-up',
  'Specialist',
  'Hospital',
  'Lab Work',
]

export const DEFAULT_COMPLAINTS: string[] = [
  'Abdominal Pain',
  'Dysuria',
  'Fever',
  'Cough',
  'Headache',
  'Skin Rash/Itching',
  'Diarrhea',
  'Body/Joint Pain',
  'Wound/Injury',
  'Eye Problem',
]

/**
 * The legacy default hiddenPresets object. Default-hidden lab tests are the
 * built-ins with enabledByDefault false: 'Hepatitis C (Anti-HCV)',
 * 'COVID-19 Rapid', 'TB (AFB Smear)'. The 'diagnoses' and 'rxPresets'
 * categories are legacy-only but must be preserved when writing.
 */
export function defaultHiddenPresets(): HiddenPresets {
  return {
    diagnoses: [],
    procedures: [],
    complaints: [],
    referralTypes: [],
    rxPresets: [],
    labTests: DEFAULT_LAB_TESTS.filter((t) => !t.enabledByDefault).map((t) => t.name),
  }
}

// ------------------------------------------------------- fixed constants ---

export const FREQUENCIES = [
  { value: 'once', label: 'Once (single dose)' },
  { value: 'q24h', label: 'Once daily q24h' },
  { value: 'q12h', label: 'Twice daily q12h' },
  { value: 'q8h', label: 'Three times daily q8h' },
  { value: 'q6h', label: 'Four times daily q6h' },
  { value: 'qhs', label: 'At bedtime qhs' },
  { value: 'bid-topical', label: 'Twice daily topical' },
  { value: 'prn', label: 'As needed PRN' },
] as const

export const DURATIONS = [
  'Single dose', '3d', '5d', '7d', '10d', '14d', '21d', '28d', '4 weeks', '6 weeks', 'Ongoing',
] as const

export const UA_PARAMS = [
  'leukocytes', 'nitrite', 'urobilinogen', 'protein', 'ph', 'blood', 'sg', 'ketones', 'bilirubin', 'glucose',
] as const

export const UA_OPTIONS: Record<string, string[]> = {
  leukocytes: ['NEG', 'Trace', '1+', '2+', '3+'],
  nitrite: ['NEG', 'POS'],
  urobilinogen: ['Normal', '1+', '2+', '3+'],
  protein: ['NEG', 'Trace', '1+', '2+', '3+'],
  ph: ['5.0', '6.0', '6.5', '7.0', '7.5', '8.0'],
  blood: ['NEG', 'Trace', '1+', '2+', '3+'],
  sg: ['1.005', '1.010', '1.015', '1.020', '1.025', '1.030'],
  ketones: ['NEG', 'Trace', '1+', '2+', '3+'],
  bilirubin: ['NEG', '1+', '2+', '3+'],
  glucose: ['NEG', 'Trace', '1+', '2+', '3+'],
}
