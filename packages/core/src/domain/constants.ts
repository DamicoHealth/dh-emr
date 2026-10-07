/**
 * Prescribing constants ported from the legacy app's clinical constants.
 *
 * Every FREQUENCIES value must be a key of FREQ_DOSES_PER_DAY in medQty.ts -
 * calcMedQty looks the value up verbatim, and an unknown key silently becomes
 * "no quantity". tests/medQty.test.ts enforces the alignment.
 *
 * DEFAULT_FORMULARY, lab catalogs and the other org-customizable lists live in
 * src/config (the org customization model), not here.
 */
export const FREQUENCIES = [
  { value: 'once', label: 'Once (single dose)' },
  { value: 'q24h', label: 'Once daily q24h' },
  { value: 'q12h', label: 'Twice daily q12h' },
  { value: 'q8h', label: 'Three times daily q8h' },
  { value: 'q6h', label: 'Four times daily q6h' },
  { value: 'qhs', label: 'At bedtime qhs' },
  { value: 'bid-topical', label: 'Twice daily topical' },
  { value: 'prn', label: 'As needed PRN' }
] as const

/**
 * '4 weeks' and '6 weeks' deliberately do NOT match calcMedQty's /^(\d+)d$/
 * duration parser, so they produce no quantity - that is the legacy behavior.
 */
export const DURATIONS = ['Single dose', '3d', '5d', '7d', '10d', '14d', '21d', '28d', '4 weeks', '6 weeks', 'Ongoing'] as const
