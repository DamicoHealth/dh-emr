/**
 * The Clinic demo: a local simulation of a clinic day, no backend ever.
 *
 * The five safety laws under test are law because the old demo seeder
 * wiped a real deployment by enumerating and deleting dhemr_ keys on load
 * (REBUILD-HANDOFF.md section 7):
 *
 *   1. The seeder (and bootDemo) refuse to run unless the build set DH_DEMO.
 *   2. Storage is namespaced by the BUILD (asserted against build:demo, and
 *      against the Field demo's suffix: both demos live on one origin).
 *   3. It never enumerates-and-deletes storage keys (source scan AND
 *      behavioral: foreign keys survive a reset); ids never come from
 *      Math.random or Date.now.
 *   4. It can never sync: null credentials, the cloud guard refuses every
 *      connect path, the shell starts neither the engine nor the realtime
 *      trigger nor auto-sync, the join-link boot path is bypassed, the
 *      Staff screen is the simulated roster, and fetch is never called.
 *   5. Fictional patients and staff only, and the banner says so.
 *
 * Plus: the seed inventory (per-station counts, the roster of six, ordered
 * labs and undispensed prescriptions, the showcase patients), the role
 * switch landing on the right workspace through the REAL shell and the
 * real Board / Lab / Pharmacy screens, the scripted colleague activity
 * (exactly one action per step, deterministic, idempotent per
 * SEED_VERSION, resilient to the visitor), and Reset restoring the day.
 *
 * The shell's demo branches are behind the build literal __DH_DEMO__,
 * which vitest exposes as a global (vite define), so the shell cases stub
 * it to true; the law-1 cases leave it as the build sets it (false).
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { resetStorage } from '../../core/tests/setup'

// The heavy screens the demo cases do not exercise. The Board, Lab and
// Pharmacy screens are the REAL ones so the landing is proven end to end.
vi.mock('@dh/core/ui/encounter/EncounterForm', () => ({
  __esModule: true,
  default: () => null,
  EncounterForm: () => null,
}))
vi.mock('@dh/core/ui/records/RecordsScreen', () => ({
  __esModule: true,
  default: () => React.createElement('div', null, 'RECORDS STUB'),
  RecordsScreen: () => null,
}))
vi.mock('@dh/core/ui/analytics/AnalyticsScreen', () => ({
  __esModule: true,
  default: () => React.createElement('div', null, 'ANALYTICS STUB'),
}))
vi.mock('@dh/core/ui/settings/SettingsScreen', () => ({
  __esModule: true,
  default: (props: { onSignOut?: () => Promise<void> }) =>
    React.createElement(
      'div',
      null,
      'SETTINGS STUB',
      React.createElement(
        'button',
        { type: 'button', onClick: () => void props.onSignOut?.() },
        'Sign out',
      ),
    ),
}))

import { config, records, settings } from '@dh/core/kernel'
import { CONFIG_PUSH_KEYS, DEFAULT_FLOW_STATIONS, getConfig, loadLibraryDetailed } from '@dh/core/config/keys'
import { ROLES } from '@dh/core/config/roles'
import { boardGroups } from '@dh/core/domain/flow'
import { generateBaseMRN } from '@dh/core/domain/mrn'
import { todayLocal } from '@dh/core/domain/today'
import { LEGACY_SHARED_DEVICE_IDS, encodeJoinLink, getDeviceId, realtimeTrigger, syncEngine } from '@dh/core/sync'
import type { PatientRecord } from '@dh/core/types/record'
import { pendingLabs, visitsWaitingOnLabs } from '@dh/core/ui/lab/labModel'
import { undispensedLines, visitsAwaitingDispense } from '@dh/core/ui/pharmacy/pharmacyModel'
import type { StaffRow } from '@dh/core/ui/staff/staffApi'
// Raw sources for the enumerate-and-delete scan (vite ?raw imports).
import activitySrc from '../src/demo/activity.ts?raw'
import bannerSrc from '../src/demo/DemoBanner.tsx?raw'
import notesSrc from '../src/demo/DemoNotes.tsx?raw'
import panelSrc from '../src/demo/DemoPanel.tsx?raw'
import shellSrc from '../src/demo/DemoShell.tsx?raw'
import staffSrc from '../src/demo/DemoStaffScreen.tsx?raw'
import gateSrc from '../src/demo/gate.ts?raw'
import guardSrc from '../src/demo/cloudGuard.ts?raw'
import indexSrc from '../src/demo/index.ts?raw'
import seedSrc from '../src/demo/seed.ts?raw'
import pkg from '../package.json'
import fieldPkg from '../../field/package.json'
import { App } from '../src/App'
import {
  DEMO_ACTIVITY_CURSOR_KEY,
  DEMO_ACTIVITY_PAUSED_KEY,
  DEMO_CLOUD_MESSAGE,
  DEMO_DEVICE_ID,
  DEMO_INVITE_MESSAGE,
  DEMO_PENDING_STAFF_ID,
  DEMO_PROVIDERS,
  DEMO_ROLE_KEY,
  DEMO_ROSTER,
  DEMO_SITES,
  DEMO_STAFF_KEY,
  DEMO_STATIONS,
  DemoBanner,
  DemoShell,
  SCRIPT,
  SEED_DAY_FLAG,
  SEED_FLAG,
  SEED_VERSION,
  activityCursor,
  activityFinished,
  bootDemo,
  buildDemoLibrary,
  createDemoAppHooks,
  currentDemoRole,
  demoDaysAgo,
  demoVisitId,
  installDemoCloudGuard,
  loadDemoRole,
  resetDemo,
  seedDemo,
  setActivityPaused,
  setDemoRole,
  simulateStep,
  stepDelayMs,
} from '../src/demo'

const h = React.createElement

/**
 * The seed moment. The real Board / Lab / Pharmacy screens read the clock
 * for "today", so the clinic day is seeded for the real local date; every
 * stamp is relative to this one injected moment, which makes re-seeds
 * byte-stable within a test.
 */
const NOW = new Date()
const TODAY = todayLocal(NOW)

const SETTINGS_KEYS = [
  SEED_FLAG,
  SEED_DAY_FLAG,
  DEMO_STAFF_KEY,
  DEMO_ACTIVITY_CURSOR_KEY,
  DEMO_ACTIVITY_PAUSED_KEY,
  DEMO_ROLE_KEY,
  'setupComplete',
  'standaloneMode',
  'deviceId',
  'deviceName',
  'deviceRole',
  'supabaseUrl',
  'supabaseKey',
  'authProfile',
]

async function clearDemoState(): Promise<void> {
  await resetStorage()
  for (const k of SETTINGS_KEYS) await settings.remove(k)
  for (const k of CONFIG_PUSH_KEYS) await config.remove(k)
  records.invalidate()
  // The in-memory seat and pause flag outlive a storage wipe.
  await loadDemoRole()
  await setActivityPaused(false)
  await settings.remove(DEMO_ACTIVITY_PAUSED_KEY)
  await settings.remove(DEMO_ROLE_KEY)
}

/** Seed with the TEST-ONLY build override (vitest builds with DH_DEMO unset). */
function seed(opts: { force?: boolean; today?: string; now?: Date } = {}) {
  return seedDemo({ demoBuild: true, today: TODAY, now: NOW, ...opts })
}

async function active(): Promise<PatientRecord[]> {
  return records.getActive()
}

async function todays(): Promise<PatientRecord[]> {
  return (await active()).filter((r) => r.date === TODAY)
}

/** Per-station counts of today's board, in DEMO_STATIONS order. */
async function stationCounts(): Promise<Record<string, number>> {
  const g = boardGroups(await active(), DEMO_STATIONS, TODAY)
  const out: Record<string, number> = {}
  for (const c of g.columns) out[c.station] = c.visits.length
  out.offBoard = g.offBoard.length
  return out
}

const step = (): Promise<Awaited<ReturnType<typeof simulateStep>>> =>
  simulateStep({ now: NOW, today: TODAY })

let fetchSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // SAFETY LAW 4 is also proven by absence: nothing in these cases may ever
  // reach the network.
  fetchSpy = vi.fn(async () => {
    throw new Error('The demo must never call fetch')
  })
  vi.stubGlobal('fetch', fetchSpy)
  await clearDemoState()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  syncEngine.updateCredentials(null, null)
})

// ---------------------------------------------------------------------------
// Safety law 1: refusal without DH_DEMO
// ---------------------------------------------------------------------------

describe('safety law 1: refuses outside a DH_DEMO build', () => {
  it('seedDemo() rejects when the build did not set DH_DEMO', async () => {
    // No demoBuild override: the vitest build has DH_DEMO unset, so the
    // seeder must refuse exactly like a production build would.
    await expect(seedDemo()).rejects.toThrow(/DH_DEMO/)
  })

  it('resetDemo() and bootDemo() refuse the same way', async () => {
    await expect(resetDemo()).rejects.toThrow(/DH_DEMO/)
    await expect(bootDemo()).rejects.toThrow(/DH_DEMO/)
  })

  it('a refused run writes NOTHING', async () => {
    await expect(seedDemo({ today: TODAY })).rejects.toThrow()
    expect(await settings.get(SEED_FLAG)).toBeNull()
    expect(await settings.get(SEED_DAY_FLAG)).toBeNull()
    expect(await settings.get('setupComplete')).toBeNull()
    expect(await settings.get('standaloneMode')).toBeNull()
    expect(await settings.get(DEMO_STAFF_KEY)).toBeNull()
    expect(await getConfig(config, 'sites')).toBeNull()
    expect(await getConfig(config, 'flowStations')).toBeNull()
    expect(await active()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Safety law 2: namespaced storage comes from the BUILD
// ---------------------------------------------------------------------------

describe('safety law 2: the demo build is namespaced', () => {
  it('build:demo sets DH_DEMO and the -clinic-demo suffix, into the site tree', () => {
    // The kernel namespaces everything from __DH_STORAGE_SUFFIX__ (its own
    // tests prove that); what the demo owns is the build script that MUST
    // set both env vars, or the demo shares a database with the product.
    const scripts = pkg.scripts as Record<string, string>
    const script = scripts['build:demo']
    expect(script).toBeTruthy()
    expect(script).toContain('DH_DEMO=1')
    expect(script).toContain('DH_STORAGE_SUFFIX=-clinic-demo')
    expect(script).toContain('--base=/demo/clinic/')
    expect(script).toContain('--outDir=../site/public/demo/clinic')
    // The product builds never set the demo flag.
    expect(scripts['build']).not.toContain('DH_DEMO')
    expect(scripts['build:local']).not.toContain('DH_DEMO')
  })

  it('differs from the Field demo suffix: both demos live on one origin', () => {
    const field = (fieldPkg.scripts as Record<string, string>)['build:demo'] ?? ''
    expect(field).toContain('DH_STORAGE_SUFFIX=-demo ')
    expect(field).not.toContain('-clinic-demo')
  })
})

// ---------------------------------------------------------------------------
// Safety law 3: never enumerate-and-delete; stable ids
// ---------------------------------------------------------------------------

describe('safety law 3: no enumerate-and-delete, ever', () => {
  it('no demo source touches storage keys, randomness or the epoch clock for ids', () => {
    const sources: Record<string, string> = {
      'seed.ts': seedSrc,
      'activity.ts': activitySrc,
      'gate.ts': gateSrc,
      'index.ts': indexSrc,
      'cloudGuard.ts': guardSrc,
      'DemoBanner.tsx': bannerSrc,
      'DemoNotes.tsx': notesSrc,
      'DemoPanel.tsx': panelSrc,
      'DemoShell.tsx': shellSrc,
      'DemoStaffScreen.tsx': staffSrc,
    }
    const forbidden = [
      /deleteDatabase/,
      // The demo never touches web storage directly at all: the kernel's
      // own locked paths and known keys are the only way in.
      /localStorage/,
      /sessionStorage/,
      /indexedDB\s*\.\s*databases/,
      /\.clear\s*\(/,
      // Deterministic seeding: stable hashes only.
      /Math\.random/,
      /Date\.now/,
    ]
    for (const [name, src] of Object.entries(sources)) {
      expect(src.length).toBeGreaterThan(0)
      for (const rx of forbidden) {
        expect(rx.test(src), `${name} must not match ${rx}`).toBe(false)
      }
    }
  })

  it('foreign storage keys survive seeding AND a forced reset', async () => {
    // Keys the demo does not own: another app's key, and a dhemr-prefixed
    // key that is not one of the seeder's known keys. The old incident was
    // exactly a prefix-wide enumerate-and-delete.
    localStorage.setItem('some-other-app', 'untouched')
    localStorage.setItem('dhemr_foreign_note', '"keep me"')
    localStorage.setItem('dhemr-clinic-demo_foreign', '"keep me too"')
    await seed()
    await seed({ force: true })
    expect(localStorage.getItem('some-other-app')).toBe('untouched')
    expect(localStorage.getItem('dhemr_foreign_note')).toBe('"keep me"')
    expect(localStorage.getItem('dhemr-clinic-demo_foreign')).toBe('"keep me too"')
  })

  it('re-seeding is deterministic: identical ids, patient numbers and stamps', async () => {
    await seed()
    const stamp = (r: PatientRecord) =>
      `${r.id}|${r.mrn}|${r.savedAt}|${r.flow_station ?? ''}|${r.flow_updated_at ?? ''}|${r.user_id ?? ''}`
    const before = (await active()).map(stamp).sort()
    await resetDemo({ demoBuild: true, today: TODAY, now: NOW })
    const after = (await active()).map(stamp).sort()
    expect(after).toEqual(before)
    for (const s of after) expect(s.startsWith('demo-')).toBe(true)
    // Medication line ids are stable hashes too.
    for (const r of await active()) {
      for (const m of r.medications) expect(m.id.startsWith('demo-')).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Safety law 4: can never sync
// ---------------------------------------------------------------------------

describe('safety law 4: the demo can never sync', () => {
  it('forces standalone mode with null credentials and completed setup', async () => {
    await seed()
    expect(await settings.get('standaloneMode')).toBe('true')
    expect(await settings.get('supabaseUrl')).toBeNull()
    expect(await settings.get('supabaseKey')).toBeNull()
    expect(await settings.get('setupComplete')).toBe('true')
    expect(await settings.get('deviceRole')).toBe('admin')
    expect(syncEngine.hasCloud()).toBe(false)
  })

  it('uses a stable device id that is NOT a legacy shared id and not the Field demo id', async () => {
    await seed()
    expect(LEGACY_SHARED_DEVICE_IDS).not.toContain(DEMO_DEVICE_ID)
    expect(DEMO_DEVICE_ID).not.toBe('demo-device')
    expect(await getDeviceId()).toBe(DEMO_DEVICE_ID)
  })

  it('the cloud guard refuses connect, verify and seed with the demo note', async () => {
    installDemoCloudGuard()
    const connect = await syncEngine.connectToProject(
      'https://example.supabase.co',
      'sb_publishable_x',
      'Demo iPad',
      'admin',
    )
    expect(connect.ok).toBe(false)
    expect(connect.error).toContain('not available in the demo')
    expect(connect.error).toBe(DEMO_CLOUD_MESSAGE)
    const verify = await syncEngine.verifyTables('https://example.supabase.co', 'sb_publishable_x')
    expect(verify.ok).toBe(false)
    expect(verify.error).toBe(DEMO_CLOUD_MESSAGE)
    const seeded = await syncEngine.seedConfig('https://example.supabase.co', 'sb_publishable_x')
    expect(seeded.ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('the cloud guard makes credential writes a no-op', async () => {
    await seed()
    installDemoCloudGuard()
    syncEngine.updateCredentials('https://example.supabase.co', 'sb_publishable_x')
    expect(syncEngine.hasCloud()).toBe(false)
    expect(await settings.get('supabaseUrl')).toBeNull()
    expect(await settings.get('supabaseKey')).toBeNull()
  })

  it('seeding, the roster and the simulated day never call fetch', async () => {
    await seed()
    for (let i = 0; i < 4; i++) await step()
    await resetDemo({ demoBuild: true, today: TODAY, now: NOW })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Seed inventory
// ---------------------------------------------------------------------------

describe('seed inventory', () => {
  beforeEach(async () => {
    await seed()
  })

  it('a clinic day in progress: the per-station counts, nothing off the board', async () => {
    expect(DEMO_STATIONS).toEqual(DEFAULT_FLOW_STATIONS)
    expect(DEMO_STATIONS).toEqual(['Check-in', 'Triage', 'Provider', 'Lab', 'Pharmacy', 'Done'])
    expect(await getConfig(config, 'flowStations')).toEqual(DEFAULT_FLOW_STATIONS)
    expect(await stationCounts()).toEqual({
      'Check-in': 3,
      Triage: 2,
      Provider: 1,
      Lab: 2,
      Pharmacy: 3,
      Done: 4,
      offBoard: 0,
    })
    expect((await todays()).length).toBe(15)
    // Plus a handful of earlier-day visits for the Visits screen.
    const earlier = (await active()).filter((r) => r.date !== TODAY)
    expect(earlier.length).toBeGreaterThanOrEqual(4)
    for (const r of earlier) expect(r.date < TODAY).toBe(true)
  })

  it('two visits wait on ordered labs, in the Lab column; three wait on undispensed prescriptions', async () => {
    const rows = await active()
    const labs = visitsWaitingOnLabs(rows, TODAY)
    expect(labs).toHaveLength(2)
    for (const r of labs) {
      expect(pendingLabs(r).length).toBeGreaterThan(0)
      expect(r.flow_station).toBe('Lab')
    }
    // Nobody else is in the Lab column: it is exactly the visits waiting on results.
    expect(rows.filter((r) => r.date === TODAY && r.flow_station === 'Lab')).toHaveLength(2)
    const rx = visitsAwaitingDispense(rows, TODAY)
    expect(rx).toHaveLength(3)
    for (const r of rx) {
      expect(undispensedLines(r).length).toBeGreaterThan(0)
      expect(r.flow_station).toBe('Pharmacy')
    }
    // Everyone who is done has been dispensed, by the pharmacist, by name.
    const done = rows.filter((r) => r.date === TODAY && r.flow_station === 'Done')
    expect(done).toHaveLength(4)
    for (const r of done) {
      expect(r.medications.length).toBeGreaterThan(0)
      for (const m of r.medications) expect(m.dispensed?.by).toBe('Ruth Atim')
    }
  })

  it('check-in arrivals carry demographics only; triage visits have vitals half-entered', async () => {
    const rows = await todays()
    const arrivals = rows.filter((r) => r.flow_station === 'Check-in')
    for (const r of arrivals) {
      expect(r.temp).toBe('')
      expect(r.bp).toBe('')
      expect(r.chiefConcern).toBe('')
      expect(r.mrn).toBeTruthy()
    }
    const triage = rows.filter((r) => r.flow_station === 'Triage')
    for (const r of triage) {
      expect(r.temp).not.toBe('')
      expect(r.bp === '' || r.weight === '').toBe(true)
    }
  })

  it('the roster: six seats, one per role plus an admin provider, and one pending signup', async () => {
    expect(DEMO_ROSTER).toHaveLength(6)
    const byRole = new Map(DEMO_ROSTER.filter((m) => !m.profile.isAdmin).map((m) => [m.profile.role, m]))
    for (const role of ROLES) expect(byRole.has(role), `a seat for ${role}`).toBe(true)
    const admins = DEMO_ROSTER.filter((m) => m.profile.isAdmin)
    expect(admins).toHaveLength(1)
    expect(admins[0]?.profile.role).toBe('provider')
    expect(admins[0]?.id).toBe('admin')
    expect(new Set(DEMO_ROSTER.map((m) => m.profile.userId)).size).toBe(6)

    const rows = (await settings.get<StaffRow[]>(DEMO_STAFF_KEY)) ?? []
    expect(rows).toHaveLength(7)
    for (const m of DEMO_ROSTER) {
      const row = rows.find((r) => r.id === m.profile.userId)
      expect(row?.display_name).toBe(m.profile.displayName)
      expect(row?.activated_at).toBeTruthy()
      expect(row?.revoked_at).toBeNull()
    }
    const pending = rows.filter((r) => !r.activated_at)
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe(DEMO_PENDING_STAFF_ID)
  })

  it('every record is stamped with the demo device, an author from the roster, and looks synced', async () => {
    const authors = new Set(DEMO_ROSTER.map((m) => m.profile.userId))
    for (const r of await active()) {
      expect(r.deviceId).toBe(DEMO_DEVICE_ID)
      expect(r.sync_version).toBe(r.synced_version)
      expect(authors.has(r.user_id ?? '')).toBe(true)
      expect(DEMO_SITES).toContain(r.site)
      expect(DEMO_PROVIDERS).toContain(r.provider)
    }
  })

  it('every patient number comes from the real generator for that patient', async () => {
    for (const r of await active()) {
      expect(r.mrn).toBe(generateBaseMRN(r.givenName, r.familyName, r.dob))
    }
  })

  it('has the Amharic-name patient at check-in, filed by the real MRN generator', async () => {
    const r = (await todays()).find((x) => x.givenName === 'አማራ')
    expect(r).toBeTruthy()
    expect(r!.flow_station).toBe('Check-in')
    expect(r!.mrn).toBe(generateBaseMRN('አማራ', 'ንጉሤ', '1988-06-15'))
    expect(r!.mrn.startsWith('አማ')).toBe(true)
  })

  it('has a malaria-positive visit with a SNAPSHOTTED numeric interpretation', async () => {
    const r = (await todays()).find((x) => x.givenName === 'Sarah')
    expect(r?.labs['Malaria RDT']?.result).toBe('POS')
    const hgb = r!.labs['Hemoglobin']!
    expect(hgb.type).toBe('numeric')
    expect(hgb.value).toBe('9.6')
    expect(hgb.unit).toBe('g/dL')
    expect(hgb.interpretation).toBe('Moderate Anemia')
    // And the diabetic review carries the glucose snapshot + legacy mirror.
    const glucose = (await active()).find((x) => x.labs['Blood Glucose'])
    expect(glucose?.labs['Blood Glucose']?.interpretation).toBe('Elevated')
    expect(glucose?.bloodGlucose).toBe('182')
  })

  it('has an antenatal visit on the Antenatal template, being seen by the provider', async () => {
    const r = (await todays()).find((x) => x.pregnant === 'Yes')
    expect(r).toBeTruthy()
    expect(r!.templateId).toBe('antenatal')
    expect(r!.flow_station).toBe('Provider')
    expect(r!.diagnosis).toBe('')
    expect(r!.labs['HCG/Pregnancy']?.result).toBe('POS')
    expect(r!.imaging?.modality).toBe('Ultrasound')
    expect(r!.customFields['demo-f-fhr']).toBe('Yes')
  })

  it('has paediatric visits whose patients stay children (DOB relative to seed day)', async () => {
    const kids = (await todays()).filter((x) => x.givenName === 'Samuel' || x.givenName === 'Robert')
    expect(kids).toHaveLength(2)
    for (const k of kids) {
      const ageYears = (Date.parse(TODAY) - Date.parse(k.dob)) / (365.25 * 24 * 3600 * 1000)
      expect(ageYears).toBeLessThan(18)
    }
    const samuel = kids.find((k) => k.givenName === 'Samuel')!
    expect(samuel.dob).toBe(demoDaysAgo(2300, TODAY))
    expect(samuel.weight).toBe('17')
    // 2 tabs x twice daily x 3 days, from the real calcMedQty.
    expect(samuel.medications[0]?.qty).toBe(12)
    expect(samuel.medications[0]?.dispensed).toBeUndefined()
  })

  it('has a penicillin-allergic patient at pharmacy whose prescription respects the allergy', async () => {
    const r = (await todays()).find((x) => /penicillin/i.test(x.allergies))
    expect(r).toBeTruthy()
    expect(r!.flow_station).toBe('Pharmacy')
    const penicillins = ['abx-amox500', 'abx-amox250', 'abx-benza']
    for (const m of r!.medications) expect(penicillins).not.toContain(m.medId)
    expect(r!.medications.map((m) => m.medId)).toContain('abx-cipro')
    expect(r!.medications[0]?.qty).toBe(10)
    expect(r!.notes).toMatch(/allergy/i)
  })

  it('has the returning patient: three earlier visits plus today, one patient number, a vitals trend', async () => {
    const mrn = generateBaseMRN('Amara', 'Nakato', '1991-04-12')
    const visits = (await active())
      .filter((r) => r.mrn === mrn)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
    expect(visits).toHaveLength(4)
    expect(visits.map((v) => v.temp)).toEqual(['39.2', '37.1', '36.9', '38.4'])
    expect(visits.map((v) => v.date)).toEqual([
      demoDaysAgo(96, TODAY),
      demoDaysAgo(38, TODAY),
      demoDaysAgo(4, TODAY),
      TODAY,
    ])
    expect(pendingLabs(visits[3]!)).toEqual(['Malaria RDT', 'Hemoglobin'])
  })

  it('has a completed referral among the earlier visits', async () => {
    const r = (await active()).find((x) => x.referralStatus === 'Completed')
    expect(r).toBeTruthy()
    expect(r!.referralType).toBe('Hospital')
    expect(r!.date < TODAY).toBe(true)
  })

  it('populates every interactive config key', async () => {
    expect(await getConfig(config, 'sites')).toEqual(DEMO_SITES)
    const providers = await getConfig(config, 'providers')
    expect(providers).toEqual(DEMO_PROVIDERS)
    expect(providers).toContain('Grace N., clinical officer')
    expect((await getConfig(config, 'formulary'))!.length).toBeGreaterThanOrEqual(30)
    expect((await getConfig(config, 'customLabTests'))!.length).toBeGreaterThan(0)
    expect((await getConfig(config, 'complaints'))!.length).toBeGreaterThan(0)
    expect((await getConfig(config, 'procedures'))!.length).toBeGreaterThan(0)
    expect((await getConfig(config, 'referralTypes'))!.length).toBeGreaterThan(0)
    expect((await getConfig(config, 'customDxPresets'))!.length).toBeGreaterThan(0)
    expect((await getConfig(config, 'rxPresets'))!.length).toBeGreaterThan(0)
    const hidden = await getConfig(config, 'hiddenPresets')
    expect(Array.isArray(hidden?.['labTests'])).toBe(true)
  })

  it('seeds a REAL two-template library with role visibility overrides and several field types', async () => {
    const { lib, synthesized } = await loadLibraryDetailed(config)
    expect(synthesized).toBe(false)
    expect(lib.templates.map((t) => t.name)).toEqual(['General Clinic', 'Antenatal Clinic'])
    for (const t of lib.templates) expect(t.enabled).toBe(true)
    const sections = lib.templates.flatMap((t) => t.schema.sections || [])
    const social = sections.find((s) => s.id === 'demo-sec-social')
    expect(social?.roles?.edit).toEqual(['triage', 'provider'])
    expect(social?.roles?.view).toBe('all')
    const antenatal = sections.find((s) => s.id === 'demo-sec-antenatal')
    expect(antenatal?.roles?.edit).toEqual(['triage', 'provider'])
    const fieldTypes = new Set(sections.flatMap((s) => (s.fields || []).map((f) => f.type)))
    for (const ty of ['select', 'multiselect', 'number', 'range', 'yesno', 'textarea', 'date']) {
      expect(fieldTypes.has(ty as never), `library must include a ${ty} field`).toBe(true)
    }
    const mirror = await getConfig(config, 'formSchema')
    expect(mirror?.sections).toEqual(lib.templates[0]!.schema.sections)
  })

  it('stores custom-field answers under ids that exist in the seeded library', async () => {
    const lib = buildDemoLibrary()
    const knownIds = new Set(
      lib.templates.flatMap((t) => (t.schema.sections || []).flatMap((s) => (s.fields || []).map((f) => f.id))),
    )
    const answered = (await active()).filter((r) => Object.keys(r.customFields).length > 0)
    expect(answered.length).toBeGreaterThanOrEqual(5)
    for (const r of answered) {
      for (const key of Object.keys(r.customFields)) {
        expect(knownIds.has(key), `answer key ${key} must exist in the library`).toBe(true)
      }
      expect(lib.templates.some((t) => t.id === r.templateId)).toBe(true)
    }
  })

  it('re-seeds for a new calendar day without a reset, so the board is never yesterday', async () => {
    const tomorrow = demoDaysAgo(-1, TODAY)
    const again = await seed({ today: tomorrow })
    expect(again.seeded).toBe(true)
    expect(await settings.get(SEED_DAY_FLAG)).toBe(tomorrow)
    expect((await active()).filter((r) => r.date === tomorrow)).toHaveLength(15)
    // Same version, same day: left alone.
    expect((await seed({ today: tomorrow })).seeded).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Safety law 5: the banner says the clinic is fictional
// ---------------------------------------------------------------------------

describe('safety law 5: the banner', () => {
  it('shows the fictional-clinic notice, the compliance line, Reset demo and Pause activity', () => {
    const onTogglePause = vi.fn()
    render(h(DemoBanner, { paused: false, onTogglePause }))
    expect(screen.getByText(/fictional clinic/i)).toBeTruthy()
    expect(screen.getByText(/never syncs anywhere/i)).toBeTruthy()
    expect(screen.getByText(/not a certified EHR and is not HIPAA-compliant/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset demo' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pause activity' }))
    expect(onTogglePause).toHaveBeenCalledTimes(1)
  })

  it('Reset demo asks for confirmation first and does nothing on cancel', async () => {
    await seed()
    await step()
    const before = (await active()).map((r) => `${r.id}|${r.sync_version}`).sort()
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(h(DemoBanner, { paused: false, onTogglePause: () => {} }))
    fireEvent.click(screen.getByRole('button', { name: 'Reset demo' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/reset the demo clinic/i)
    expect((await active()).map((r) => `${r.id}|${r.sync_version}`).sort()).toEqual(before)
    expect(await activityCursor()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// The simulated gate and the role switch, through the REAL shell
// ---------------------------------------------------------------------------

describe('the role switch lands on the right workspace', () => {
  let startAuto: ReturnType<typeof vi.spyOn>
  let startRt: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.stubGlobal('__DH_DEMO__', true)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startAuto = vi.spyOn(syncEngine, 'startAutoSync')
    startRt = vi.spyOn(realtimeTrigger, 'start')
    installDemoCloudGuard()
    await seed()
    await loadDemoRole()
  })

  function renderShell() {
    return render(h(App, { demo: createDemoAppHooks() }))
  }

  async function homeColumn(): Promise<string> {
    const tag = await screen.findByText('your station')
    return tag.parentElement?.textContent ?? ''
  }

  async function pick(role: Parameters<typeof setDemoRole>[0]): Promise<void> {
    await act(async () => {
      await setDemoRole(role)
    })
  }

  it('reception lands on the Board with Check-in as home, and no engine, trigger, auto-sync or fetch', async () => {
    const { container } = renderShell()
    await screen.findByRole('heading', { name: 'Patient flow' })
    expect(await homeColumn()).toContain('Check-in')
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBe('page')
    // 15 on the board, none off it.
    expect(screen.getByText(/15 on the board/)).toBeTruthy()
    // The six shipped columns in order, with the two lab-waiting visits in Lab.
    const columns = [...container.querySelectorAll('.board-col')]
    expect(columns.map((c) => c.querySelector('.board-col-name')?.firstChild?.textContent)).toEqual(DEMO_STATIONS)
    const labCol = columns.find((c) => c.querySelector('.board-col-name')?.firstChild?.textContent === 'Lab')!
    expect(labCol.querySelector('.board-count')?.textContent).toBe('2')
    expect(within(labCol as HTMLElement).getByText('Amara Nakato')).toBeTruthy()
    expect(within(labCol as HTMLElement).getByText('Peter Ssemakula')).toBeTruthy()
    // No sign-in, no wizard, no cloud chip: the simulated seat IS the account.
    expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
    expect(screen.queryByText('Connect to your cloud')).toBeNull()
    expect(screen.getByText('Local demo')).toBeTruthy()
    expect(startAuto).not.toHaveBeenCalled()
    expect(startRt).not.toHaveBeenCalled()
    expect(syncEngine.autoSyncActive()).toBe(false)
    expect(realtimeTrigger.getStatus()).toBe('off')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('triage and provider land on their own column; lab and pharmacy on their pages; admin gets Staff', async () => {
    renderShell()
    await screen.findByRole('heading', { name: 'Patient flow' })

    await pick('triage')
    // Triage lands on its own queue (the visits at the Triage station), Board one tap away.
    await screen.findByRole('heading', { name: 'Triage' })
    expect(screen.getByRole('button', { name: 'Board' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'New visit' })).toBeNull()

    await pick('provider')
    await screen.findByRole('heading', { name: 'Provider' })
    // Grace Auma is seeded at the Provider station: she is the provider's queue.
    expect(await screen.findByRole('button', { name: 'Open the visit for Grace Auma' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Staff' })).toBeNull()

    await pick('lab')
    await screen.findByRole('heading', { name: 'Lab' })
    expect(screen.getByRole('button', { name: 'Lab' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
    // The heading paints before the waiting list loads from storage: await it.
    expect(await screen.findByText(/2 waiting on results/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Enter results for/ })).toHaveLength(2)

    await pick('pharmacy')
    await screen.findByRole('heading', { name: 'Pharmacy' })
    expect(screen.getByRole('button', { name: 'Pharmacy' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
    expect(await screen.findByText(/3 waiting/)).toBeTruthy()
    expect(screen.getByText(/Allergies: Penicillin \(rash\)/)).toBeTruthy()

    await pick('admin')
    await screen.findByRole('heading', { name: 'Patient flow' })
    expect(screen.getByRole('button', { name: 'Staff' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy()
    expect(await homeColumn()).toContain('Provider')

    expect(currentDemoRole()).toBe('admin')
    expect(await settings.get(DEMO_ROLE_KEY)).toBe('admin')
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(startAuto).not.toHaveBeenCalled()
    expect(startRt).not.toHaveBeenCalled()
  })

  it('a switch lands on the new workspace even from another tab, and never resets data', async () => {
    renderShell()
    await screen.findByRole('heading', { name: 'Patient flow' })
    // The visitor adds a visit and wanders off to the Visits tab...
    const template = (await active())[0] as PatientRecord
    await records.save({ ...template, id: 'visitor-added-1', mrn: 'VIAD01011990' })
    fireEvent.click(screen.getByRole('button', { name: 'Visits' }))
    await screen.findByText('RECORDS STUB')
    // ...and a switch lands on the new role's workspace with the data intact.
    await pick('lab')
    await screen.findByRole('heading', { name: 'Lab' })
    expect(screen.queryByText('RECORDS STUB')).toBeNull()
    expect((await active()).some((r) => r.id === 'visitor-added-1')).toBe(true)
    // The copied visit sits at Check-in like its template; nothing else moved.
    expect(await stationCounts()).toEqual({
      'Check-in': 4,
      Triage: 2,
      Provider: 1,
      Lab: 2,
      Pharmacy: 3,
      Done: 4,
      offBoard: 0,
    })
  })

  it('new records are attributed to the simulated seat', async () => {
    renderShell()
    await screen.findByRole('heading', { name: 'Patient flow' })
    await pick('triage')
    await screen.findByRole('heading', { name: 'Triage' })
    const template = (await active())[0] as PatientRecord
    const { user_id: _author, ...rest } = template
    await records.save({ ...rest, id: 'visitor-added-2', mrn: 'VIAD02021990' })
    const saved = (await active()).find((r) => r.id === 'visitor-added-2')
    expect(saved?.user_id).toBe('demo-user-triage')
  })

  it('the join-link boot path is bypassed: nothing joins, nothing is asked, the link is ignored', async () => {
    const link = encodeJoinLink(
      { url: 'https://evil.supabase.co', key: 'sb_publishable_evil_0123456789', orgName: 'Not Ours' },
      { appUrl: 'http://localhost/' },
    )
    const hash = link.slice(link.indexOf('#'))
    window.history.replaceState(null, '', `/${hash}`)
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    try {
      renderShell()
      await screen.findByRole('heading', { name: 'Patient flow' })
      expect(confirmSpy).not.toHaveBeenCalled()
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(await settings.get('supabaseUrl')).toBeNull()
      expect(syncEngine.hasCloud()).toBe(false)
      expect(screen.queryByText(/join link could not be used/i)).toBeNull()
    } finally {
      window.history.replaceState(null, '', '/')
    }
  })

  it('Settings carries the not-available note and Sign out refuses with it', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    renderShell()
    await screen.findByRole('heading', { name: 'Patient flow' })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByText('SETTINGS STUB')
    expect(screen.getByText(/Cloud sync and accounts are not available in the demo/)).toBeTruthy()
    expect(screen.getByText(new RegExp(DEMO_CLOUD_MESSAGE.slice(0, 40)))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(alertSpy.mock.calls[0]?.[0]).toMatch(/not available in the demo/i)
    // Still signed in as the simulated seat: nothing was torn down.
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
  })

  it('Staff (admin) lists the simulated roster with the invite note; approvals act on the local roster only', async () => {
    await pick('admin')
    renderShell()
    await screen.findByRole('heading', { name: 'Patient flow' })
    fireEvent.click(screen.getByRole('button', { name: 'Staff' }))
    await screen.findByRole('heading', { name: 'Staff accounts' })
    expect(screen.getByText(DEMO_INVITE_MESSAGE)).toBeTruthy()
    expect(screen.queryByText(/Copy link/)).toBeNull()
    expect(screen.getByText('1 account is waiting for your approval.')).toBeTruthy()
    for (const m of DEMO_ROSTER) expect(screen.getByText(m.profile.displayName)).toBeTruthy()
    expect(screen.getByText('Dr. Lydia Okot').textContent).toContain('(you)')

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await screen.findByText('Moses Tumwine is approved and can sign in now.')
    const rows = (await settings.get<StaffRow[]>(DEMO_STAFF_KEY)) ?? []
    expect(rows.find((r) => r.id === DEMO_PENDING_STAFF_ID)?.activated_at).toBeTruthy()
    expect(screen.queryByText('1 account is waiting for your approval.')).toBeNull()

    // Revoke, after the confirm, local only.
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const graceRow = screen.getByText('Grace Namara').closest('li') as HTMLElement
    fireEvent.click(within(graceRow).getByRole('button', { name: 'Revoke' }))
    await screen.findByText(/Grace Namara is revoked/)
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    const after = (await settings.get<StaffRow[]>(DEMO_STAFF_KEY)) ?? []
    expect(after.find((r) => r.display_name === 'Grace Namara')?.revoked_at).toBeTruthy()
    // The only admin cannot revoke or demote themselves (the real guard).
    const selfRow = screen.getByText('Dr. Lydia Okot').closest('li') as HTMLElement
    expect((within(selfRow).getByRole('button', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Simulated colleagues
// ---------------------------------------------------------------------------

describe('simulated activity', () => {
  beforeEach(async () => {
    await seed()
  })

  /** ids with their sync_version, to count exactly which rows a step touched. */
  async function versions(): Promise<Map<string, number>> {
    return new Map((await records.getAll()).map((r) => [r.id, r.sync_version ?? 0]))
  }

  it('one step performs exactly one plausible action through the kernel, with a toast sentence', async () => {
    const before = await versions()
    const a = await step()
    expect(a?.kind).toBe('vitals')
    expect(a?.actor).toBe('triage')
    expect(a?.actorName).toBe('Grace N.')
    expect(a?.text).toBe('Grace N. entered vitals for Daniel K.')
    const after = await versions()
    const touched = [...after].filter(([id, v]) => before.get(id) !== v)
    expect(touched).toHaveLength(1)
    const daniel = (await active()).find((r) => r.id === touched[0]![0])!
    expect(daniel.givenName).toBe('Daniel')
    expect(daniel.bp).toBe('142/88')
    expect(daniel.weight).toBe('74')
    expect(daniel.temp).toBe('36.5') // what triage had already entered stays
    expect(daniel.sync_version).toBe(2)
    expect(await activityCursor()).toBe(1)

    const b = await step()
    expect(b?.text).toBe('Esther N. moved Joseph O. to Triage')
    expect(await stationCounts()).toMatchObject({ 'Check-in': 2, Triage: 3 })
    expect(await activityCursor()).toBe(2)
  })

  it('a lab result, a dispense, a conclusion and an arrival all land where the real screens read them', async () => {
    const texts: string[] = []
    for (let i = 0; i < 8; i++) texts.push((await step())?.text ?? '')
    expect(texts).toEqual([
      'Grace N. entered vitals for Daniel K.',
      'Esther N. moved Joseph O. to Triage',
      'Peter B. entered lab results for Peter S. and sent them to Pharmacy',
      'Ruth A. dispensed 1 prescription for Samuel O.',
      'Grace N. moved Daniel K. to Provider',
      'Esther N. checked in Rose A.',
      'Dr. A. Mensah finished the visit for Grace A. and sent them to Pharmacy',
      'Ruth A. moved Samuel O. to Done',
    ])
    const rows = await active()
    const peter = rows.find((r) => r.givenName === 'Peter')!
    expect(peter.labs['Malaria RDT']?.result).toBe('POS')
    expect(pendingLabs(peter)).toEqual([])
    // The last result in: the lab sends the visit from Lab on to Pharmacy.
    expect(peter.flow_station).toBe('Pharmacy')
    expect(visitsWaitingOnLabs(rows, TODAY)).toHaveLength(1)
    expect(await stationCounts()).toMatchObject({ Lab: 1 })
    const samuel = rows.find((r) => r.givenName === 'Samuel')!
    expect(samuel.medications[0]?.dispensed).toMatchObject({ qty: 12, by: 'Ruth Atim' })
    expect(samuel.flow_station).toBe('Done')
    const grace = rows.find((r) => r.givenName === 'Grace' && r.familyName === 'Auma')!
    expect(grace.diagnosis).toBe('Normal antenatal visit')
    expect(grace.medications.map((m) => m.medId)).toEqual(['vit-prenatal'])
    expect(grace.treatment).toContain('Prenatal Vitamins')
    expect(grace.flow_station).toBe('Pharmacy')
    const rose = rows.find((r) => r.givenName === 'Rose')!
    expect(rose.id).toBe(demoVisitId('Rose', 'Atuhaire', TODAY))
    expect(rose.flow_station).toBe('Check-in')
    expect(rose.user_id).toBe('demo-user-reception')
    expect(rose.mrn).toBe(generateBaseMRN('Rose', 'Atuhaire', '1999-03-03'))
    expect(rose.deviceId).toBe(DEMO_DEVICE_ID)
  })

  it('the sequence is deterministic across fresh seeds', async () => {
    const run = async (): Promise<string[]> => {
      const out: string[] = []
      for (let i = 0; i < 10; i++) out.push((await step())?.text ?? '')
      return out
    }
    const first = await run()
    await resetDemo({ demoBuild: true, today: TODAY, now: NOW })
    const second = await run()
    expect(second).toEqual(first)
    expect(new Set(first).size).toBe(10)
  })

  it('never undoes the visitor: a step that no longer applies is skipped, not forced', async () => {
    await step() // Daniel's vitals
    // The visitor (as reception) sends Joseph straight to Provider.
    const joseph = demoVisitId('Joseph', 'Okello', TODAY)
    await records.update(joseph, (r) => ({ ...r, flow_station: 'Provider', flow_updated_at: NOW.toISOString() }))
    const a = await step()
    // Step 2 (Joseph to Triage) is skipped; the lab result is next.
    expect(a?.text).toBe('Peter B. entered lab results for Peter S. and sent them to Pharmacy')
    expect((await active()).find((r) => r.id === joseph)?.flow_station).toBe('Provider')
    expect(await activityCursor()).toBe(3)
  })

  it('a result entered while the visit is not at Lab lands the result and leaves the column alone', async () => {
    await step() // Daniel's vitals
    await step() // Joseph to Triage
    // The visitor (through the card's station picker) pulled Peter back to
    // the provider before the lab finished; the lab's results still land,
    // but the lab never moves a visit it is not holding.
    const peter = demoVisitId('Peter', 'Ssemakula', TODAY)
    await records.update(peter, (r) => ({ ...r, flow_station: 'Provider', flow_updated_at: NOW.toISOString() }))
    const a = await step()
    expect(a?.text).toBe('Peter B. entered lab results for Peter S.')
    const after = (await active()).find((r) => r.id === peter)!
    expect(after.flow_station).toBe('Provider')
    expect(pendingLabs(after)).toEqual([])
    expect(after.labs['Typhoid (Widal/RDT)']?.result).toBe('NEG')
  })

  it('a concluded visit goes to Lab when tests are waiting and to Pharmacy otherwise; the lab sends it on', async () => {
    const texts: string[] = []
    for (let i = 0; i < SCRIPT.length; i++) {
      texts.push((await step())?.text ?? '')
      if (texts[texts.length - 1] === 'Dr. A. Mensah finished the visit for Daniel K. and sent them to Lab') break
    }
    // Grace (no tests ordered) went straight to Pharmacy; Daniel, with a
    // glucose ordered at the end of the review, waits at Lab for it.
    expect(texts).toContain('Dr. A. Mensah finished the visit for Grace A. and sent them to Pharmacy')
    expect(texts[texts.length - 1]).toBe('Dr. A. Mensah finished the visit for Daniel K. and sent them to Lab')
    const danielId = demoVisitId('Daniel', 'Kirya', TODAY)
    let daniel = (await active()).find((r) => r.id === danielId)!
    expect(daniel.flow_station).toBe('Lab')
    expect(daniel.diagnosis).toBe('Diabetes')
    expect(pendingLabs(daniel)).toEqual(['Blood Glucose'])
    expect(daniel.medications[0]?.dispensed).toBeUndefined()
    expect(visitsWaitingOnLabs(await active(), TODAY).map((r) => r.givenName)).toEqual(['Daniel'])

    // The lab enters the glucose: result snapshotted, legacy mirror written,
    // and the visit moves on from Lab to Pharmacy, where it is dispensed.
    let labText = ''
    while (!labText.includes('Daniel K.')) {
      const a = await step()
      if (!a) throw new Error('script ended before the lab resulted Daniel')
      labText = a.kind === 'labs' ? a.text : ''
    }
    expect(labText).toBe('Peter B. entered lab results for Daniel K. and sent them to Pharmacy')
    daniel = (await active()).find((r) => r.id === danielId)!
    expect(daniel.flow_station).toBe('Pharmacy')
    expect(daniel.labs['Blood Glucose']).toMatchObject({ ordered: true, type: 'numeric', value: '168', unit: 'mg/dL', interpretation: 'Elevated' })
    expect(daniel.bloodGlucose).toBe('168')
    expect(pendingLabs(daniel)).toEqual([])
    expect(visitsWaitingOnLabs(await active(), TODAY)).toHaveLength(0)
  })

  it('a concluded visit with tests waiting goes to Pharmacy when the org has no Lab column', async () => {
    // An admin removed the Lab column: results are handled off the board,
    // so the provider sends the patient straight on rather than nowhere.
    await config.set('flowStations', ['Check-in', 'Triage', 'Provider', 'Pharmacy', 'Done'])
    const danielId = demoVisitId('Daniel', 'Kirya', TODAY)
    let a: Awaited<ReturnType<typeof step>> = null
    for (let i = 0; i < SCRIPT.length; i++) {
      a = await step()
      if (a?.kind === 'conclude' && a.text.includes('Daniel K.')) break
    }
    expect(a?.text).toBe('Dr. A. Mensah finished the visit for Daniel K. and sent them to Pharmacy')
    const daniel = (await active()).find((r) => r.id === danielId)!
    expect(daniel.flow_station).toBe('Pharmacy')
    expect(pendingLabs(daniel)).toEqual(['Blood Glucose'])
  })

  it('the Lab queue is the ordered-unresulted tests, whatever column the visit is in', async () => {
    // The visitor sends Amara back to the provider's room: still waiting on
    // results, still on the Lab page; Peter stays in the Lab column.
    const amara = demoVisitId('Amara', 'Nakato', TODAY)
    await records.update(amara, (r) => ({ ...r, flow_station: 'Provider', flow_updated_at: NOW.toISOString() }))
    const rows = await active()
    expect(visitsWaitingOnLabs(rows, TODAY).map((r) => r.givenName).sort()).toEqual(['Amara', 'Peter'])
    expect(await stationCounts()).toMatchObject({ Provider: 2, Lab: 1 })
  })

  it('is idempotent per SEED_VERSION: a boot-time seed keeps the cursor; Reset puts it back', async () => {
    await step()
    await step()
    expect(await activityCursor()).toBe(2)
    expect((await seed()).seeded).toBe(false)
    expect(await activityCursor()).toBe(2)
    expect((await step())?.text).toBe('Peter B. entered lab results for Peter S. and sent them to Pharmacy')
    await resetDemo({ demoBuild: true, today: TODAY, now: NOW })
    expect(await activityCursor()).toBe(0)
    expect((await step())?.text).toBe('Grace N. entered vitals for Daniel K.')
  })

  it('walks the whole script to its end and then rests', async () => {
    const seen: string[] = []
    for (let i = 0; i < SCRIPT.length; i++) {
      const a = await step()
      if (a) seen.push(a.text)
    }
    expect(seen.length).toBe(SCRIPT.length)
    expect(await activityFinished()).toBe(true)
    expect(await step()).toBeNull()
    expect(await activityCursor()).toBe(SCRIPT.length)
    // The day ends with everyone seen: nobody left waiting on labs or drugs.
    const rows = await active()
    expect(visitsWaitingOnLabs(rows, TODAY)).toHaveLength(0)
    expect(visitsAwaitingDispense(rows, TODAY).map((r) => r.givenName).sort()).toEqual([
      'Amara',
      'Esther',
      'Joseph',
    ])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('paces itself every 25 to 40 seconds, deterministically per step', () => {
    for (let c = 0; c <= SCRIPT.length; c++) {
      const d = stepDelayMs(c)
      expect(d).toBeGreaterThanOrEqual(25_000)
      expect(d).toBeLessThanOrEqual(40_000)
      expect(stepDelayMs(c)).toBe(d)
    }
  })

  it('Reset demo restores the day: records, roster, cursor', async () => {
    for (let i = 0; i < 5; i++) await step()
    await records.save({ ...(await active())[0]!, id: 'visitor-added-3', mrn: 'ZZQQ01011990' })
    const rows = (await settings.get<StaffRow[]>(DEMO_STAFF_KEY)) ?? []
    await settings.set(
      DEMO_STAFF_KEY,
      rows.map((r) => (r.id === 'demo-user-triage' ? { ...r, revoked_at: NOW.toISOString() } : r)),
    )
    await setActivityPaused(true)

    const r = await resetDemo({ demoBuild: true, today: TODAY, now: NOW })
    expect(r.seeded).toBe(true)
    expect(await stationCounts()).toEqual({
      'Check-in': 3,
      Triage: 2,
      Provider: 1,
      Lab: 2,
      Pharmacy: 3,
      Done: 4,
      offBoard: 0,
    })
    expect((await active()).some((x) => x.id === 'visitor-added-3')).toBe(false)
    const roster = (await settings.get<StaffRow[]>(DEMO_STAFF_KEY)) ?? []
    expect(roster.find((x) => x.id === 'demo-user-triage')?.revoked_at).toBeNull()
    expect(roster.filter((x) => !x.activated_at)).toHaveLength(1)
    expect(await activityCursor()).toBe(0)
    expect(await settings.get(DEMO_ACTIVITY_PAUSED_KEY)).toBe(false)
    expect(await settings.get(SEED_FLAG)).toBe(SEED_VERSION)
  })
})

// ---------------------------------------------------------------------------
// The panel and the shell chrome
// ---------------------------------------------------------------------------

describe('the "You are simulating" panel', () => {
  beforeEach(async () => {
    vi.stubGlobal('__DH_DEMO__', true)
    installDemoCloudGuard()
    await seed()
    await loadDemoRole()
  })

  it('lists the six seats, marks the current one, and switches the simulated profile', async () => {
    render(h(DemoShell, null, h('div', null, 'APP STUB')))
    expect(screen.getByRole('heading', { name: 'You are simulating' })).toBeTruthy()
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.textContent)).toEqual(
      DEMO_ROSTER.map((m) => `${m.label}${m.profile.displayName}${m.does}. Lands on: ${m.landsOn}.`),
    )
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'true',
      'false',
      'false',
      'false',
      'false',
      'false',
    ])
    fireEvent.click(screen.getByRole('radio', { name: /^Lab/ }))
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /^Lab/ }).getAttribute('aria-checked')).toBe('true'),
    )
    expect(currentDemoRole()).toBe('lab')
    await waitFor(async () => expect(await settings.get(DEMO_ROLE_KEY)).toBe('lab'))
  })

  it('Act now performs one colleague action and shows it as a toast; Pause is shared with the banner', async () => {
    render(h(DemoShell, null, h('div', null, 'APP STUB')))
    expect(screen.getByText(/Colleagues are working/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Act now' }))
    await screen.findByText('Last: Grace N. entered vitals for Daniel K.')
    expect(screen.getByText('Grace N. entered vitals for Daniel K.')).toBeTruthy()
    expect(await activityCursor()).toBe(1)

    // Two Pause controls (banner + panel), one state.
    const buttons = screen.getAllByRole('button', { name: 'Pause activity' })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[0]!)
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Resume activity' })).toHaveLength(2))
    expect(screen.getByText(/Paused\./)).toBeTruthy()
    expect(await settings.get(DEMO_ACTIVITY_PAUSED_KEY)).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('collapses and expands', () => {
    render(h(DemoShell, null, h('div', null, 'APP STUB')))
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.queryAllByRole('radio')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: 'You are simulating' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show' }))
    expect(screen.getAllByRole('radio')).toHaveLength(6)
  })
})
