/**
 * MRN generation + suffixing.
 *
 * Ported from generateBaseMRN() in the legacy app (vendored at
 * tests/fixtures/legacy/helpers.js) via the previous React port. The MRN is
 * 2 letters of the given name + 2 letters of the family name + DDMMYYYY.
 * Returns '' when it cannot be formed - callers must treat '' as
 * "cannot generate", never as a valid MRN.
 *
 * COMPATIBILITY CONTRACT: every MRN already in the field must keep generating
 * unchanged, byte for byte. tests/mrnParity.test.ts differential-tests this
 * module against the vendored legacy source on every commit.
 */

/**
 * Two initials from a name, in ANY script.
 *
 * This used to be `replace(/[^a-zA-Z]/g, '')`, which strips a name written in
 * Amharic, Tigrinya, Arabic, Khmer, Thai or Cyrillic down to nothing - so the
 * MRN came back empty and the patient simply could not be filed. The clinic
 * had to romanise the name to get past the form.
 *
 * ASCII output is unchanged for every name that worked before: NFD plus
 * combining-mark removal maps "José" to "Jose", which yields the same
 * "JO" the old ASCII strip produced. Only names with fewer than two Latin
 * letters take the second path. The legacy helpers.js carries the identical
 * implementation - the two apps must never disagree about an MRN.
 */
function twoInitials(name: string): string {
  // STEP 1 is byte-for-byte the original rule, applied to the ORIGINAL string.
  // Normalising first was a mistake: "Olafur" with an accented O strips to
  // "lafur" under the original rule and keys LA, but NFD turns it into "Olafur"
  // and keys OL. That silently re-keys a patient who is already in the records
  // and splits their chart in two. Any name that produced an MRN before must
  // produce the SAME one now, however odd that MRN looks.
  const ascii = name.replace(/[^a-zA-Z]/g, '')
  if (ascii.length >= 2) return ascii.substring(0, 2).toUpperCase()
  // STEP 2 only ever runs where the original rule returned '' and the patient
  // could not be filed at all, so it cannot change an existing MRN.
  const flat = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  const flatAscii = flat.replace(/[^a-zA-Z]/g, '')
  if (flatAscii.length >= 2) return flatAscii.substring(0, 2).toUpperCase()
  // STEP 3: any-script letters (Amharic, Arabic, Cyrillic, Thai, CJK, ...).
  const letters = Array.from(flat).filter((ch) => /\p{L}/u.test(ch))
  return letters.length >= 2 ? letters.slice(0, 2).join('').toUpperCase() : ''
}

export function generateBaseMRN(given: string, family: string, dobIso: string): string {
  if (!given || !family || !dobIso) return ''
  const g = twoInitials(given)
  const f = twoInitials(family)
  if (!g || !f) return ''
  const parts = dobIso.split('-')
  if (parts.length !== 3) return ''
  const [y, m, d] = parts
  if (y === undefined || m === undefined || d === undefined) return ''
  // DDMMYYYY comes from string-splitting the ISO date, never from a Date.
  return g + f + d + m + y
}

/**
 * The slice of a stored record that MRN suffixing needs. Structural so the
 * full PatientRecord (and test fixtures) both satisfy it.
 */
export interface MrnSuffixCandidate {
  mrn?: string | null
  givenName?: string | null
  familyName?: string | null
  deleted?: boolean
}

/**
 * The B..Z same-base-different-name rule, extracted as a pure function so the
 * UI cannot get it wrong. Suffix state lives NOWHERE persistent - there is no
 * counter anywhere; the final MRN is re-derived from the records every time.
 *
 * Rules (identical to the legacy EncounterForm useMemo):
 *  - A record shares the base when its mrn, with at most ONE trailing capital
 *    letter stripped (/[A-Z]$/), equals baseMrn. Soft-deleted records never
 *    count; this function skips them itself.
 *  - Same base AND same full name (given + ' ' + family, trimmed, compared
 *    case-insensitively) is the SAME patient: reuse that record's stored mrn
 *    verbatim, which may itself be suffixed.
 *  - Same base but a DIFFERENT name is a different human sharing initials+DOB:
 *    append the first unused letter from 'B'..'Z'. The unsuffixed original
 *    implicitly occupies 'A'. If B..Z are all taken, fall through to the base.
 *  - No collision at all: the base is the MRN.
 *
 * Caller contract: pass `${givenName} ${familyName}` as fullName, and when
 * EDITING an existing record exclude that record from existingRecords first
 * (matching against yourself would always "reuse" your own number). Editing
 * flows must also preserve the stored MRN verbatim unless the name or DOB
 * actually changed - recomputing can hand back a differently suffixed number
 * and detach the visit from the patient's other visits.
 */
export function resolveMrnSuffix(
  baseMrn: string,
  fullName: string,
  existingRecords: readonly MrnSuffixCandidate[],
): string {
  if (!baseMrn) return ''
  const full = fullName.trim().toLowerCase()
  const sameBase = existingRecords.filter(
    (r) => !r.deleted && (r.mrn || '').replace(/[A-Z]$/, '') === baseMrn,
  )
  const samePatient = sameBase.filter(
    (r) => `${r.givenName || ''} ${r.familyName || ''}`.trim().toLowerCase() === full,
  )
  const returning = samePatient[0]
  if (returning) return returning.mrn || ''
  if (sameBase.length) {
    const used = new Set(sameBase.map((r) => (r.mrn || '').replace(baseMrn, '') || 'A'))
    for (const letter of 'BCDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (!used.has(letter)) return baseMrn + letter
    }
  }
  return baseMrn
}
