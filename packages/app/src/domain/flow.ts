/**
 * Patient-flow board logic (clinic mode). PURE: no React, no storage, no
 * clocks. Callers pass todayIso and now IN, so every rule here is
 * deterministically testable (tests/flow.test.ts).
 *
 * Station names are IDENTITY: a record points at its station by exact name
 * (records.flow_station), the same way it points at a site. All matching is
 * therefore exact and case-sensitive; renaming a station in config strands
 * visits under the old name, which boardGroups surfaces off-board rather
 * than hiding.
 */
import { DEFAULT_FLOW_STATIONS } from '../config/keys'
import type { PatientRecord } from '../types/record'

/** One board column: a station plus today's visits at it, in wait order. */
export interface BoardColumn {
  station: string
  /** Sorted by flow_updated_at ascending: longest-waiting first. */
  visits: PatientRecord[]
}

export interface BoardGroups {
  /** One column per unique station name, in configured board order. */
  columns: BoardColumn[]
  /**
   * Today's visits that are NOT on the board: no station yet, or a station
   * the org no longer configures. These are the check-in candidates.
   */
  offBoard: PatientRecord[]
}

/** The patch a station move writes onto a record. */
export interface FlowMove {
  flow_station: string
  flow_updated_at: string
}

/**
 * The org's station list, in board order. Falls back to
 * DEFAULT_FLOW_STATIONS when nothing is configured, and refuses an
 * unusable list (blank-only, empty, wrong shape) by falling back too: the
 * board must never render zero columns, because station 1 is where
 * check-in places patients.
 */
export function resolveStations(configured: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(configured)) return [...DEFAULT_FLOW_STATIONS]
  const cleaned: string[] = []
  for (const s of configured) {
    // Config is synced JSON, so guard the shape even though the type says
    // string[]: a malformed entry must not become a phantom station.
    if (typeof s !== 'string') continue
    const t = s.trim()
    if (t && !cleaned.includes(t)) cleaned.push(t)
  }
  return cleaned.length ? cleaned : [...DEFAULT_FLOW_STATIONS]
}

/** flow_updated_at orders a column; savedAt breaks the tie for legacy rows. */
function moveStamp(r: PatientRecord): string {
  return r.flow_updated_at || r.savedAt || ''
}

function byIso(stamp: (r: PatientRecord) => string) {
  return (a: PatientRecord, b: PatientRecord): number => {
    const sa = stamp(a)
    const sb = stamp(b)
    return sa < sb ? -1 : sa > sb ? 1 : 0
  }
}

/**
 * Group records into board columns for ONE local calendar day.
 *
 * Only today's non-deleted visits appear anywhere in the result: a visit
 * from a previous day never haunts today's columns, no matter what station
 * it was left on (yesterday's un-discharged patients are a Records-screen
 * concern, not a board one). Within a column, visits sort by
 * flow_updated_at ascending, so the longest-waiting patient is at the top.
 *
 * A visit whose flow_station is not in `stations` (renamed or removed
 * config) lands in offBoard instead of disappearing, so staff can place it
 * again.
 */
export function boardGroups(
  records: readonly PatientRecord[],
  stations: readonly string[],
  todayIso: string,
): BoardGroups {
  const byStation = new Map<string, PatientRecord[]>()
  for (const s of stations) if (!byStation.has(s)) byStation.set(s, [])
  const offBoard: PatientRecord[] = []

  for (const r of records) {
    if (r.deleted) continue
    if (r.date !== todayIso) continue
    const station = r.flow_station
    const column = station ? byStation.get(station) : undefined
    if (column) column.push(r)
    else offBoard.push(r)
  }

  for (const list of byStation.values()) list.sort(byIso(moveStamp))
  offBoard.sort(byIso((r) => r.savedAt || ''))

  // One column per unique name, in first-appearance order. resolveStations
  // already de-duplicates, but a raw list with a repeated name must not
  // render the same visit in two columns.
  return {
    columns: [...byStation.entries()].map(([station, visits]) => ({ station, visits })),
    offBoard,
  }
}

/**
 * The patch that moves a record to `station` at `nowIso`. Returns null for
 * a station that is not on the board (stale button, mid-edit config sync):
 * the caller must then leave the record untouched, because writing an
 * unknown station would make the visit vanish from every column.
 */
export function movePatch(
  station: string,
  stations: readonly string[],
  nowIso: string,
): FlowMove | null {
  if (!stations.includes(station)) return null
  return { flow_station: station, flow_updated_at: nowIso }
}

/**
 * Whole minutes this visit has waited at its current station. Null when the
 * record has no usable move stamp. Clock skew between devices can put
 * flow_updated_at in the local future; that clamps to 0, never negative.
 */
export function waitMinutes(
  r: Pick<PatientRecord, 'flow_updated_at'>,
  now: Date,
): number | null {
  const iso = r.flow_updated_at
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((now.getTime() - t) / 60_000))
}

/** "32 min", "1 h", "2 h 5 min" - the wait chip on a board card. */
export function formatWait(mins: number): string {
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** The LAST station is "done for the day" (renders collapsed on the board). */
export function isDone(station: string, stations: readonly string[]): boolean {
  return stations.length > 0 && station === stations[stations.length - 1]
}

/**
 * The station after `station` in board order - the tap-to-advance target.
 * Null at the last station (nowhere further) and for an unknown station
 * (advancing from a stranded name would be a guess).
 */
export function nextStation(station: string, stations: readonly string[]): string | null {
  const i = stations.indexOf(station)
  if (i < 0 || i >= stations.length - 1) return null
  return stations[i + 1] ?? null
}
