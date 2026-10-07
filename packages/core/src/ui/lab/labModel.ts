/**
 * The Lab workspace's selection logic. PURE: records in, lists out; the
 * caller passes todayIso (src/domain/today) so nothing here reads a clock.
 *
 * "Waiting on labs" means a lab entry that is ORDERED and has no result yet:
 * a toggle test with an empty result, or a numeric test with an empty value.
 * Those entries exist only because someone checked "Ordered" on the visit
 * form in role mode; a result entered later fills the same entry, which is
 * why the queue empties as the lab works through it. Scoped to today's
 * visits, like the board: yesterday's unfinished orders are a Visits-screen
 * concern.
 */
import type { LabEntry, PatientRecord } from '../../types/record'

export function isLabPending(entry: LabEntry | undefined | null): boolean {
  if (!entry || !entry.ordered) return false
  if (entry.type === 'numeric' || (entry.value !== undefined && entry.result === undefined)) {
    return !(entry.value && String(entry.value).trim())
  }
  return !(entry.result && String(entry.result).trim())
}

/** Names of this visit's labs that are ordered and not yet resulted, in stored order. */
export function pendingLabs(rec: Pick<PatientRecord, 'labs'>): string[] {
  const out: string[] = []
  for (const [name, entry] of Object.entries(rec.labs || {})) {
    if (isLabPending(entry)) out.push(name)
  }
  return out
}

/** Names of this visit's labs that are ordered AND resulted. */
export function resultedLabs(rec: Pick<PatientRecord, 'labs'>): string[] {
  const out: string[] = []
  for (const [name, entry] of Object.entries(rec.labs || {})) {
    if (entry && entry.ordered && !isLabPending(entry)) out.push(name)
  }
  return out
}

function stamp(r: PatientRecord): string {
  return r.flow_updated_at || r.savedAt || ''
}

/**
 * Today's non-deleted visits with at least one pending lab, longest-waiting
 * first (by the last station move, then savedAt, like a board column).
 */
export function visitsWaitingOnLabs(
  records: readonly PatientRecord[],
  todayIso: string,
): PatientRecord[] {
  return records
    .filter((r) => !r.deleted && r.date === todayIso && pendingLabs(r).length > 0)
    .sort((a, b) => {
      const sa = stamp(a)
      const sb = stamp(b)
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
}

/** Today's non-deleted visits with every ordered lab resulted (and at least one ordered). */
export function visitsResultedToday(
  records: readonly PatientRecord[],
  todayIso: string,
): PatientRecord[] {
  return records.filter(
    (r) =>
      !r.deleted &&
      r.date === todayIso &&
      pendingLabs(r).length === 0 &&
      resultedLabs(r).length > 0,
  )
}
