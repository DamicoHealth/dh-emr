/**
 * Demo mode: the public try-it build, seeded as a fictional clinic.
 *
 * The five safety laws under test are law because the old demo seeder wiped
 * a real deployment by enumerating and deleting dhemr_ keys on load
 * (REBUILD-HANDOFF.md section 7):
 *
 *   1. The seeder refuses to run unless the build set DH_DEMO.
 *   2. Storage is namespaced by the BUILD (asserted against build:demo).
 *   3. It never enumerates-and-deletes storage keys (source scan AND
 *      behavioral: foreign keys survive a reset).
 *   4. Standalone forced, credentials null, cloud paths refused.
 *   5. Fictional patients only, and the banner says so.
 *
 * Plus: idempotence per SEED_VERSION, deterministic ids, and the seed
 * inventory (returning patient with a vitals trend, malaria POS with a
 * snapshotted interpretation, antenatal, paediatric, completed referral,
 * penicillin allergy respected, an Amharic name, two-template library).
 */
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, records, settings } from '../src/kernel'
import { CONFIG_PUSH_KEYS, getConfig, loadLibraryDetailed } from '../src/config/keys'
import { DEFAULT_REFERRAL_TYPES } from '../src/config/defaults'
import { generateBaseMRN } from '../src/domain/mrn'
import { LEGACY_SHARED_DEVICE_IDS, getDeviceId, syncEngine } from '../src/sync'
import type { PatientRecord } from '../src/types/record'
// Raw sources for the enumerate-and-delete scan (vite ?raw imports).
import bannerSrc from '../src/demo/DemoBanner.tsx?raw'
import guardSrc from '../src/demo/cloudGuard.ts?raw'
import indexSrc from '../src/demo/index.ts?raw'
import seedSrc from '../src/demo/seed.ts?raw'
import pkg from '../package.json'
import {
  DEMO_CLOUD_MESSAGE,
  DEMO_DEVICE_ID,
  DEMO_PROVIDERS,
  DEMO_SITES,
  DemoBanner,
  SEED_FLAG,
  SEED_VERSION,
  buildDemoLibrary,
  demoDaysAgo,
  installDemoCloudGuard,
  resetDemo,
  seedDemo,
} from '../src/demo'

/** Fixed seed day so every relative date in the inventory is assertable. */
const TODAY = '2025-06-15'

const SETTINGS_KEYS = [
  SEED_FLAG,
  'setupComplete',
  'standaloneMode',
  'deviceId',
  'deviceName',
  'deviceRole',
  'supabaseUrl',
  'supabaseKey',
]

async function clearDemoState(): Promise<void> {
  await resetStorage()
  for (const k of SETTINGS_KEYS) await settings.remove(k)
  for (const k of CONFIG_PUSH_KEYS) await config.remove(k)
  records.invalidate()
}

/** Seed with the TEST-ONLY build override (vitest builds with DH_DEMO unset). */
function seed(opts: { force?: boolean } = {}) {
  return seedDemo({ demoBuild: true, today: TODAY, ...opts })
}

async function active(): Promise<PatientRecord[]> {
  return records.getActive()
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await clearDemoState()
})

afterEach(() => {
  cleanup()
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

  it('resetDemo() refuses the same way', async () => {
    await expect(resetDemo()).rejects.toThrow(/DH_DEMO/)
  })

  it('a refused run writes NOTHING', async () => {
    await expect(seedDemo({ today: TODAY })).rejects.toThrow()
    expect(await settings.get(SEED_FLAG)).toBeNull()
    expect(await settings.get('setupComplete')).toBeNull()
    expect(await settings.get('standaloneMode')).toBeNull()
    expect(await getConfig(config, 'sites')).toBeNull()
    expect(await active()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Safety law 2: namespaced storage comes from the BUILD
// ---------------------------------------------------------------------------

describe('safety law 2: the demo build is namespaced', () => {
  it('build:demo sets DH_DEMO and the -demo storage suffix', () => {
    // The kernel namespaces everything from __DH_STORAGE_SUFFIX__ (its own
    // tests prove that); what the demo owns is the build script that MUST
    // set both env vars, or the demo shares a database with production.
    const script = (pkg.scripts as Record<string, string>)['build:demo']
    expect(script).toBeTruthy()
    expect(script).toContain('DH_DEMO=1')
    expect(script).toContain('DH_STORAGE_SUFFIX=-demo')
    expect(script).toContain('--base=/demo/')
  })
})

// ---------------------------------------------------------------------------
// Safety law 3: never enumerate-and-delete
// ---------------------------------------------------------------------------

describe('safety law 3: no enumerate-and-delete, ever', () => {
  it('the demo source contains no storage-enumeration or bulk-delete pattern', () => {
    const sources: Record<string, string> = {
      'seed.ts': seedSrc,
      'cloudGuard.ts': guardSrc,
      'DemoBanner.tsx': bannerSrc,
      'index.ts': indexSrc,
    }
    const forbidden = [
      /deleteDatabase/,
      /localStorage\s*\.\s*clear\b/,
      /localStorage\s*\.\s*removeItem\b/,
      /localStorage\s*\.\s*key\b/,
      /Object\.keys\(\s*localStorage/,
      /indexedDB\s*\.\s*databases/,
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
    await seed()
    await seed({ force: true })
    expect(localStorage.getItem('some-other-app')).toBe('untouched')
    expect(localStorage.getItem('dhemr_foreign_note')).toBe('"keep me"')
  })
})

// ---------------------------------------------------------------------------
// Safety law 4: standalone, null credentials, cloud paths refused
// ---------------------------------------------------------------------------

describe('safety law 4: the demo can never sync', () => {
  it('forces standalone mode with null credentials and completed setup', async () => {
    await seed()
    expect(await settings.get('standaloneMode')).toBe('true')
    expect(await settings.get('supabaseUrl')).toBeNull()
    expect(await settings.get('supabaseKey')).toBeNull()
    expect(await settings.get('setupComplete')).toBe('true')
    expect(await settings.get('deviceRole')).toBe('admin')
  })

  it('uses a stable device id that is NOT a legacy shared id', async () => {
    await seed()
    expect(LEGACY_SHARED_DEVICE_IDS).not.toContain(DEMO_DEVICE_ID)
    expect(await getDeviceId()).toBe(DEMO_DEVICE_ID)
  })

  it('the cloud guard refuses connect and verify with the demo note', async () => {
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
  })

  it('the cloud guard makes credential writes a no-op', async () => {
    await seed()
    installDemoCloudGuard()
    syncEngine.updateCredentials('https://example.supabase.co', 'sb_publishable_x')
    expect(syncEngine.hasCloud()).toBe(false)
    expect(await settings.get('supabaseUrl')).toBeNull()
    expect(await settings.get('supabaseKey')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Idempotence per SEED_VERSION
// ---------------------------------------------------------------------------

describe('idempotence per SEED_VERSION', () => {
  it('seeds once, then leaves a returning visitor alone', async () => {
    const first = await seed()
    expect(first.seeded).toBe(true)
    expect(first.records).toBeGreaterThanOrEqual(10)
    expect(await settings.get(SEED_FLAG)).toBe(SEED_VERSION)

    // The visitor adds a record and edits config...
    const rows = await active()
    const template = rows[0] as PatientRecord
    await records.save({
      ...template,
      id: 'user-added-1',
      givenName: 'Visitor',
      familyName: 'Added',
      name: 'Visitor Added',
      mrn: 'VIAD01011990',
    })
    await config.set('providers', ['Changed Provider'])

    // ...and a second boot-time seed changes NOTHING.
    const second = await seed()
    expect(second.seeded).toBe(false)
    const after = await active()
    expect(after.some((r) => r.id === 'user-added-1')).toBe(true)
    expect(await getConfig(config, 'providers')).toEqual(['Changed Provider'])
  })

  it('a bumped SEED_VERSION re-seeds on the next load', async () => {
    await seed()
    await records.save({ ...(await active())[0]!, id: 'user-added-2', mrn: 'XXYY01011990' })
    // Simulate an older visitor: their stored flag predates SEED_VERSION.
    await settings.set(SEED_FLAG, '0')
    const r = await seed()
    expect(r.seeded).toBe(true)
    const rows = await active()
    expect(rows.some((x) => x.id === 'user-added-2')).toBe(false)
  })

  it('Reset Demo restores the original clinic through the kernel', async () => {
    const first = await seed()
    await records.save({ ...(await active())[0]!, id: 'user-added-3', mrn: 'ZZQQ01011990' })
    await config.set('providers', ['Changed Provider'])
    const r = await resetDemo({ demoBuild: true, today: TODAY })
    expect(r.seeded).toBe(true)
    const rows = await active()
    expect(rows).toHaveLength(first.records)
    expect(rows.some((x) => x.id === 'user-added-3')).toBe(false)
    expect(await getConfig(config, 'providers')).toEqual(DEMO_PROVIDERS)
  })

  it('re-seeding is deterministic: identical ids, MRNs and savedAt stamps', async () => {
    await seed()
    const before = (await active())
      .map((r) => `${r.id}|${r.mrn}|${r.savedAt}`)
      .sort()
    await resetDemo({ demoBuild: true, today: TODAY })
    const after = (await active())
      .map((r) => `${r.id}|${r.mrn}|${r.savedAt}`)
      .sort()
    expect(after).toEqual(before)
    for (const stamp of after) expect(stamp.startsWith('demo-')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Seed inventory
// ---------------------------------------------------------------------------

describe('seed inventory', () => {
  beforeEach(async () => {
    await seed()
  })

  it('every record is stamped with the demo device and looks synced', async () => {
    const rows = await active()
    expect(rows.length).toBeGreaterThanOrEqual(10)
    for (const r of rows) {
      expect(r.deviceId).toBe(DEMO_DEVICE_ID)
      expect(r.sync_version).toBe(r.synced_version)
      expect(r.mrn).toBeTruthy()
      expect(DEMO_SITES).toContain(r.site)
      expect(DEMO_PROVIDERS).toContain(r.provider)
    }
  })

  it('every MRN comes from the real generator for that patient', async () => {
    for (const r of await active()) {
      expect(r.mrn).toBe(generateBaseMRN(r.givenName, r.familyName, r.dob))
    }
  })

  it('has the returning patient: 3 visits, one patient number, a vitals trend', async () => {
    const mrn = generateBaseMRN('Amara', 'Nakato', '1991-04-12')
    const visits = (await active())
      .filter((r) => r.mrn === mrn)
      .sort((a, b) => (a.date < b.date ? -1 : 1))
    expect(visits).toHaveLength(3)
    expect(visits.map((v) => v.temp)).toEqual(['39.2', '37.1', '36.9'])
    expect(visits.map((v) => v.weight)).toEqual(['58', '59', '60'])
    expect(visits.map((v) => v.date)).toEqual([
      demoDaysAgo(96, TODAY),
      demoDaysAgo(38, TODAY),
      demoDaysAgo(4, TODAY),
    ])
  })

  it('has a malaria-positive visit with a SNAPSHOTTED numeric interpretation', async () => {
    const rows = await active()
    const malaria = rows.filter((r) => r.labs['Malaria RDT']?.result === 'POS')
    expect(malaria.length).toBeGreaterThanOrEqual(1)
    const withHgb = malaria.find((r) => r.labs['Hemoglobin'])
    expect(withHgb).toBeTruthy()
    const hgb = withHgb!.labs['Hemoglobin']!
    expect(hgb.type).toBe('numeric')
    expect(hgb.value).toBe('9.6')
    expect(hgb.unit).toBe('g/dL')
    // Snapshotted at seed time from the default reference ranges.
    expect(hgb.interpretation).toBe('Moderate Anemia')
    // And the diabetic review carries the glucose snapshot + legacy mirror.
    const glucose = rows.find((r) => r.labs['Blood Glucose'])
    expect(glucose?.labs['Blood Glucose']?.interpretation).toBe('Elevated')
    expect(glucose?.bloodGlucose).toBe('182')
  })

  it('has an antenatal visit', async () => {
    const r = (await active()).find((x) => x.pregnant === 'Yes')
    expect(r).toBeTruthy()
    expect(r!.labs['HCG/Pregnancy']?.result).toBe('POS')
    expect(r!.imaging?.modality).toBe('Ultrasound')
  })

  it('has a paediatric visit whose patient stays a child (DOB relative to seed day)', async () => {
    const r = (await active()).find((x) => x.givenName === 'Samuel')
    expect(r).toBeTruthy()
    expect(r!.dob).toBe(demoDaysAgo(2300, TODAY))
    const ageYears = (Date.parse(TODAY) - Date.parse(r!.dob)) / (365.25 * 24 * 3600 * 1000)
    expect(ageYears).toBeLessThan(18)
    expect(r!.weight).toBe('17')
  })

  it('has a completed referral', async () => {
    const r = (await active()).find((x) => x.referralStatus === 'Completed')
    expect(r).toBeTruthy()
    expect(r!.referralType).toBe('Hospital')
    expect(DEFAULT_REFERRAL_TYPES).toContain(r!.referralType)
    expect(r!.referralDate).toBeTruthy()
  })

  it('has a penicillin-allergic patient whose visit respects the allergy', async () => {
    const r = (await active()).find((x) => /penicillin/i.test(x.allergies))
    expect(r).toBeTruthy()
    const penicillins = ['abx-amox500', 'abx-amox250', 'abx-benza']
    for (const m of r!.medications) expect(penicillins).not.toContain(m.medId)
    expect(r!.medications.map((m) => m.medId)).toContain('abx-cipro')
    expect(r!.notes).toMatch(/allergy/i)
  })

  it('has the Amharic-name patient, filed by the real MRN generator', async () => {
    const r = (await active()).find((x) => x.givenName === 'አማራ')
    expect(r).toBeTruthy()
    expect(r!.mrn).toBe(generateBaseMRN('አማራ', 'ንጉሤ', '1988-06-15'))
    expect(r!.mrn.startsWith('አማ')).toBe(true)
  })

  it('computes dispensing quantities with the real calcMedQty', async () => {
    const rows = await active()
    const artefan = rows
      .flatMap((r) => r.medications)
      .find((m) => m.medId === 'am-artefan' && m.dose === '4 tabs')
    // 4 tabs x twice daily x 3 days
    expect(artefan?.qty).toBe(24)
    expect(artefan?.qtyUnit).toBe('tabs')
    const cipro = rows.flatMap((r) => r.medications).find((m) => m.medId === 'abx-cipro')
    // 1 tab x twice daily x 5 days
    expect(cipro?.qty).toBe(10)
  })

  it('populates every interactive config key', async () => {
    expect(await getConfig(config, 'sites')).toEqual(DEMO_SITES)
    const providers = await getConfig(config, 'providers')
    expect(providers).toEqual(DEMO_PROVIDERS)
    // Commas stay INSIDE a provider entry.
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

  it('seeds a REAL two-template library (never synthesized), with custom fields of several types', async () => {
    const { lib, synthesized } = await loadLibraryDetailed(config)
    // Synthesized would disable the form builder: the flagship feature dead.
    expect(synthesized).toBe(false)
    expect(lib.templates).toHaveLength(2)
    expect(lib.templates.map((t) => t.name)).toEqual(['General Clinic', 'Mobile Outreach'])
    for (const t of lib.templates) expect(t.enabled).toBe(true)

    const fieldTypes = new Set(
      lib.templates.flatMap((t) =>
        (t.schema.sections || []).flatMap((s) => (s.fields || []).map((f) => f.type)),
      ),
    )
    for (const ty of ['select', 'multiselect', 'number', 'range', 'yesno', 'textarea']) {
      expect(fieldTypes.has(ty as never), `library must include a ${ty} field`).toBe(true)
    }

    // The legacy formSchema mirror matches templates[0], so an older client
    // on the same data still renders.
    const mirror = await getConfig(config, 'formSchema')
    expect(mirror?.sections).toEqual(lib.templates[0]!.schema.sections)
  })

  it('stores custom-field answers under ids that exist in the seeded library', async () => {
    const lib = buildDemoLibrary()
    const knownIds = new Set(
      lib.templates.flatMap((t) =>
        (t.schema.sections || []).flatMap((s) => (s.fields || []).map((f) => f.id)),
      ),
    )
    const rows = await active()
    const answered = rows.filter((r) => Object.keys(r.customFields).length > 0)
    expect(answered.length).toBeGreaterThanOrEqual(2)
    for (const r of answered) {
      for (const key of Object.keys(r.customFields)) {
        expect(knownIds.has(key), `answer key ${key} must exist in the library`).toBe(true)
      }
      // The record's template must exist too, or the answers render nowhere.
      expect(lib.templates.some((t) => t.id === r.templateId)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Safety law 5: the banner says the patients are fictional
// ---------------------------------------------------------------------------

describe('DemoBanner', () => {
  it('shows the fictional-clinic notice and the compliance line', () => {
    render(createElement(DemoBanner))
    expect(screen.getByText(/fictional clinic/i)).toBeTruthy()
    expect(screen.getByText(/never syncs anywhere/i)).toBeTruthy()
    expect(
      screen.getByText(/not a certified EHR and is not HIPAA-compliant/i),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reset Demo' })).toBeTruthy()
  })

  it('Reset Demo asks for confirmation first and does nothing on cancel', async () => {
    await seed()
    const before = (await active()).length
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(createElement(DemoBanner))
    fireEvent.click(screen.getByRole('button', { name: 'Reset Demo' }))
    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy.mock.calls[0]?.[0]).toMatch(/reset the demo clinic/i)
    expect((await active()).length).toBe(before)
    expect(await settings.get(SEED_FLAG)).toBe(SEED_VERSION)
  })
})
