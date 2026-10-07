/**
 * Which board column is "home" for a signed-in role. PURE.
 *
 * Station names are org config (flowStations) and identity on records, so
 * nothing here renames or assumes them. Reception's home is wherever
 * arrivals land: the FIRST station, whatever it is called. Every other role
 * is matched to a station by name, case-insensitively (the default list
 * carries Triage, Provider, Lab and Pharmacy); a role with no matching
 * station (lab, when an org has removed its Lab column) has no home column
 * and nothing is highlighted. The pre-split 'nurse' role resolves to triage
 * first.
 */
import { normalizeRole } from '../../config/roles'

export function homeStationFor(role: string, stations: readonly string[]): string | null {
  if (!stations.length) return null
  const r = normalizeRole(role)
  if (r === 'reception') return stations[0] ?? null
  return stations.find((s) => s.toLowerCase() === r) ?? null
}

/** Reception's primary action is placing arrivals on the board. */
export function checkInIsPrimary(role: string): boolean {
  return normalizeRole(role) === 'reception'
}
