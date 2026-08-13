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
import { useCallback, useEffect, useState } from 'react'
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
import { getDeviceId, getDeviceRole, syncEngine } from './sync'
import { ErrorBoundary } from './ui/app/ErrorBoundary'
import { SyncChip } from './ui/app/SyncChip'
import EncounterForm from './ui/encounter/EncounterForm'
import RecordsScreen from './ui/records/RecordsScreen'
import SettingsScreen from './ui/settings/SettingsScreen'
import SetupWizard from './ui/setup/SetupWizard'

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
// Tabs. Data-driven so clinic mode can add a Board tab later: add an entry
// here and a case in renderScreen, and the bar just renders it.
// ---------------------------------------------------------------------------

type ScreenId = 'visits' | 'settings'

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

const TABS: TabDef[] = [
  { kind: 'screen', id: 'visits', label: 'Visits' },
  { kind: 'action', id: 'new-visit', label: 'New visit' },
  { kind: 'screen', id: 'settings', label: 'Settings' },
]

function renderScreen(
  id: ScreenId,
  deviceId: string | null,
  dataVersion: number,
  bumpData: () => void,
) {
  switch (id) {
    case 'visits':
      // refreshSignal, NEVER key: a remount would destroy a part-typed visit
      // every time another device synced.
      return <RecordsScreen deviceId={deviceId} refreshSignal={dataVersion} />
    case 'settings':
      return <SettingsScreen onRefresh={bumpData} />
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

  const bumpData = useCallback(() => setDataVersion((v) => v + 1), [])
  const ready = boot.state === 'ready'

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

  // --------------------------------------------------------------- ready

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
          {TABS.map((t) =>
            t.kind === 'screen' ? (
              <button
                key={t.id}
                className={tab === t.id ? 'tab active' : 'tab'}
                aria-current={tab === t.id ? 'page' : undefined}
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

      <main>
        {/* key={tab} resets a failed boundary when the user navigates away. */}
        <ErrorBoundary key={tab}>
          {renderScreen(tab, boot.deviceId, dataVersion, bumpData)}
        </ErrorBoundary>
      </main>

      {visitOpen ? (
        <EncounterForm
          onClose={() => setVisitOpen(false)}
          onSaved={() => {
            bumpData()
            setTab('visits')
          }}
        />
      ) : null}
    </div>
  )
}
