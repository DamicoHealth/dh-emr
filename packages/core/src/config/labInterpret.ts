/**
 * Numeric lab interpretation.
 *
 * SNAPSHOT SEMANTICS: interpretation (and unit) are computed AT ENTRY TIME and
 * stored on the record's lab entry. They are never recomputed for stored
 * records - the org may edit its reference ranges later, and the record keeps
 * its own copy forever.
 *
 * Range matching (ported verbatim from interpretNumericLab in the previous
 * implementation): min is INCLUSIVE (v >= min), max is EXCLUSIVE (v < max),
 * an undefined bound is open, the FIRST matching range wins. An empty or
 * non-numeric value interprets as ''.
 */
import type { LabEntry } from '../types/record'
import type { CustomLabTest, LabRange } from './types'

/** Interpretation label for a numeric value, or '' when none applies. */
export function interpretLab(value: string, ranges?: LabRange[]): string {
  const v = parseFloat(value)
  if (!ranges || !value || Number.isNaN(v)) return ''
  for (const r of ranges) {
    const aboveMin = r.min === undefined || v >= r.min
    const belowMax = r.max === undefined || v < r.max
    if (aboveMin && belowMax) return r.label
  }
  return ''
}

/** The full matching range (label + color) for UI badges, or null. */
export function interpretLabRange(value: string, ranges?: LabRange[]): LabRange | null {
  const v = parseFloat(value)
  if (!ranges || !value || Number.isNaN(v)) return null
  for (const r of ranges) {
    const aboveMin = r.min === undefined || v >= r.min
    const belowMax = r.max === undefined || v < r.max
    if (aboveMin && belowMax) return r
  }
  return null
}

/**
 * Build the stored lab entry for a numeric test at entry time. Both the unit
 * and the interpretation are snapshotted onto the entry; the record keeps
 * this copy even if the org later edits the test's ranges or unit.
 */
export function snapshotNumericLab(test: CustomLabTest, value: string): LabEntry {
  return {
    ordered: !!value,
    type: 'numeric',
    value,
    unit: test.unit || '',
    interpretation: interpretLab(value, test.ranges),
  }
}
