/**
 * DH EMR Clinic shell: boot gate, account gate, tab bar, storage health
 * banners, multi-tab warning, sync chip, and the visit panel plumbing. The
 * screens themselves belong to core (records, encounter, board, staff,
 * settings, setup, auth) and mount behind per-tab error boundaries.
 *
 * Clinic is the live product: ALWAYS cloud, ALWAYS behind the account
 * gate. There is no field mode and no mode switching anywhere in it - a
 * Clinic org IS clinic mode. The server's orgMode rules stay as defense in
 * depth, and the first active admin sign-in writes orgMode=clinic for the
 * org automatically (src/clinicOrgMode.ts), so the manual SQL step in
 * supabase/SETUP.md is unnecessary for a Clinic org.
 *
 * Boot order: join link in the URL consumed (consumeJoinLink) -> kernel/
 * settings read -> the setupComplete flag ALONE decides first-run -> the
 * account gate -> main shell. A leftover device id must NOT bypass the
 * wizard: a legacy install or a crash between device registration and the
 * final setupComplete write would otherwise boot into the app with
 * unverified credentials and placeholder clinic lists. A set-up device that
 * holds no cloud credentials is not set up for Clinic either: it lands back
 * on the wizard's cloud step.
 *
 * Join links (core/sync/joinLink.ts) are how a device gets its project
 * without anyone typing an address or key: the admin's Staff screen shows
 * a link and a QR, the device opens it, and the shell configures itself
 * BEFORE the wizard could render, landing on sign-in. A link that cannot be
 * used shows its reason on the wizard, never a silent fallback.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  detectOtherTabs,
  getSetting,
  hasCrossTabLock,
  onExternalWrite,
  readStorageHealth,
  records,
  storageEmergency,
  storageWarning,
} from '@dh/core/kernel'
import {
  CLINIC_AUTO_SYNC_INTERVAL_MS,
  ensureFleetRow,
  getDeviceId,
  joinProject,
  projectHost,
  readJoinLink,
  realtimeTrigger,
  stripJoinParam,
  syncEngine,
} from '@dh/core/sync'
import { authSession, loadCurrentProfile, type ActiveProfile } from '@dh/core/auth'
import { canRegisterVisit, canSeeAnalytics, workspaceForRole } from '@dh/core/config/roles'
import AnalyticsScreen from '@dh/core/ui/analytics/AnalyticsScreen'
import { ErrorBoundary } from '@dh/core/ui/app/ErrorBoundary'
import { SyncChip } from '@dh/core/ui/app/SyncChip'
import { UpdateBar } from '@dh/core/ui/app/UpdateBar'
import PendingScreen from '@dh/core/ui/auth/PendingScreen'
import RevokedScreen from '@dh/core/ui/auth/RevokedScreen'
import SignInScreen from '@dh/core/ui/auth/SignInScreen'
import BoardScreen from '@dh/core/ui/board/BoardScreen'
import EncounterForm from '@dh/core/ui/encounter/EncounterForm'
import LabScreen from '@dh/core/ui/lab/LabScreen'
import PharmacyScreen from '@dh/core/ui/pharmacy/PharmacyScreen'
import RecordsScreen from '@dh/core/ui/records/RecordsScreen'
import SettingsScreen from '@dh/core/ui/settings/SettingsScreen'
import SetupWizard from '@dh/core/ui/setup/SetupWizard'
import StaffScreen from '@dh/core/ui/staff/StaffScreen'
import { ensureClinicOrgMode } from './clinicOrgMode'
import type { DemoAppHooks } from './demo/gate'

// Injected by vite.config define. Literal checks so production builds
// (DH_DEMO unset) compile every demo branch below away; the hooks object
// itself only exists in a demo build (main.tsx). The import above is
// type-only, so the production bundle carries nothing of src/demo.
declare const __DH_DEMO__: boolean

// ---------------------------------------------------------------------------
// Boot state
// ---------------------------------------------------------------------------

type Boot =
  | { state: 'loading' }
  | { state: 'setup' }
  | { state: 'ready'; deviceId: string | null }
  | { state: 'error'; message: string; detail?: string }

async function loadReadyInfo(): Promise<{ deviceId: string | null }> {
  return { deviceId: await getDeviceId() }
}

// ---------------------------------------------------------------------------
// Join links at boot.
//
// Read the fragment, then strip it from the URL right away (replaceState):
// a reload must not join twice or re-ask the confirm, and the key should
// not sit in the address bar for a screenshot. Then:
//  - no join parameter: nothing to do;
//  - an unusable link: its reason is returned as copy for the wizard;
//  - a device with no project yet (or an unfinished setup): join, which
//    verifies the tables, stores the credentials and registers the device
//    (connectToProject), then marks setup complete;
//  - a set-up device already on THAT project: nothing to do;
//  - a set-up device on a DIFFERENT project: a clear confirm first. On yes,
//    sign out of the old project BEFORE the credentials change (the auth
//    client caches by project and persists its session under one key, so
//    an old session would otherwise be presented to the new project), then
//    join with connectToProject's re-register semantics.
// Returns the copy to show when the link could not be used, else null.
// ---------------------------------------------------------------------------

async function consumeJoinLink(): Promise<string | null> {
  const read = readJoinLink(window.location.hash)
  if (read.kind === 'none') return null
  const clean = `${window.location.pathname}${window.location.search}${stripJoinParam(window.location.hash)}`
  try {
    window.history.replaceState(window.history.state, '', clean)
  } catch {
    /* an exotic embedding without history is still allowed to join */
  }
  if (read.kind === 'invalid') return read.error

  const { payload } = read
  const current = syncEngine.getCredentials()
  const setupDone = (await getSetting<string>('setupComplete')) === 'true'
  if (setupDone && current.url && current.key) {
    if (current.url === payload.url) return null
    const target = payload.orgName
      ? `${payload.orgName} (${projectHost(payload.url)})`
      : projectHost(payload.url)
    let ok = false
    try {
      ok = window.confirm(
        `This device is already connected to ${projectHost(current.url)}.\n\nSwitch it to ${target}?\n\nThe device registers itself in the new project and signs in there. Visits already synced to the old project stay there; anything not yet backed up uploads to the new one.`,
      )
    } catch {
      ok = false
    }
    if (!ok) return null
    await authSession.signOut()
  }
  const r = await joinProject(payload)
  return r.ok ? null : r.error
}

// ---------------------------------------------------------------------------
// The account gate.
//
// Applies whenever this device holds cloud credentials - which in Clinic is
// always, once set up. No orgMode check: the Field product has no gate and
// the Clinic product has no field mode, so the org's mode row decides
// nothing on a device; it is the server's concern (and the admin's first
// sign-in writes it, below). hasCloud() stays as the one precondition
// because the gate cannot ask a server it cannot name; a device without
// credentials goes back to the wizard's cloud step.
//
// Boot requires an account decision: active (live or cached - offline
// never stops a clinic) opens the shell, pending/revoked get their screens,
// signed out gets sign-in. Revocation while offline is enforced server-side
// the moment the device reconnects; the cached profile is an availability
// decision, not a security hole the server does not already document.
// ---------------------------------------------------------------------------

type Gate =
  | { kind: 'checking' }
  | { kind: 'noCloud' }
  | { kind: 'signedOut' }
  | { kind: 'pending'; displayName: string; offline: boolean }
  | { kind: 'revoked'; displayName: string }
  | { kind: 'active'; profile: ActiveProfile; stale: boolean }

async function evaluateGate(demo: DemoAppHooks | null): Promise<Gate> {
  // Demo build: the seat picked on the "You are simulating" panel IS the
  // active account (src/demo/gate.ts). No server is asked, ever.
  if (__DH_DEMO__ && demo) return { kind: 'active', profile: demo.profile(), stale: false }
  if (!syncEngine.hasCloud()) return { kind: 'noCloud' }
  const p = await loadCurrentProfile()
  switch (p.state) {
    case 'signedOut':
      return { kind: 'signedOut' }
    case 'pending':
      return { kind: 'pending', displayName: p.displayName, offline: p.offline }
    case 'revoked':
      return { kind: 'revoked', displayName: p.displayName }
    case 'active':
      return { kind: 'active', profile: p.profile, stale: p.stale }
  }
}

// ---------------------------------------------------------------------------
// Tabs. Data-driven and role-aware: every account lands on its workspace
// first (core/config/roles.ts decides which). Reception, triage, provider
// and admins live on the Board, focused on their own station; lab and
// pharmacy get their own screens. Then Visits, New visit for the roles that
// register patients, Analytics for providers and admins, Staff for admins,
// Settings for everyone. tabsFor is the ONE place the list is decided, and
// its first screen tab is the landing tab.
// ---------------------------------------------------------------------------

type ScreenId = 'board' | 'lab' | 'pharmacy' | 'visits' | 'analytics' | 'staff' | 'settings'

interface ScreenTab {
  kind: 'screen'
  id: ScreenId
  label: string
}

interface ActionTab {
  kind: 'action'
  id: 'new-visit'
  label: string
}

type TabDef = ScreenTab | ActionTab

export function tabsFor(profile: ActiveProfile): TabDef[] {
  const tabs: TabDef[] = []
  const ws = workspaceForRole(profile.role)
  if (ws === 'lab') tabs.push({ kind: 'screen', id: 'lab', label: 'Lab' })
  else if (ws === 'pharmacy') tabs.push({ kind: 'screen', id: 'pharmacy', label: 'Pharmacy' })
  else tabs.push({ kind: 'screen', id: 'board', label: 'Board' })
  // An admin runs the clinic, so the Board is always theirs, after the
  // workspace their own role lands on.
  if (profile.isAdmin && ws !== 'board') tabs.push({ kind: 'screen', id: 'board', label: 'Board' })
  tabs.push({ kind: 'screen', id: 'visits', label: 'Visits' })
  // After Visits so New visit keeps its reach, for the roles that register.
  if (canRegisterVisit(profile.role, profile.isAdmin)) {
    tabs.push({ kind: 'action', id: 'new-visit', label: 'New visit' })
  }
  if (canSeeAnalytics(profile.role, profile.isAdmin)) {
    tabs.push({ kind: 'screen', id: 'analytics', label: 'Analytics' })
  }
  if (profile.isAdmin) tabs.push({ kind: 'screen', id: 'staff', label: 'Staff' })
  tabs.push({ kind: 'screen', id: 'settings', label: 'Settings' })
  return tabs
}

/** The role's workspace: the first screen tab. */
export function landingFor(profile: ActiveProfile): ScreenId {
  const first = tabsFor(profile).find((t): t is ScreenTab => t.kind === 'screen')
  return first?.id ?? 'visits'
}

function renderScreen(
  id: ScreenId,
  deviceId: string | null,
  dataVersion: number,
  bumpData: () => void,
  profile: ActiveProfile,
  onSignOut: () => Promise<void>,
  demo: DemoAppHooks | null,
) {
  switch (id) {
    case 'board':
      return (
        <BoardScreen
          deviceId={deviceId}
          refreshSignal={dataVersion}
          profile={profile}
          onRefresh={bumpData}
        />
      )
    case 'lab':
      return (
        <LabScreen
          deviceId={deviceId}
          refreshSignal={dataVersion}
          profile={profile}
          onRefresh={bumpData}
        />
      )
    case 'pharmacy':
      return (
        <PharmacyScreen
          deviceId={deviceId}
          refreshSignal={dataVersion}
          profile={profile}
          onRefresh={bumpData}
        />
      )
    case 'visits':
      // refreshSignal, NEVER key: a remount would destroy a part-typed visit
      // every time another device synced. Role mode: Edit and + New visit
      // from the chart open the signed-in role's view of the form.
      return (
        <RecordsScreen
          deviceId={deviceId}
          refreshSignal={dataVersion}
          role={profile.role}
          isAdmin={profile.isAdmin}
        />
      )
    case 'analytics':
      return <AnalyticsScreen refreshSignal={dataVersion} />
    case 'staff':
      // Only reachable as an admin (tabsFor + the shown-tab guard); the
      // check keeps a demotion race honest.
      if (!profile.isAdmin) return null
      // Demo build: the simulated roster, local only (no network, ever).
      if (__DH_DEMO__ && demo) return demo.renderStaff(profile, bumpData)
      return <StaffScreen profile={profile} onRefresh={bumpData} />
    case 'settings': {
      const screen = (
        <SettingsScreen
          product="clinic"
          onRefresh={bumpData}
          account={{
            displayName: profile.displayName,
            role: profile.role,
            isAdmin: profile.isAdmin,
          }}
          // Demo build: Sign out says it is not available here.
          onSignOut={__DH_DEMO__ && demo ? demo.signOut : onSignOut}
        />
      )
      // Demo build: the not-available note sits above the screen.
      if (__DH_DEMO__ && demo) {
        return (
          <>
            {demo.settingsNote}
            {screen}
          </>
        )
      }
      return screen
    }
  }
}

// ---------------------------------------------------------------------------
// App
//
// The visit form renders WITHOUT any shell-side dialog wrapper: the form
// owns its backdrop (which is deliberately NOT a close target - a gloved
// hand brushing bare backdrop once discarded a whole visit), its focus
// trap, and an Escape path that goes through the discard confirm. Wrapping
// it in a second dialog here would reintroduce both bugs at once.
// ---------------------------------------------------------------------------

export interface AppProps {
  /** Demo build only: the simulated account and demo screens (src/demo). */
  demo?: DemoAppHooks
}

export function App({ demo }: AppProps) {
  // Honored only in a DH_DEMO build; the literal folds this to null elsewhere.
  const demoHooks: DemoAppHooks | null = __DH_DEMO__ ? (demo ?? null) : null
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  // null until the person picks a tab: the role's workspace is the landing
  // tab, and it is only known once the account gate has a profile.
  const [tab, setTab] = useState<ScreenId | null>(null)
  const [visitOpen, setVisitOpen] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const [storageStop, setStorageStop] = useState<string | null>(null)
  const [storageAlert, setStorageAlert] = useState<string | null>(null)
  const [tabAlert, setTabAlert] = useState(false)
  const [gate, setGate] = useState<Gate>({ kind: 'checking' })
  // Why the join link this page was opened with could not be used, if any.
  const [joinError, setJoinError] = useState<string | null>(null)
  // One join per page load, even under StrictMode's double effect run.
  const joinRun = useRef<Promise<string | null> | null>(null)

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), [])
  const ready = boot.state === 'ready'

  // Account gate: re-evaluated on demand (sign-in, check-again, wizard
  // done) and on auth changes. The sequence ref drops stale async results.
  const gateSeq = useRef(0)
  const refreshGate = useCallback(async (): Promise<void> => {
    const n = ++gateSeq.current
    const g = await evaluateGate(demoHooks)
    if (n === gateSeq.current) setGate(g)
  }, [demoHooks])

  const doSignOut = useCallback(async (): Promise<void> => {
    await authSession.signOut()
    await refreshGate()
  }, [refreshGate])

  // Gate lifecycle: one evaluation at boot, then again on every auth change
  // (sign-in/out elsewhere, token refresh outcomes). No org-mode
  // subscription: the mode row never decides anything on a Clinic device.
  useEffect(() => {
    if (!ready) return
    void refreshGate()
    const unsubAuth = authSession.onAuthChange(() => {
      void refreshGate()
    })
    return () => {
      unsubAuth()
    }
  }, [ready, refreshGate])

  // Demo build: a seat picked on the panel is a new account for the shell.
  // Re-evaluate the gate and land on that role's workspace, as a fresh
  // sign-in would; the data underneath is untouched.
  useEffect(() => {
    if (!(__DH_DEMO__ && demoHooks)) return
    return demoHooks.onProfileChange(() => {
      setTab(null)
      void refreshGate()
    })
  }, [demoHooks, refreshGate])

  // Once an account is active, make sure this device has a fleet row. A
  // device that first connected while the org was already in clinic mode
  // could never register through the shared key (that surface is closed),
  // and the records policies reject pushes from unknown devices; the
  // signed-in POST is the recovery. ignore-duplicates makes it a no-op for
  // devices that already have their row. Best-effort once per activation.
  const fleetChecked = useRef(false)
  useEffect(() => {
    if (gate.kind !== 'active') {
      fleetChecked.current = false
      return
    }
    if (fleetChecked.current) return
    fleetChecked.current = true
    // Demo build: no fleet row, no server.
    if (__DH_DEMO__ && demoHooks) return
    void ensureFleetRow()
  }, [gate, demoHooks])

  // First ACTIVE ADMIN sign-in: write orgMode=clinic for the org if it is
  // not already, silently (see src/clinicOrgMode.ts). Once per activation
  // on success; a failure (offline, refused) clears the mark so the next
  // gate evaluation tries again.
  const orgModeEnsured = useRef(false)
  useEffect(() => {
    if (gate.kind !== 'active') {
      orgModeEnsured.current = false
      return
    }
    // Demo build: there is no org row to write and no server to refuse.
    if (__DH_DEMO__ && demoHooks) return
    if (!gate.profile.isAdmin || orgModeEnsured.current) return
    orgModeEnsured.current = true
    void ensureClinicOrgMode(gate.profile).then((r) => {
      if (!r.ok) orgModeEnsured.current = false
    })
  }, [gate, demoHooks])

  // Config push follows the ACCOUNT, never the device role. In Clinic the
  // server accepts config writes only from an admin account (dh_is_admin),
  // and a device that joined through a link is a 'standard' device by
  // design, so the engine's default device-role gate would keep an admin's
  // Settings edits local forever. The policy reads the live gate through a
  // ref so a demotion or sign-out takes effect on the very next cycle.
  const accountIsAdmin = useRef(false)
  accountIsAdmin.current = gate.kind === 'active' && gate.profile.isAdmin
  useEffect(() => {
    // Demo build: the engine never runs (demo safety law 4).
    if (__DH_DEMO__ && demoHooks) return
    syncEngine.setConfigPushPolicy(() => accountIsAdmin.current)
    return () => {
      syncEngine.setConfigPushPolicy(null)
    }
  }, [demoHooks])

  // The live board: once an account is active, the engine runs its full
  // cycle every CLINIC_AUTO_SYNC_INTERVAL_MS (the floor) and the realtime
  // trigger turns every remote change into a debounced cycle (the 1-3 s
  // path). Both stop the moment the gate leaves 'active' (sign-out, a
  // revoked or pending verdict). Keyed on the KIND, not the gate object: a
  // gate re-evaluation that lands on the same active account must not
  // bounce the channel.
  const gateActive = gate.kind === 'active'
  useEffect(() => {
    if (!gateActive) return
    // Demo build: the engine, the trigger and auto-sync never start (demo
    // safety law 4: the demo can never sync).
    if (__DH_DEMO__ && demoHooks) return
    syncEngine.startAutoSync({ intervalMs: CLINIC_AUTO_SYNC_INTERVAL_MS })
    realtimeTrigger.start({ getAccessToken: () => authSession.getAccessToken() })
    return () => {
      realtimeTrigger.stop()
      syncEngine.stopAutoSync()
    }
  }, [gateActive, demoHooks])

  // The chip says "Live" only while the channel is actually subscribed.
  const [live, setLive] = useState(() => realtimeTrigger.getStatus() === 'live')
  useEffect(() => realtimeTrigger.onStatus((s) => setLive(s === 'live')), [])

  // Boot: a join link in the URL is consumed FIRST (consumeJoinLink), then
  // the setupComplete flag ALONE decides (see module header). The sequence
  // number drops a superseded run's results (StrictMode's double effect
  // run, or a later re-boot from a hashchange below).
  const bootSeq = useRef(0)
  const runBoot = useCallback(async (): Promise<void> => {
    const n = ++bootSeq.current
    try {
      // Demo build: the join-link boot path is bypassed outright (no
      // project to join, no confirm, no network).
      joinRun.current ??= __DH_DEMO__ && demoHooks ? Promise.resolve(null) : consumeJoinLink()
      const notice = await joinRun.current
      if (n !== bootSeq.current) return
      setJoinError(notice)
      const done = await getSetting<string>('setupComplete')
      if (n !== bootSeq.current) return
      if (done !== 'true') {
        setBoot({ state: 'setup' })
        return
      }
      const info = await loadReadyInfo()
      if (n === bootSeq.current) setBoot({ state: 'ready', ...info })
    } catch (e) {
      if (n === bootSeq.current) {
        setBoot({
          state: 'error',
          message: 'This device could not open its records store.',
          detail: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }, [demoHooks])

  useEffect(() => {
    void runBoot()
  }, [runBoot])

  // A join link can also arrive in a tab that already shows the app (pasted
  // into the address bar, or a tapped link that the browser routed to the
  // open tab): that is a same-document navigation, which fires hashchange
  // and never reloads. Without this the link would be ignored in silence,
  // so the shell boots again from the top; a part-typed visit is covered by
  // the form's own draft recovery.
  useEffect(() => {
    // Demo build: no join links, so no re-boot on a hash change either.
    if (__DH_DEMO__ && demoHooks) return
    const onHashChange = (): void => {
      if (readJoinLink(window.location.hash).kind === 'none') return
      joinRun.current = null
      setBoot({ state: 'loading' })
      setGate({ kind: 'checking' })
      void runBoot()
    }
    window.addEventListener('hashchange', onHashChange)
    return () => {
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [runBoot, demoHooks])

  // Storage health: immediately, every 60s, and again when the data changes.
  useEffect(() => {
    if (!ready) return
    let stop = false
    const check = async (): Promise<void> => {
      try {
        const h = await readStorageHealth()
        if (stop) return
        setStorageStop(storageEmergency(h))
        setStorageAlert(storageWarning(h))
      } catch {
        /* the health read must never crash the shell */
      }
    }
    void check()
    const timer = setInterval(() => {
      void check()
    }, 60_000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [ready, dataVersion])

  // Multi-tab warning: only where the browser cannot serialize tabs itself
  // (no Web Locks). With locks, the cross-tab layer handles it silently.
  useEffect(() => {
    if (!ready || hasCrossTabLock()) return
    let stale = false
    void detectOtherTabs().then((found) => {
      if (!stale && found) setTabAlert(true)
    })
    return () => {
      stale = true
    }
  }, [ready])

  // Another tab's write, or a sync pull, invalidates our snapshot.
  useEffect(() => {
    if (!ready) return
    const unsubTab = onExternalWrite(bumpData)
    const unsubSync = syncEngine.onRecordsUpdated(bumpData)
    // Demo build: the simulated colleagues write in THIS tab, so neither of
    // the above fires; the demo tells the shell directly.
    const unsubDemo = __DH_DEMO__ && demoHooks ? demoHooks.onRecordsChanged(bumpData) : () => {}
    return () => {
      unsubTab()
      unsubSync()
      unsubDemo()
    }
  }, [ready, bumpData, demoHooks])

  // Adopt-older-copy flow. Restoring a backup file is always better, and
  // every string here says so before offering the mirror.
  const adoptOlderCopy = useCallback(async () => {
    const r = records.mirrorRefusal()
    if (!r) return
    const held = r.expectedCount !== null ? String(r.expectedCount) : 'more'
    const when = r.mirrorAt ? new Date(r.mirrorAt).toLocaleDateString() : 'that copy was made'
    const ok = window.confirm(
      `Load the older copy of ${r.mirrorCount} records?\n\nThis device last had ${held} records. Anything entered after ${when} is NOT in it and will not come back.\n\nIf you have a backup file anywhere, cancel and restore that instead.`,
    )
    if (!ok) return
    try {
      const n = await records.adoptMirror()
      window.alert(
        `Loaded ${n} records from the older copy. Take a backup now, before entering anything else.`,
      )
      bumpData()
    } catch (e) {
      window.alert(`Could not load the older copy: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [bumpData])

  // ------------------------------------------------------------ boot gates

  if (boot.state === 'loading') {
    return <div className="boot">Loading…</div>
  }

  // A join link that could not be used, on the screens that are not the
  // wizard (the wizard shows it in its own alert slot).
  const joinNotice = joinError ? (
    <div className="banner banner-warn" role="alert">
      <strong>That join link could not be used.</strong> {joinError}
    </div>
  ) : null

  if (boot.state === 'setup') {
    return (
      <ErrorBoundary>
        <SetupWizard
          product="clinic"
          joinError={joinError}
          onDone={() => {
            // The ready flip runs the gate effect above, which evaluates
            // the freshly stored credentials.
            void loadReadyInfo().then((info) => setBoot({ state: 'ready', ...info }))
          }}
        />
      </ErrorBoundary>
    )
  }

  if (boot.state === 'error') {
    return (
      <div className="boot">
        <div className="alert alert-bad" role="alert" style={{ textAlign: 'left' }}>
          <strong>The app could not start</strong>
          <p>{boot.message}</p>
          <p>Your records have not been changed or deleted.</p>
          <ol className="steps">
            <li>Close the app completely and open it again.</li>
            <li>If that fails, restart the device and try once more.</li>
            <li>
              If it still will not start, use a different device for today's clinic and tell your
              admin. Do NOT clear this browser's data or delete the app - that would erase any
              records that have not synced yet.
            </li>
          </ol>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
          {boot.detail ? (
            <details className="mt">
              <summary>Technical details</summary>
              <pre className="mono small">{boot.detail}</pre>
            </details>
          ) : null}
        </div>
      </div>
    )
  }

  // ----------------------------------------------------------- account gate

  if (gate.kind === 'checking') {
    return <div className="boot">Loading…</div>
  }

  if (gate.kind === 'noCloud') {
    // Set up, but no project to talk to: not a Clinic device yet. The
    // wizard's cloud step stores verified credentials, after which the
    // gate is evaluated again.
    return (
      <ErrorBoundary>
        <SetupWizard
          product="clinic"
          joinError={joinError}
          onDone={() => {
            void refreshGate()
          }}
        />
      </ErrorBoundary>
    )
  }

  if (gate.kind === 'signedOut') {
    return (
      <ErrorBoundary>
        {joinNotice}
        <SignInScreen
          onSignedIn={() => {
            void refreshGate()
          }}
        />
      </ErrorBoundary>
    )
  }

  if (gate.kind === 'pending') {
    return (
      <ErrorBoundary>
        {joinNotice}
        <PendingScreen
          displayName={gate.displayName}
          offline={gate.offline}
          onCheckAgain={refreshGate}
          onSignOut={doSignOut}
        />
      </ErrorBoundary>
    )
  }

  if (gate.kind === 'revoked') {
    return (
      <ErrorBoundary>
        {joinNotice}
        <RevokedScreen
          displayName={gate.displayName}
          onCheckAgain={refreshGate}
          onSignOut={doSignOut}
        />
      </ErrorBoundary>
    )
  }

  // --------------------------------------------------------------- ready

  const profile = gate.profile
  const tabs = tabsFor(profile)
  // Before any pick, the role's workspace. A demotion or a role change can
  // also strand the tab state on a screen that no longer exists (Staff
  // after losing admin, Board after being moved to pharmacy); fall back to
  // the workspace then too.
  const screenIds = new Set(tabs.filter((t) => t.kind === 'screen').map((t) => t.id))
  const shownTab: ScreenId = tab && screenIds.has(tab) ? tab : landingFor(profile)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span className="brand-name">DH EMR Clinic</span>
        </div>
        <nav className="tabbar" aria-label="Main">
          {tabs.map((t) =>
            t.kind === 'screen' ? (
              <button
                key={t.id}
                className={shownTab === t.id ? 'tab active' : 'tab'}
                aria-current={shownTab === t.id ? 'page' : undefined}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ) : (
              <button key={t.id} className="tab" onClick={() => setVisitOpen(true)}>
                {t.label}
              </button>
            ),
          )}
        </nav>
        {/* Clinic has no standalone devices: the chip always reports the
            cloud. The demo build has no cloud and its chip says so. */}
        {__DH_DEMO__ && demoHooks ? (
          demoHooks.syncChip
        ) : (
          <SyncChip standalone={false} onSynced={bumpData} live={live} />
        )}
      </header>

      {storageStop ? (
        <div className="banner banner-stop" role="alert">
          <strong>This device cannot read its records. Do not enter more patients here.</strong>
          <p>{storageStop}</p>
          <div className="btn-row">
            <button className="btn" onClick={() => setTab('settings')}>
              Go to Settings to restore a backup
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => {
                void adoptOlderCopy()
              }}
            >
              Use the older copy instead
            </button>
          </div>
        </div>
      ) : null}

      {storageAlert ? (
        <div className="banner banner-warn" role="alert">
          <strong>Back this device up today.</strong> {storageAlert}
        </div>
      ) : null}

      {tabAlert ? (
        <div className="banner banner-stop" role="alert">
          <strong>Close the other tabs.</strong> This app is open in more than one tab or window
          on this device, and this browser cannot keep them in step. Close the others now -
          records entered in one can overwrite the other.
        </div>
      ) : null}

      {gate.stale ? (
        <div className="banner banner-warn" role="status">
          <strong>Reconnect to confirm your account.</strong> This device has not been able to
          check with your organization's server for over a week. Everything keeps working;
          connect to the internet when you can so your account can be confirmed.
        </div>
      ) : null}

      {/* Mounting starts SW registration; the bar itself only renders in
          clinical builds with a waiting worker, and never auto-reloads. */}
      <UpdateBar />

      <main>
        {/* key resets a failed boundary when the user navigates away. */}
        <ErrorBoundary key={shownTab}>
          {renderScreen(shownTab, boot.deviceId, dataVersion, bumpData, profile, doSignOut, demoHooks)}
        </ErrorBoundary>
      </main>

      {visitOpen ? (
        <EncounterForm
          // Role mode: the signed-in role's sections (core/config/roles).
          role={profile.role}
          isAdmin={profile.isAdmin}
          onClose={() => setVisitOpen(false)}
          onSaved={(_saved, andNext) => {
            bumpData()
            setTab('visits')
            // Plain Save files the visit and closes; Save & next patient has
            // already reset the form for the next entry and stays open.
            if (!andNext) setVisitOpen(false)
          }}
        />
      ) : null}
    </div>
  )
}
