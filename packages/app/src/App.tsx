/**
 * App shell: boot gate, tab bar, storage health banners, multi-tab warning,
 * sync chip, and the visit panel plumbing. The screens themselves belong to
 * other modules (records, encounter, setup, settings) and mount behind
 * per-tab error boundaries.
 *
 * Boot order: kernel/settings read -> the setupComplete flag ALONE decides
 * first-run -> main shell. A leftover device id must NOT bypass the wizard:
 * a legacy install or a crash between device registration and the final
 * setupComplete write would otherwise boot into the app with unverified
 * credentials and placeholder clinic lists.
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
} from './kernel'
import { ensureFleetRow, getDeviceId, getDeviceRole, syncEngine } from './sync'
import {
  authSession,
  getOrgMode,
  loadCurrentProfile,
  subscribeOrgMode,
  type ActiveProfile,
} from './auth'
import AnalyticsScreen from './ui/analytics/AnalyticsScreen'
import { ErrorBoundary } from './ui/app/ErrorBoundary'
import { SyncChip } from './ui/app/SyncChip'
import { UpdateBar } from './ui/app/UpdateBar'
import PendingScreen from './ui/auth/PendingScreen'
import RevokedScreen from './ui/auth/RevokedScreen'
import SignInScreen from './ui/auth/SignInScreen'
import BoardScreen from './ui/board/BoardScreen'
import EncounterForm from './ui/encounter/EncounterForm'
import RecordsScreen from './ui/records/RecordsScreen'
import SettingsScreen from './ui/settings/SettingsScreen'
import SetupWizard from './ui/setup/SetupWizard'
import StaffScreen from './ui/staff/StaffScreen'

// ---------------------------------------------------------------------------
// Boot state
// ---------------------------------------------------------------------------

type Boot =
  | { state: 'loading' }
  | { state: 'setup' }
  | { state: 'ready'; deviceId: string | null; role: string; standalone: boolean }
  | { state: 'error'; message: string; detail?: string }

async function loadReadyInfo(): Promise<{
  deviceId: string | null
  role: string
  standalone: boolean
}> {
  const deviceId = await getDeviceId()
  const role = await getDeviceRole()
  const standalone = (await getSetting<string>('standaloneMode')) === 'true'
  return { deviceId, role, standalone }
}

// ---------------------------------------------------------------------------
// Clinic-mode account gate.
//
// Applies ONLY when the org is in clinic mode AND this device holds cloud
// credentials: field mode and offline-only devices take the 'none' branch
// and render exactly as before. When it applies, boot requires an account
// decision: active (live or cached - offline never stops a clinic) opens
// the shell, pending/revoked get their screens, signed out gets sign-in.
// Revocation while offline is enforced server-side the moment the device
// reconnects; the cached profile is an availability decision, not a
// security hole the server does not already document.
// ---------------------------------------------------------------------------

type Gate =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'signedOut' }
  | { kind: 'pending'; displayName: string; offline: boolean }
  | { kind: 'revoked'; displayName: string }
  | { kind: 'active'; profile: ActiveProfile; stale: boolean }

async function evaluateGate(): Promise<Gate> {
  if (!syncEngine.hasCloud()) return { kind: 'none' }
  if ((await getOrgMode()) !== 'clinic') return { kind: 'none' }
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
// Tabs. Data-driven: field mode gets exactly the original three; an active
// clinic account adds Board first, and an active admin adds Staff before
// Settings. tabsFor is the ONE place the list is decided.
// ---------------------------------------------------------------------------

type ScreenId = 'board' | 'visits' | 'analytics' | 'staff' | 'settings'

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

function tabsFor(profile: ActiveProfile | null): TabDef[] {
  const tabs: TabDef[] = []
  if (profile) tabs.push({ kind: 'screen', id: 'board', label: 'Board' })
  tabs.push(
    { kind: 'screen', id: 'visits', label: 'Visits' },
    { kind: 'action', id: 'new-visit', label: 'New visit' },
    // Both modes; after the Visits pair so New visit keeps its reach.
    { kind: 'screen', id: 'analytics', label: 'Analytics' },
  )
  if (profile?.isAdmin) tabs.push({ kind: 'screen', id: 'staff', label: 'Staff' })
  tabs.push({ kind: 'screen', id: 'settings', label: 'Settings' })
  return tabs
}

function renderScreen(
  id: ScreenId,
  deviceId: string | null,
  dataVersion: number,
  bumpData: () => void,
  profile: ActiveProfile | null,
  onSignOut: () => Promise<void>,
) {
  switch (id) {
    case 'board':
      // Only reachable with an active clinic profile (tabsFor + the shown-tab
      // guard); the null check keeps TypeScript and a race honest.
      if (!profile) return null
      return (
        <BoardScreen
          deviceId={deviceId}
          refreshSignal={dataVersion}
          profile={profile}
          onRefresh={bumpData}
        />
      )
    case 'visits':
      // refreshSignal, NEVER key: a remount would destroy a part-typed visit
      // every time another device synced.
      return <RecordsScreen deviceId={deviceId} refreshSignal={dataVersion} />
    case 'analytics':
      return <AnalyticsScreen refreshSignal={dataVersion} />
    case 'staff':
      if (!profile) return null
      return <StaffScreen profile={profile} onRefresh={bumpData} />
    case 'settings':
      return (
        <SettingsScreen
          onRefresh={bumpData}
          account={
            profile
              ? {
                  displayName: profile.displayName,
                  role: profile.role,
                  isAdmin: profile.isAdmin,
                }
              : null
          }
          onSignOut={profile ? onSignOut : undefined}
        />
      )
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

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' })
  const [tab, setTab] = useState<ScreenId>('visits')
  const [visitOpen, setVisitOpen] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const [storageStop, setStorageStop] = useState<string | null>(null)
  const [storageAlert, setStorageAlert] = useState<string | null>(null)
  const [tabAlert, setTabAlert] = useState(false)
  const [gate, setGate] = useState<Gate>({ kind: 'checking' })

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), [])
  const ready = boot.state === 'ready'

  // Clinic gate: re-evaluated on demand (sign-in, check-again) and on the
  // subscriptions below. The sequence ref drops stale async results.
  const gateSeq = useRef(0)
  const refreshGate = useCallback(async (): Promise<void> => {
    const n = ++gateSeq.current
    const g = await evaluateGate()
    if (n === gateSeq.current) setGate(g)
  }, [])

  const doSignOut = useCallback(async (): Promise<void> => {
    await authSession.signOut()
    await refreshGate()
  }, [refreshGate])

  // Gate lifecycle: the orgMode subscription fires once immediately (which
  // performs the boot-time evaluation) and again when a config pull flips
  // the mode; auth changes (sign-in/out elsewhere, token refresh outcomes)
  // re-check too. Field mode resolves to 'none' from local reads only.
  useEffect(() => {
    if (!ready) return
    const unsubMode = subscribeOrgMode(() => {
      void refreshGate()
    })
    const unsubAuth = authSession.onAuthChange(() => {
      void refreshGate()
    })
    return () => {
      unsubMode()
      unsubAuth()
    }
  }, [ready, refreshGate])

  // Once a clinic account is active, make sure this device has a fleet row.
  // A device that first connected while the org was already in clinic mode
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
    void ensureFleetRow()
  }, [gate])

  // Boot: gate on setupComplete ONLY (see module header).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const done = await getSetting<string>('setupComplete')
        if (cancelled) return
        if (done !== 'true') {
          setBoot({ state: 'setup' })
          return
        }
        const info = await loadReadyInfo()
        if (!cancelled) setBoot({ state: 'ready', ...info })
      } catch (e) {
        if (!cancelled) {
          setBoot({
            state: 'error',
            message: 'This device could not open its records store.',
            detail: e instanceof Error ? e.message : String(e),
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
    return () => {
      unsubTab()
      unsubSync()
    }
  }, [ready, bumpData])

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

  if (boot.state === 'setup') {
    return (
      <ErrorBoundary>
        <SetupWizard
          onDone={() => {
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

  // ---------------------------------------------------- clinic account gate

  if (gate.kind === 'checking') {
    return <div className="boot">Loading…</div>
  }

  if (gate.kind === 'signedOut') {
    return (
      <ErrorBoundary>
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
        <RevokedScreen
          displayName={gate.displayName}
          onCheckAgain={refreshGate}
          onSignOut={doSignOut}
        />
      </ErrorBoundary>
    )
  }

  // --------------------------------------------------------------- ready

  const profile = gate.kind === 'active' ? gate.profile : null
  const tabs = tabsFor(profile)
  // A demotion or sign-out can strand the tab state on a screen that no
  // longer exists (Staff after losing admin); fall back to Visits.
  const screenIds = new Set(tabs.filter((t) => t.kind === 'screen').map((t) => t.id))
  const shownTab: ScreenId = screenIds.has(tab) ? tab : 'visits'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span className="brand-name">DH EMR</span>
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
        <SyncChip standalone={boot.standalone} onSynced={bumpData} />
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

      {gate.kind === 'active' && gate.stale ? (
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
          {renderScreen(shownTab, boot.deviceId, dataVersion, bumpData, profile, doSignOut)}
        </ErrorBoundary>
      </main>

      {visitOpen ? (
        <EncounterForm
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
