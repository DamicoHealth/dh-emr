/**
 * Public surface of the Clinic demo module. main.tsx loads this module
 * ONLY inside its DH_DEMO branch (a dynamic import behind the build-time
 * literal, so a production build carries none of it) and uses three
 * things: bootDemo() before first render, createDemoAppHooks() to feed the
 * shell its simulated account, and <DemoShell /> around the app. Everything
 * else is exported for the demo tests.
 *
 * The demo is a LOCAL SIMULATION: a seeded clinic day in progress, a side
 * panel to pick the role you are simulating, and scripted colleagues who
 * keep the board moving. No backend, ever. The five demo safety laws
 * (REBUILD-HANDOFF section 7) are enforced here and pinned by
 * tests/clinicDemo.test.ts:
 *
 *   1. bootDemo and the seeder refuse to run unless the build set DH_DEMO.
 *   2. Storage is namespaced by the BUILD (DH_STORAGE_SUFFIX=-clinic-demo
 *      in build:demo); nothing here computes a prefix of its own.
 *   3. Nothing enumerates or deletes storage keys: re-seeding goes through
 *      the kernel's locked paths and known keys only.
 *   4. Nothing can sync: null credentials, the cloud guard refuses every
 *      connect path, the shell never starts the engine, the realtime
 *      trigger or auto-sync, the join-link boot path is bypassed, and the
 *      Staff screen is the simulated roster (no network, ever).
 *   5. Fictional patients and staff only; the banner says so.
 */
import { createElement } from 'react'
import type { ActiveProfile } from '@dh/core/auth'
import { DEMO_CLOUD_MESSAGE, installDemoCloudGuard } from './cloudGuard'
import { loadActivityPaused } from './activity'
import DemoStaffScreen from './DemoStaffScreen'
import { DEMO_SIGN_OUT_MESSAGE, DemoSettingsNote, DemoSyncChip } from './DemoNotes'
import {
  currentDemoProfile,
  loadDemoRole,
  onDemoRoleChange,
  onRecordsChanged,
  type DemoAppHooks,
} from './gate'
import { isDemoBuild, seedDemo } from './seed'

export { DEMO_CLOUD_MESSAGE, installDemoCloudGuard } from './cloudGuard'
export { DemoBanner, RESET_CONFIRM } from './DemoBanner'
export { DemoPanel, PANEL_TITLE } from './DemoPanel'
export { DemoShell, TOAST_MS } from './DemoShell'
export { default as DemoStaffScreen, DEMO_INVITE_MESSAGE } from './DemoStaffScreen'
export { DEMO_SETTINGS_NOTE, DEMO_SIGN_OUT_MESSAGE, DemoSettingsNote, DemoSyncChip } from './DemoNotes'
export {
  DEFAULT_DEMO_ROLE,
  DEMO_ROLE_KEY,
  DEMO_ROSTER,
  currentDemoProfile,
  currentDemoRole,
  demoMemberFor,
  isDemoRoleId,
  loadDemoRole,
  notifyRecordsChanged,
  onDemoRoleChange,
  onRecordsChanged,
  setDemoRole,
  shortName,
} from './gate'
export type { DemoAppHooks, DemoRoleId, DemoStaffMember } from './gate'
export {
  DEMO_ACTIVITY_CURSOR_KEY,
  DEMO_ACTIVITY_PAUSED_KEY,
  DEMO_DEVICE_ID,
  DEMO_DEVICE_NAME,
  DEMO_PENDING_STAFF_ID,
  DEMO_PROVIDERS,
  DEMO_SITES,
  DEMO_STAFF_KEY,
  DEMO_STATIONS,
  REFUSAL_MESSAGE,
  SEED_DAY_FLAG,
  SEED_FLAG,
  SEED_VERSION,
  buildDemoLibrary,
  buildDemoRecords,
  buildDemoStaff,
  buildEarlierVisits,
  buildTodayVisits,
  demoDaysAgo,
  demoVisitId,
  djb2,
  isDemoBuild,
  minutesBefore,
  resetDemo,
  seedDemo,
} from './seed'
export type { SeedOptions, SeedResult } from './seed'
export {
  SCRIPT,
  activityCursor,
  activityFinished,
  isActivityPaused,
  loadActivityPaused,
  onActivityPaused,
  setActivityPaused,
  simulateStep,
  stepDelayMs,
} from './activity'
export type { SimulateOptions, SimulatedAction, SimulatedKind } from './activity'

/**
 * Demo boot. Called from main.tsx BEFORE the app renders, only when the
 * build set DH_DEMO; the check here is the belt to that brace, because the
 * guard below would make a production build refuse every real connection.
 * Order: neuter every cloud path first, then seed (idempotent per
 * SEED_VERSION and per day), then adopt the stored seat and pause flag.
 */
export async function bootDemo(): Promise<void> {
  if (!isDemoBuild()) throw new Error('bootDemo refused: this build did not set DH_DEMO')
  installDemoCloudGuard()
  await seedDemo()
  await loadDemoRole()
  await loadActivityPaused()
}

/** What the shell asks the demo for (see DemoAppHooks in gate.ts). */
export function createDemoAppHooks(): DemoAppHooks {
  return {
    profile: currentDemoProfile,
    onProfileChange: onDemoRoleChange,
    onRecordsChanged,
    renderStaff: (profile: ActiveProfile, onRefresh: () => void) =>
      createElement(DemoStaffScreen, { profile, onRefresh }),
    settingsNote: createElement(DemoSettingsNote),
    syncChip: createElement(DemoSyncChip),
    signOut: async () => {
      window.alert(DEMO_SIGN_OUT_MESSAGE)
    },
  }
}

/** The note every refused cloud path shows (also the Settings note's first line). */
export const DEMO_NOT_AVAILABLE = DEMO_CLOUD_MESSAGE
