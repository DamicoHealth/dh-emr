/**
 * The role visibility model (DH EMR Clinic).
 *
 * Roles are FIXED: reception, triage, provider, lab, pharmacy, plus the
 * admin flag on the account (users_profiles.role + is_admin). What makes
 * Clinic an EMR rather than a shared form is that each role lands on its
 * own workspace and sees its own slice of the ONE shared visit record: the
 * resolver below decides, per section of the org's template, whether a role
 * EDITS it, only VIEWS it, or does not see it at all.
 *
 * Defaults ship in code (DEFAULT_ROLE_ACCESS). An org changes them per
 * section through the template builder, which stores a sparse `roles`
 * override on the section (src/config/types SectionRoles); a schema without
 * overrides resolves exactly to the defaults, so nothing stored before roles
 * existed changes meaning.
 *
 * HONEST LIMIT (documented in the guides): roles are a workflow layer, not a
 * security wall. Any approved staff account can read the org's records; the
 * server cannot enforce field-level permissions.
 *
 * PURE: no React, no storage. Everything here is deterministically testable
 * (tests/roles.test.ts).
 */
import type { EffectiveSection, SectionRoles } from './types'

export const ROLES = ['reception', 'triage', 'provider', 'lab', 'pharmacy'] as const
export type Role = (typeof ROLES)[number]

/** UI copy for each role. Keep exact: the guides quote them. */
export const ROLE_LABELS: Record<Role, string> = {
  reception: 'Reception',
  triage: 'Triage',
  provider: 'Provider',
  lab: 'Lab',
  pharmacy: 'Pharmacy',
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v)
}

/**
 * The stored role string -> a fixed role. users_profiles.role is TEXT on the
 * server by design, so a device can meet values outside today's list:
 *  - 'nurse' was the pre-split name of the triage station (kept as an alias
 *    so an account approved under it keeps working after the rename);
 *  - anything else resolves to provider, the full form. A stranded account
 *    that can edit nothing is a worse failure than one that sees the whole
 *    visit, and the admin's Staff screen shows the odd value so it can be
 *    corrected.
 */
export function normalizeRole(role: string | null | undefined): Role {
  const r = (role || '').trim().toLowerCase()
  if (isRole(r)) return r
  if (r === 'nurse') return 'triage'
  return 'provider'
}

export type SectionMode = 'edit' | 'view' | 'hidden'

/**
 * Shipped defaults, by role: the section ids the role edits and the ones it
 * only views. Everything else is hidden from that role. Section ids are the
 * built-in ids from BUILTIN_SECTIONS; 'all' covers custom sections too, and
 * `editExcept` carves view-only sections out of an 'all' edit list.
 *
 * The provider edits the clinical sections and every custom section, and
 * VIEWS Patient and Vitals: in a clinic those are reception's and triage's
 * work, already done by the time the provider opens the visit. Alec's first
 * review of the live demo was the provider getting "the whole chart, with
 * vitals to be put in"; an org whose providers do take vitals flips that
 * one checkbox in the template builder's role grid.
 */
export const DEFAULT_ROLE_ACCESS: Record<
  Role,
  { edit: readonly string[] | 'all'; editExcept?: readonly string[]; view: readonly string[] | 'all' }
> = {
  reception: { edit: ['encounter', 'patient'], view: 'all' },
  triage: { edit: ['vitals', 'history', 'chiefConcern', 'labs'], view: ['patient'] },
  provider: { edit: 'all', editExcept: ['patient', 'vitals'], view: 'all' },
  lab: { edit: ['labs'], view: ['patient', 'chiefConcern'] },
  pharmacy: { edit: ['medications'], view: ['patient', 'diagnosis'] },
}

function listHas(list: readonly string[] | 'all' | undefined, x: string): boolean {
  if (list === 'all') return true
  return Array.isArray(list) && list.includes(x)
}

/** The shipped default mode of one section for one role (no override, no admin). */
export function defaultSectionMode(sectionId: string, role: Role): SectionMode {
  const d = DEFAULT_ROLE_ACCESS[role]
  if (listHas(d.edit, sectionId) && !d.editExcept?.includes(sectionId)) return 'edit'
  if (listHas(d.view, sectionId)) return 'view'
  return 'hidden'
}

/**
 * The mode of one section for one account. Admins edit everything. The
 * section's stored override wins per key when present (a partial override
 * falls back to the default for the key it leaves out); edit implies view.
 * The section's own `hidden` flag (admin hid it for everyone) is the
 * caller's concern - see sectionsForRole.
 */
export function sectionModeFor(
  section: Pick<EffectiveSection, 'id' | 'roles'>,
  role: string,
  isAdmin: boolean,
): SectionMode {
  if (isAdmin) return 'edit'
  const r = normalizeRole(role)
  const o = section.roles
  const canEdit =
    o && o.edit !== undefined ? listHas(o.edit, r) : defaultSectionMode(section.id, r) === 'edit'
  if (canEdit) return 'edit'
  const canView =
    o && o.view !== undefined ? listHas(o.view, r) : defaultSectionMode(section.id, r) !== 'hidden'
  return canView ? 'view' : 'hidden'
}

/** A section resolved for one account: the effective section plus its mode. */
export interface RoleSection extends EffectiveSection {
  mode: 'edit' | 'view'
}

/**
 * The sections an account sees on the visit form, in schema order, each with
 * its mode. Sections the admin hid for everyone are never returned, whatever
 * the role says; sections hidden from this role are omitted.
 */
export function sectionsForRole(
  schema: { sections: EffectiveSection[] },
  role: string,
  isAdmin: boolean,
): RoleSection[] {
  const out: RoleSection[] = []
  for (const s of schema.sections) {
    if (s.hidden) continue
    const mode = sectionModeFor(s, role, isAdmin)
    if (mode === 'hidden') continue
    out.push({ ...s, mode })
  }
  return out
}

/**
 * The full per-role grid for one section, as the builder shows it. Admins
 * are not a row: they always edit everything.
 */
export function roleGridFor(section: Pick<EffectiveSection, 'id' | 'roles'>): Record<Role, SectionMode> {
  const grid = {} as Record<Role, SectionMode>
  for (const r of ROLES) grid[r] = sectionModeFor(section, r, false)
  return grid
}

/**
 * Materialize the grid as a full override to store: both keys written,
 * edit implies view. The builder calls this after every checkbox change so
 * the stored value is unambiguous (a partial override is tolerated on read,
 * never produced on write).
 */
export function materializeRoles(grid: Record<Role, SectionMode>): SectionRoles {
  const view: string[] = []
  const edit: string[] = []
  for (const r of ROLES) {
    const m = grid[r]
    if (m === 'edit') {
      edit.push(r)
      view.push(r)
    } else if (m === 'view') view.push(r)
  }
  return { view, edit }
}

/** One checkbox change on the grid: the next grid, with edit implying view. */
export function toggleGridCell(
  grid: Record<Role, SectionMode>,
  role: Role,
  cell: 'view' | 'edit',
  checked: boolean,
): Record<Role, SectionMode> {
  const next = { ...grid }
  if (cell === 'edit') next[role] = checked ? 'edit' : grid[role] === 'hidden' ? 'hidden' : 'view'
  else next[role] = checked ? (grid[role] === 'edit' ? 'edit' : 'view') : 'hidden'
  return next
}

// ----------------------------------------------------------- workspaces ---

/**
 * Which screen an account lands on. Lab and pharmacy have their own
 * screens; triage and the provider land on their STATION queue (the visits
 * waiting at their own board column, src/ui/board/StationScreen.tsx) with
 * the full Board one tab away; reception lives on the board itself, because
 * placing arrivals is its work.
 */
export type Workspace = 'board' | 'station' | 'lab' | 'pharmacy'

export function workspaceForRole(role: string): Workspace {
  const r = normalizeRole(role)
  if (r === 'lab') return 'lab'
  if (r === 'pharmacy') return 'pharmacy'
  if (r === 'triage' || r === 'provider') return 'station'
  return 'board'
}

/**
 * Whether lab RESULTS are locked for this account on the visit form. When
 * the board has a Lab station, results are the lab's to enter: every other
 * role that can edit the Labs section still ORDERS tests, but sees results
 * read-only, so a provider is never asked to "put the labs in". An org with
 * no Lab station (triage runs the rapid tests) leaves results open to
 * whoever edits the section. Admins are never locked. Station names are
 * org config, matched by name like the board's home column.
 */
export function labResultsLocked(role: string, isAdmin: boolean, stations: readonly string[]): boolean {
  if (isAdmin) return false
  if (normalizeRole(role) === 'lab') return false
  return stations.some((s) => s.trim().toLowerCase() === 'lab')
}

/** Analytics is a provider and admin concern. */
export function canSeeAnalytics(role: string, isAdmin: boolean): boolean {
  return isAdmin || normalizeRole(role) === 'provider'
}

/**
 * Who may start a brand-new visit from the shell's New visit action: the
 * roles whose defaults edit the Visit and Patient sections. Triage, lab and
 * pharmacy work on visits that already exist (the board's New patient
 * button still opens a registration form for them, with the required
 * sections editable - see src/ui/encounter/roleSections.ts).
 */
export function canRegisterVisit(role: string, isAdmin: boolean): boolean {
  if (isAdmin) return true
  const r = normalizeRole(role)
  return r === 'reception' || r === 'provider'
}
