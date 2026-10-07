/**
 * Save-time validation.
 *
 * Same rules as the legacy form, but each problem names the FIELD it belongs to
 * so the UI can focus it. The legacy version reported a missing MRN when the
 * real cause was "DOB Unknown with no age estimate" - the MRN is derived, so it
 * can never be filled in directly.
 */
import type { EncounterFormState } from './formState'

export interface ValidationProblem {
  /** For a custom field: which one, so the control can be marked and scrolled to. */
  fieldId?: string
  field: keyof EncounterFormState
  message: string
}

const TEMP_MIN = 25
const TEMP_MAX = 45

export function validateEncounter(s: EncounterFormState, now = new Date()): ValidationProblem[] {
  const problems: ValidationProblem[] = []
  const endOfToday = new Date(now)
  endOfToday.setHours(23, 59, 59, 999)

  // --- required ---
  if (!s.givenName.trim()) problems.push({ field: 'givenName', message: 'Given name is required.' })
  if (!s.familyName.trim()) problems.push({ field: 'familyName', message: 'Family name is required.' })
  if (!s.site) problems.push({ field: 'site', message: 'Site is required.' })
  if (!s.date) problems.push({ field: 'date', message: 'Visit date is required.' })
  if (s.sex !== 'M' && s.sex !== 'F') problems.push({ field: 'sex', message: 'Sex is required.' })

  if (s.dobUnknown) {
    // Point at the real cause instead of the derived MRN.
    if (!s.ageEstimate.trim()) {
      problems.push({
        field: 'ageEstimate',
        message: 'Enter an estimated age when the date of birth is unknown.',
      })
    }
  } else if (!s.dobIso) {
    problems.push({ field: 'dobText', message: 'Date of birth is required (DD/MM/YYYY).' })
  }

  // A single-letter name cannot form an MRN; say so rather than blaming the MRN.
  // Counts letters in ANY script, matching generateBaseMRN - the ASCII-only
  // version rejected every name written in a non-Latin alphabet and the message
  // gave the clinician no idea why.
  const letterCount = (v: string) =>
    Array.from(v.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).filter((ch) =>
      /\p{L}/u.test(ch),
    ).length
  const initialsOk = letterCount(s.givenName) >= 2 && letterCount(s.familyName) >= 2
  if (s.givenName.trim() && s.familyName.trim() && !initialsOk) {
    problems.push({
      field: 'givenName',
      message: 'The patient number needs at least two letters in both the given and family name.',
    })
  } else if (!s.mrn && problems.length === 0) {
    problems.push({
      field: 'mrn',
      message: 'A patient number could not be generated. Check the name and date of birth.',
    })
  }

  // --- plausibility ---
  if (s.dobIso) {
    const d = new Date(s.dobIso)
    if (!Number.isNaN(d.getTime()) && d > endOfToday) {
      problems.push({ field: 'dobText', message: 'Date of birth is in the future.' })
    }
  }
  if (s.date) {
    const d = new Date(s.date)
    if (!Number.isNaN(d.getTime()) && d > endOfToday) {
      problems.push({ field: 'date', message: 'Visit date is in the future.' })
    }
  }
  if (s.temp) {
    const t = parseFloat(s.temp)
    if (!Number.isNaN(t) && (t < TEMP_MIN || t > TEMP_MAX)) {
      problems.push({
        field: 'temp',
        message: `Temperature ${s.temp} °C is outside a plausible range (${TEMP_MIN}-${TEMP_MAX} °C). Check whether it was entered in Fahrenheit.`,
      })
    }
  }

  return problems
}
