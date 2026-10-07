/**
 * The simulated account for the Clinic demo build.
 *
 * The real Clinic shell gates on an account the server has approved
 * (core/auth: loadCurrentProfile). The demo has no backend, so this module
 * stands in for that gate with ONE simulated active profile at a time: the
 * role the visitor picked in the "You are simulating" panel. The shell is
 * not forked for it - App.tsx asks these hooks for the profile and renders
 * exactly what it would render for a real account with that role, through
 * the same tabsFor() / landingFor() logic as production.
 *
 * Switching role changes the profile, never the data: the visitor can check
 * a patient in as Reception, triage them as Triage and dispense as Pharmacy,
 * and every save is attributed (user_id) to the simulated account through
 * the kernel's own setCurrentUserId, exactly as a real sign-in would.
 *
 * The chosen role persists in the kernel settings KV under ONE known key so
 * a reload keeps it. Nothing here touches storage keys it does not own.
 */
import type { ReactNode } from 'react'
import type { ActiveProfile } from '@dh/core/auth'
import { ROLE_LABELS, type Role } from '@dh/core/config/roles'
import { setCurrentUserId, settings } from '@dh/core/kernel'

/** The six seats on the panel: the five station roles plus an admin. */
export type DemoRoleId = Role | 'admin'

export interface DemoStaffMember {
  id: DemoRoleId
  /** Panel label: the role as the guides name it ("Reception"), "Admin" for the admin seat. */
  label: string
  /** The profile the shell renders for. userId is stable and fictional. */
  profile: ActiveProfile
  /** One line on the panel: what this person does. */
  does: string
  /** One line on the panel: where this role lands. */
  landsOn: string
}

/** Settings key (kernel KV) holding the picked role; reset by Reset demo. */
export const DEMO_ROLE_KEY = 'demoRole'
export const DEFAULT_DEMO_ROLE: DemoRoleId = 'reception'

/**
 * A fixed confirmation stamp: the shell never shows it, and the simulated
 * gate reports stale=false regardless. Fixed, so a re-seed is byte-stable.
 */
const CONFIRMED_AT = '2026-01-05T08:00:00.000Z'

function member(
  id: DemoRoleId,
  label: string,
  displayName: string,
  role: Role,
  isAdmin: boolean,
  does: string,
  landsOn: string,
): DemoStaffMember {
  return {
    id,
    label,
    profile: { userId: `demo-user-${id}`, displayName, role, isAdmin, confirmedAt: CONFIRMED_AT },
    does,
    landsOn,
  }
}

/**
 * The simulated roster, one seat per role. Every name is fictional. The
 * admin seat is a provider with the admin flag, the way a clinic's lead
 * clinician usually is; it gets the Staff screen and every editor.
 */
export const DEMO_ROSTER: readonly DemoStaffMember[] = [
  member(
    'reception',
    ROLE_LABELS.reception,
    'Esther Nakimuli',
    'reception',
    false,
    'Registers arrivals and checks them in',
    'Board, Check-in column',
  ),
  member(
    'triage',
    ROLE_LABELS.triage,
    'Grace Namara',
    'triage',
    false,
    'Takes vitals, history and the chief concern',
    'Board, Triage column',
  ),
  member(
    'provider',
    ROLE_LABELS.provider,
    'Dr. Amos Mensah',
    'provider',
    false,
    'Sees the patient, diagnoses and prescribes',
    'Board, Provider column',
  ),
  member(
    'lab',
    ROLE_LABELS.lab,
    'Peter Byaruhanga',
    'lab',
    false,
    'Enters results for ordered tests',
    'Lab page',
  ),
  member(
    'pharmacy',
    ROLE_LABELS.pharmacy,
    'Ruth Atim',
    'pharmacy',
    false,
    'Dispenses prescriptions and records what was handed over',
    'Pharmacy page',
  ),
  member(
    'admin',
    'Admin',
    'Dr. Lydia Okot',
    'provider',
    true,
    'A provider who also runs the clinic: staff, lists, templates',
    'Board, with Staff available',
  ),
]

export function demoMemberFor(id: DemoRoleId): DemoStaffMember {
  const m = DEMO_ROSTER.find((x) => x.id === id)
  if (!m) throw new Error(`Unknown demo role "${id}"`)
  return m
}

export function isDemoRoleId(v: unknown): v is DemoRoleId {
  return typeof v === 'string' && DEMO_ROSTER.some((m) => m.id === v)
}

/** "Grace N." / "Dr. A. Mensah": how a colleague is named in a toast. */
export function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return displayName
  const first = parts[0] ?? ''
  const last = parts[parts.length - 1] ?? ''
  if (/^dr\.?$/i.test(first) && parts.length >= 3) {
    const given = parts[1] ?? ''
    return `Dr. ${given.charAt(0)}. ${last}`
  }
  return `${first} ${last.charAt(0)}.`
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

let current: DemoRoleId = DEFAULT_DEMO_ROLE
const roleListeners = new Set<() => void>()

export function currentDemoRole(): DemoRoleId {
  return current
}

export function currentDemoProfile(): ActiveProfile {
  return demoMemberFor(current).profile
}

function publish(): void {
  // The kernel stamps user_id on new records from this; a real sign-in does
  // the same through loadCurrentProfile.
  setCurrentUserId(currentDemoProfile().userId)
}

/** Boot: adopt the stored pick (or the default) and publish its author id. */
export async function loadDemoRole(): Promise<DemoRoleId> {
  const stored = await settings.get<string>(DEMO_ROLE_KEY)
  current = isDemoRoleId(stored) ? stored : DEFAULT_DEMO_ROLE
  publish()
  return current
}

/** The panel's pick: store it, publish the author id, tell the shell. */
export async function setDemoRole(id: DemoRoleId): Promise<void> {
  if (!isDemoRoleId(id)) throw new Error(`Unknown demo role "${String(id)}"`)
  current = id
  publish()
  // Listeners first, so the shell lands on the new seat at once; the
  // persisted pick follows (a reload before it lands just keeps the old one).
  roleListeners.forEach((cb) => {
    try {
      cb()
    } catch {
      /* a listener must not break the switch */
    }
  })
  await settings.set(DEMO_ROLE_KEY, id)
}

export function onDemoRoleChange(cb: () => void): () => void {
  roleListeners.add(cb)
  return () => {
    roleListeners.delete(cb)
  }
}

// ---------------------------------------------------------------------------
// Records-changed signal: the simulated colleagues write through the kernel
// in THIS tab, which fires neither onExternalWrite (other tabs) nor the sync
// engine's onRecordsUpdated (there is no engine running), so the shell is
// told directly.
// ---------------------------------------------------------------------------

const recordListeners = new Set<() => void>()

export function notifyRecordsChanged(): void {
  recordListeners.forEach((cb) => {
    try {
      cb()
    } catch {
      /* ignore */
    }
  })
}

export function onRecordsChanged(cb: () => void): () => void {
  recordListeners.add(cb)
  return () => {
    recordListeners.delete(cb)
  }
}

// ---------------------------------------------------------------------------
// What the shell (App.tsx) asks the demo for. A TYPE only: App.tsx imports
// it with `import type`, so the production build carries nothing of this
// module; the object itself is built by createDemoAppHooks (index.ts) and
// passed in by main.tsx inside its DH_DEMO branch.
// ---------------------------------------------------------------------------

export interface DemoAppHooks {
  /** The simulated active profile right now. */
  profile(): ActiveProfile
  /** Fires after the panel switched role; the shell re-evaluates its gate. */
  onProfileChange(cb: () => void): () => void
  /** Fires after a simulated colleague wrote records; the shell refreshes. */
  onRecordsChanged(cb: () => void): () => void
  /** The Staff screen for the demo: the simulated roster, local only. */
  renderStaff(profile: ActiveProfile, onRefresh: () => void): ReactNode
  /** Shown above Settings: cloud and accounts are not available here. */
  settingsNote: ReactNode
  /** Replaces the sync chip: nothing syncs, and the chip says so. */
  syncChip: ReactNode
  /** The Account card's Sign out: not available in the demo, says so. */
  signOut(): Promise<void>
}
