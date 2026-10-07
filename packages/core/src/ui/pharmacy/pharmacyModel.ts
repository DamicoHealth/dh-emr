/**
 * The Pharmacy workspace's selection and write logic. PURE: records in,
 * lists and patched records out. Dispensing is stored ON THE MEDICATION
 * LINE (Medication.dispensed, inside the medications JSONB), written through
 * records.update by the screen so sync_version bumps and the mark replicates
 * like any other edit. No schema change.
 *
 * A line is "undispensed" when it names a drug and carries no dispensed
 * mark. Scoped to today's visits, like the board.
 */
import type { MedDispense, Medication, PatientRecord } from '../../types/record'
import type { FormularyEntry } from '../../config/types'

export function isUndispensed(m: Medication): boolean {
  return !!m.medId && !m.dispensed
}

/** This visit's prescription lines still to hand over, in prescription order. */
export function undispensedLines(rec: Pick<PatientRecord, 'medications'>): Medication[] {
  return (rec.medications || []).filter(isUndispensed)
}

/** This visit's lines already dispensed. */
export function dispensedLines(rec: Pick<PatientRecord, 'medications'>): Medication[] {
  return (rec.medications || []).filter((m) => !!m.medId && !!m.dispensed)
}

function stamp(r: PatientRecord): string {
  return r.flow_updated_at || r.savedAt || ''
}

/**
 * Today's non-deleted visits with at least one undispensed prescription,
 * longest-waiting first.
 */
export function visitsAwaitingDispense(
  records: readonly PatientRecord[],
  todayIso: string,
): PatientRecord[] {
  return records
    .filter((r) => !r.deleted && r.date === todayIso && undispensedLines(r).length > 0)
    .sort((a, b) => {
      const sa = stamp(a)
      const sb = stamp(b)
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
}

/** Today's non-deleted visits with at least one dispensed line (for corrections). */
export function visitsDispensedToday(
  records: readonly PatientRecord[],
  todayIso: string,
): PatientRecord[] {
  return records.filter(
    (r) => !r.deleted && r.date === todayIso && dispensedLines(r).length > 0,
  )
}

/**
 * The record with one line marked dispensed. For records.update: returns a
 * NEW record (the kernel bumps sync_version and savedAt itself). An unknown
 * line id leaves the medications untouched, so a stale screen cannot stamp
 * a line that was removed on another device.
 */
export function dispensePatch(rec: PatientRecord, lineId: string, mark: MedDispense): PatientRecord {
  return {
    ...rec,
    medications: (rec.medications || []).map((m) =>
      m.id === lineId ? { ...m, dispensed: { qty: mark.qty, by: mark.by, at: mark.at } } : m,
    ),
  }
}

/** The record with one line's dispensed mark removed (an honest mistake, undone). */
export function undispensePatch(rec: PatientRecord, lineId: string): PatientRecord {
  return {
    ...rec,
    medications: (rec.medications || []).map((m) => {
      if (m.id !== lineId || !m.dispensed) return m
      const { dispensed: _dropped, ...rest } = m
      return rest
    }),
  }
}

/**
 * The quantity the pharmacist is asked to confirm: the line's computed qty,
 * or null when the dose could not be read (the form shows "no qty" there;
 * the pharmacist counts by hand and types it).
 */
export function suggestedQty(m: Pick<Medication, 'qty'>): number | null {
  return typeof m.qty === 'number' && Number.isFinite(m.qty) ? m.qty : null
}

/** A typed quantity -> what gets stored: a non-negative number, else null. */
export function parseQty(text: string): number | null {
  const t = text.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export function medName(m: Pick<Medication, 'medId'>, formulary: readonly FormularyEntry[]): string {
  const f = formulary.find((x) => x.id === m.medId)
  return f ? f.name : m.medId
}
