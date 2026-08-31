/**
 * Settings screen: device identity, cloud sync, backup and restore, cloud
 * import, clinic lists, formulary and lab tests, the read-only template
 * library, and About.
 *
 * Rules carried over from shipped bugs:
 *  - Rename NEVER re-registers a device that already has an id (a fresh id
 *    would strand the fleet row and make its own records read as another
 *    device's). renameDevice in src/sync owns that rule.
 *  - Manual sync reports honestly via syncNowChecked: the post-run unsynced
 *    count is ground truth, because the engine's cycle swallows push
 *    failures and still ends on 'synced'.
 *  - Connecting to a (new) cloud project goes through connectToProject:
 *    verify tables first, never store an unverified key, and re-register in
 *    the new project so uploads are not silently rejected.
 *  - Restore asks about settings in a SEPARATE second confirm whose default
 *    (Cancel) restores records only.
 *  - File inputs clear their value BEFORE handling, so cancelling a confirm
 *    never wedges the picker for the same file.
 *  - Empty clinic lists are never written: an empty list would block every
 *    save. Admin-only controls are DISABLED with the reason shown, never
 *    silently ignored.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { config, getSetting, type KV } from '../../kernel'
import {
  SYNC_LABELS,
  classifySupabaseKey,
  effectiveStatus,
  getDeviceId,
  getDeviceName,
  getDeviceRole,
  normalizeSupabaseUrl,
  renameDevice,
  syncEngine,
  type DeviceRole,
  type SyncStatus,
} from '../../sync'
import { downloadBackup, restoreFromFile } from '../../lib/backup'
import { importCloudFile } from '../../lib/importCloud'
import {
  DEFAULT_FLOW_STATIONS,
  getConfig,
  isPlaceholderConfig,
  loadLibrary,
  newConfigId,
  parseList,
  resolveFormulary,
  resolveStringList,
  setComplaints,
  setFlowStations,
  setFormulary,
  setLabTests,
  setProcedures,
  setProviders,
  setReferralTypes,
  setSites,
} from '../../config/keys'
import { getOrgMode, type OrgMode } from '../../auth'
import { switchOrgMode } from '../staff/staffApi'
import {
  DEFAULT_COMPLAINTS,
  DEFAULT_LAB_TESTS,
  DEFAULT_PHYSICIANS,
  DEFAULT_PROCEDURES,
  DEFAULT_REFERRAL_TYPES,
  DEFAULT_SITES,
} from '../../config/defaults'
import type { CustomLabTest, FormTemplate, FormularyEntry, LabRange } from '../../config/types'
import { PresetEditors } from '../presets/PresetEditors'
import TemplateBuilder from '../templates/TemplateBuilder'
import { RangeEditor } from '../labs/RangeEditor'
import {
  UNSAVED_TEST_REASON,
  saveTestRanges,
  withRanges,
  type SaveRangesResult,
} from '../labs/rangesModel'
import './settings.css'

export interface SettingsScreenProps {
  /** Called after an action that changed records or config (sync, restore, import, list edits). */
  onRefresh?: () => void
  /** Clinic mode only: the signed-in account. Renders the Account card when set. */
  account?: { displayName: string; role: string; isAdmin: boolean } | null
  /** Clinic mode only: sign this account out of the device. */
  onSignOut?: () => void | Promise<void>
}

const APP_VERSION = '0.1.0'

const GATE_REASON = 'Only an admin device can change this. This device is set to standard.'

// ---------------------------------------------------------------------------
// Clinic list definitions
// ---------------------------------------------------------------------------

type ListKey =
  | 'sites'
  | 'providers'
  | 'complaints'
  | 'procedures'
  | 'referralTypes'
  | 'flowStations'

interface ListDef {
  key: ListKey
  label: string
  noun: string
  saveLabel: string
  /** Helper text under the textarea (the flow-stations rename warning). */
  help?: string
  /** Success-message tail; defaults to the visit-form hint. */
  savedHint?: string
}

const LIST_DEFS: ListDef[] = [
  { key: 'sites', label: 'Clinic or site names', noun: 'site', saveLabel: 'Save sites' },
  { key: 'providers', label: 'Clinicians', noun: 'clinician', saveLabel: 'Save clinicians' },
  { key: 'complaints', label: 'Complaints', noun: 'complaint', saveLabel: 'Save complaints' },
  { key: 'procedures', label: 'Procedures', noun: 'procedure', saveLabel: 'Save procedures' },
  {
    key: 'referralTypes',
    label: 'Referral destinations',
    noun: 'referral destination',
    saveLabel: 'Save referral destinations',
  },
  {
    key: 'flowStations',
    label: 'Patient flow stations (clinic mode board)',
    noun: 'station',
    saveLabel: 'Save stations',
    // The rename warning comes from src/config/keys.ts: station names are
    // the identity visits point at, exactly like sites.
    help:
      'One station per line, in board order; the last station means done for the day. ' +
      'Station names are how visits point at a station, so renaming one strands ' +
      "today's visits under the old name. To rename mid-day, add the new name first " +
      'and remove the old one after the day is done.',
    savedHint: 'The board picks them up on its next refresh.',
  },
]

const LIST_WRITERS: Record<ListKey, (kv: KV, list: string[]) => Promise<void>> = {
  sites: setSites,
  providers: setProviders,
  complaints: setComplaints,
  procedures: setProcedures,
  referralTypes: setReferralTypes,
  flowStations: setFlowStations,
}

const LIST_DEFAULTS: Record<ListKey, readonly string[]> = {
  sites: DEFAULT_SITES,
  providers: DEFAULT_PHYSICIANS,
  complaints: DEFAULT_COMPLAINTS,
  procedures: DEFAULT_PROCEDURES,
  referralTypes: DEFAULT_REFERRAL_TYPES,
  flowStations: DEFAULT_FLOW_STATIONS,
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Kv({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className={mono ? 'kv-v mono' : 'kv-v'}>{v}</span>
    </div>
  )
}

interface DeviceInfo {
  deviceId: string | null
  name: string
  role: DeviceRole
  standalone: boolean
}

type Message = { tone: 'ok' | 'bad'; text: string } | null

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export default function SettingsScreen({ onRefresh, account, onSignOut }: SettingsScreenProps) {
  const [loaded, setLoaded] = useState(false)
  const [info, setInfo] = useState<DeviceInfo>({
    deviceId: null,
    name: '',
    role: 'standard',
    standalone: false,
  })
  const [pending, setPending] = useState(0)
  const [status, setStatus] = useState<SyncStatus>(() => effectiveStatus(syncEngine.getStatus()))
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<Message>(null)

  // Clinic lists: draft text per textarea, plus the stored sites/providers
  // for the placeholder warning.
  const [drafts, setDrafts] = useState<Record<ListKey, string>>({
    sites: '',
    providers: '',
    complaints: '',
    procedures: '',
    referralTypes: '',
    flowStations: '',
  })
  const [orgMode, setOrgMode] = useState<OrgMode>('field')
  const [storedLists, setStoredLists] = useState<{ sites: string[]; providers: string[] }>({
    sites: [],
    providers: [],
  })
  const [formularyRows, setFormularyRows] = useState<FormularyEntry[]>([])
  const [labRows, setLabRows] = useState<CustomLabTest[]>([])
  /** Ids of lab rows that exist in PERSISTED config (or the built-in panel a
   *  never-customized org resolves to). Ranges can only be edited on these:
   *  a staged-but-unsaved row is not in the stored base the range save
   *  patches, so its Ranges control is disabled with the reason. */
  const [savedLabIds, setSavedLabIds] = useState<Set<string>>(new Set())
  /** The lab row whose reference ranges are being edited, or null. */
  const [rangeTest, setRangeTest] = useState<CustomLabTest | null>(null)
  const [templates, setTemplates] = useState<FormTemplate[]>([])
  const [templateBuilderOpen, setTemplateBuilderOpen] = useState(false)

  const restoreRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  const refreshInfo = useCallback(async () => {
    const [deviceId, name, role, standaloneRaw, n] = await Promise.all([
      getDeviceId(),
      getDeviceName(),
      getDeviceRole(),
      getSetting<string>('standaloneMode'),
      syncEngine.getUnsyncedCount(),
    ])
    setInfo({ deviceId, name, role, standalone: standaloneRaw === 'true' })
    setPending(n)
  }, [])

  const loadConfigState = useCallback(async () => {
    const [
      sites,
      providers,
      complaints,
      procedures,
      referrals,
      stations,
      formularyStored,
      labsStored,
      lib,
      mode,
    ] = await Promise.all([
      getConfig(config, 'sites'),
      getConfig(config, 'providers'),
      getConfig(config, 'complaints'),
      getConfig(config, 'procedures'),
      getConfig(config, 'referralTypes'),
      getConfig(config, 'flowStations'),
      getConfig(config, 'formulary'),
      getConfig(config, 'customLabTests'),
      loadLibrary(config),
      getOrgMode(config),
    ])
    const resolvedSites = resolveStringList(sites, DEFAULT_SITES)
    const resolvedProviders = resolveStringList(providers, DEFAULT_PHYSICIANS)
    setDrafts({
      sites: resolvedSites.join('\n'),
      providers: resolvedProviders.join('\n'),
      complaints: resolveStringList(complaints, DEFAULT_COMPLAINTS).join('\n'),
      procedures: resolveStringList(procedures, DEFAULT_PROCEDURES).join('\n'),
      referralTypes: resolveStringList(referrals, DEFAULT_REFERRAL_TYPES).join('\n'),
      flowStations: resolveStringList(stations, DEFAULT_FLOW_STATIONS).join('\n'),
    })
    setOrgMode(mode)
    setStoredLists({ sites: resolvedSites, providers: resolvedProviders })
    setFormularyRows(resolveFormulary(formularyStored).map((r) => ({ ...r })))
    const labs = labsStored && labsStored.length ? labsStored : DEFAULT_LAB_TESTS
    setLabRows(labs.map((t) => ({ ...t })))
    setSavedLabIds(new Set(labs.map((t) => t.id)))
    setTemplates(lib.templates)
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([refreshInfo(), loadConfigState()]).then(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [refreshInfo, loadConfigState])

  // Sync status: engine subscription plus the browser's own connectivity
  // signal (never claim connected while offline).
  useEffect(() => {
    const unsub = syncEngine.onStatus((s) => setStatus(effectiveStatus(s)))
    const onOnline = (): void => setStatus(effectiveStatus(syncEngine.getStatus()))
    const onOffline = (): void => setStatus('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      unsub()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const isAdmin = info.role === 'admin'
  const creds = syncEngine.getCredentials()
  const offlineOnly = info.standalone || !syncEngine.hasCloud()
  const statusInfo = SYNC_LABELS[status]
  const onPlaceholders =
    loaded && isPlaceholderConfig(storedLists.sites, storedLists.providers)

  // ------------------------------------------------------------ device card
  // Inline forms, not window.prompt: prompt() is unavailable in some
  // webviews and PWAs, awkward on iPads, and it cannot show the key
  // guidance while the person is pasting the key.

  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [connectOpen, setConnectOpen] = useState(false)
  const [connUrl, setConnUrl] = useState('')
  const [connKey, setConnKey] = useState('')

  const doRename = async (next: string): Promise<void> => {
    setBusy('rename')
    setMessage(null)
    try {
      const r = await renameDevice(next)
      await refreshInfo()
      setMessage({ tone: r.ok ? 'ok' : 'bad', text: r.message })
      if (r.ok) setRenameOpen(false)
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  // ------------------------------------------------------------- cloud card

  const doConnect = async (rawUrl: string, rawKey: string): Promise<void> => {
    const norm = normalizeSupabaseUrl(rawUrl)
    const k = rawKey.trim()
    if (!norm.ok || !k) {
      setMessage({
        tone: 'bad',
        text: 'That URL or key does not look right. The URL should look like https://yourproject.supabase.co',
      })
      return
    }
    const cls = classifySupabaseKey(k)
    if (!cls.ok) {
      setMessage({ tone: 'bad', text: cls.error })
      return
    }
    setBusy('connect')
    setMessage(null)
    try {
      // Verify tables, store credentials only then, set standaloneMode
      // 'false', and register this device in the project: its security rules
      // only accept records from devices in its own fleet table.
      const res = await syncEngine.connectToProject(
        norm.url,
        k,
        info.name || 'Unnamed device',
        info.role,
      )
      if (!res.ok) {
        setMessage({
          tone: 'bad',
          text: res.error
            ? `Could not reach the project tables: ${res.error}`
            : 'Connected, but the records table was not found. Run the setup SQL on that project first.',
        })
        return
      }
      await refreshInfo()
      setConnectOpen(false)
      setConnKey('')
      setMessage({
        tone: 'ok',
        text: 'Connected and registered. Records on this device will upload on the next sync.',
      })
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const doSync = async (): Promise<void> => {
    setBusy('sync')
    setMessage(null)
    try {
      // Not syncNow(): the engine swallows push failures and still ends on
      // 'synced'. syncNowChecked re-reads the pending count as ground truth.
      const r = await syncEngine.syncNowChecked()
      setPending(await syncEngine.getUnsyncedCount())
      onRefresh?.()
      setMessage(
        r.ok
          ? {
              tone: 'ok',
              text:
                r.pushed > 0
                  ? `Sync finished. ${r.pushed} record${r.pushed === 1 ? '' : 's'} uploaded. Nothing is waiting.`
                  : 'Sync finished. Everything was already up to date.',
            }
          : {
              tone: 'bad',
              text: `NOT backed up. ${r.stillPending} record${r.stillPending === 1 ? ' is' : 's are'} still waiting to upload. ${r.reason} Take a backup before wiping or handing on this device.`,
            },
      )
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  // ------------------------------------------------------ organization card

  /**
   * The org-mode master switch. The write goes DIRECTLY through
   * switchOrgMode (an authedRequest upsert to /rest/v1/config), never the
   * background config push: the server's config rules trigger must vet the
   * caller immediately and its refusals surface here verbatim. The local
   * mirror only updates when the server accepted.
   *
   * Both directions confirm twice, loudly. Field -> clinic closes the
   * shared-key surface and strands any unsynced field records; clinic ->
   * field reopens the shared-key surface (the documented recovery path for
   * stranded records, and still a real decision).
   */
  const doSwitchMode = async (next: OrgMode): Promise<void> => {
    if (next === 'clinic') {
      if (
        !window.confirm(
          'Switch this organization to clinic mode?\n\nSync every field device to zero pending records first. The moment the mode flips, devices that have not signed in cannot push.\n\nStaff will sign in with their own accounts, and an admin must approve each account before it can see anything.',
        )
      ) {
        return
      }
      if (
        !window.confirm(
          'Last check before switching to clinic mode.\n\nHas EVERY field device synced to zero pending records? A visit still waiting on a device that never signs in is stranded until an admin switches the mode back to field.',
        )
      ) {
        return
      }
    } else {
      if (
        !window.confirm(
          'Switch this organization back to field mode?\n\nThis reopens the shared-key surface: every device holding the project address and key can read and write records again without signing in. Anyone who ever had the key gets that access back too.',
        )
      ) {
        return
      }
      if (
        !window.confirm(
          'Last check before switching to field mode.\n\nUse this to drain records stranded on field devices, then switch back to clinic mode once they show zero pending. Switch now?',
        )
      ) {
        return
      }
    }
    setBusy('orgmode')
    setMessage(null)
    try {
      await switchOrgMode(next)
      setOrgMode(next)
      setMessage({
        tone: 'ok',
        text:
          next === 'clinic'
            ? 'This organization is now in clinic mode. Devices see the change on their next sync and will ask staff to sign in.'
            : 'This organization is now in field mode. The shared-key surface is open again; field devices can sync on their next connection.',
      })
      onRefresh?.()
    } catch (e) {
      // Server trigger refusals arrive VERBATIM, e.g. 'Only an administrator
      // account can switch this organization to clinic mode.'
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  // ----------------------------------------------------------- backup card

  const doBackup = async (): Promise<void> => {
    setBusy('backup')
    setMessage(null)
    try {
      const n = await downloadBackup()
      setMessage({
        tone: 'ok',
        text: `Backup downloaded with ${n} record${n === 1 ? '' : 's'}. Keep it somewhere safe.`,
      })
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const doRestore = async (file: File): Promise<void> => {
    if (
      !window.confirm(
        `Restore records from "${file.name}"?\n\nRecords in the file are merged into this device. Where the same record exists in both, the more recently saved version is kept, so this cannot undo newer work.`,
      )
    ) {
      return
    }
    // Settings are a SEPARATE, explicit decision. The default (Cancel)
    // restores records only; silently restoring config used to push an old
    // form to the whole org from an admin device.
    const includeConfig = window.confirm(
      "Also restore the settings from this file?\n\nThat replaces this device's form layout, sites, providers and formulary with the ones in the backup. If this is an admin device those settings go out to the whole team on the next sync.\n\nChoose Cancel to restore records only. That is almost always what you want.",
    )
    setBusy('restore')
    setMessage(null)
    try {
      const r = await restoreFromFile(file, { includeConfig })
      setMessage({
        tone: 'ok',
        text:
          `Restored: ${r.added} added, ${r.updated} updated, ${r.skipped} already newer here. ${r.total} records on this device.` +
          (r.configRestored ? ' Settings were restored too.' : ' Settings were left as they are.') +
          (r.added + r.updated > 0 ? ' Restored records will upload on the next sync.' : ''),
      })
      onRefresh?.()
      await refreshInfo()
      if (r.configRestored) await loadConfigState()
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const doImport = async (file: File): Promise<void> => {
    if (
      !window.confirm(
        `Import records from "${file.name}"?\n\nUse this to bring records across from an old cloud project. They are merged into this device: nothing already here is lost, and where the same visit exists in both, the more recently saved version is kept.`,
      )
    ) {
      return
    }
    setBusy('import')
    setMessage(null)
    try {
      const r = await importCloudFile(file)
      const from = r.shape === 'supabase-rows' ? 'cloud export' : 'app backup'
      let text = `Imported from a ${from}: ${r.added} added, ${r.updated} updated, ${r.skipped} already newer here. ${r.total} records on this device.`
      if (r.added + r.updated > 0) text += ' They will upload on the next sync.'
      if (r.rejected.length) {
        text += ` ${r.rejected.length} row${r.rejected.length === 1 ? '' : 's'} could not be read (${[...new Set(r.rejected.map((x) => x.reason))].join(', ')}) and were skipped.`
      }
      setMessage({ tone: r.rejected.length ? 'bad' : 'ok', text })
      onRefresh?.()
      await refreshInfo()
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  // ------------------------------------------------------ clinic list edits

  const saveList = async (def: ListDef): Promise<void> => {
    const list = parseList(drafts[def.key])
    if (!list.length) {
      setMessage({
        tone: 'bad',
        text:
          def.key === 'sites' || def.key === 'providers'
            ? `You need at least one ${def.noun}. An empty list would block every save.`
            : `This list cannot be saved empty. One ${def.noun} per line.`,
      })
      return
    }
    setBusy(`list-${def.key}`)
    setMessage(null)
    try {
      await LIST_WRITERS[def.key](config, list)
      if (def.key === 'sites') setStoredLists((s) => ({ ...s, sites: list }))
      if (def.key === 'providers') setStoredLists((s) => ({ ...s, providers: list }))
      setMessage({
        tone: 'ok',
        text: `Saved ${list.length} ${def.noun}${list.length === 1 ? '' : 's'}. ${def.savedHint ?? 'Reopen the visit form to see them.'}`,
      })
      onRefresh?.()
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const saveFormularyRows = async (): Promise<void> => {
    const cleaned = formularyRows
      .map((r) => ({ ...r, name: r.name.trim() }))
      .filter((r) => r.name)
    if (!cleaned.length) {
      setMessage({ tone: 'bad', text: 'The formulary cannot be saved empty.' })
      return
    }
    setBusy('formulary')
    setMessage(null)
    try {
      await setFormulary(config, cleaned)
      setFormularyRows(cleaned.map((r) => ({ ...r })))
      setMessage({
        tone: 'ok',
        text: `Saved ${cleaned.length} medication${cleaned.length === 1 ? '' : 's'}. Reopen the visit form to see them.`,
      })
      onRefresh?.()
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  const saveLabRows = async (): Promise<void> => {
    const cleaned = labRows.map((t) => ({ ...t, name: t.name.trim() })).filter((t) => t.name)
    if (!cleaned.length) {
      setMessage({ tone: 'bad', text: 'The lab test list cannot be saved empty.' })
      return
    }
    setBusy('labs')
    setMessage(null)
    try {
      await setLabTests(config, cleaned)
      setLabRows(cleaned.map((t) => ({ ...t })))
      setSavedLabIds(new Set(cleaned.map((t) => t.id)))
      setMessage({
        tone: 'ok',
        text: `Saved ${cleaned.length} lab test${cleaned.length === 1 ? '' : 's'}. Reopen the visit form to see them.`,
      })
      onRefresh?.()
    } catch (e) {
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  /**
   * Persist one numeric test's reference ranges (from the RangeEditor).
   * saveTestRanges re-reads the STORED list as its base, so staged table
   * edits are not committed as a side effect and a config pull that landed
   * while the editor was open is honored. The staged row is patched too, so
   * a later "Save lab tests" does not write stale ranges back.
   */
  const saveRangesFor = async (
    test: CustomLabTest,
    ranges: LabRange[],
  ): Promise<SaveRangesResult> => {
    const r = await saveTestRanges(config, test, ranges)
    if (r.ok) {
      setLabRows((rows) => rows.map((t) => (t.id === test.id ? withRanges(t, ranges) : t)))
      setMessage({ tone: 'ok', text: r.message })
      onRefresh?.()
    }
    return r
  }

  // ---------------------------------------------------------------- render

  if (!loaded) {
    return (
      <div className="screen settings">
        <div className="muted">Loading…</div>
      </div>
    )
  }

  const anyBusy = busy !== null
  const projectLabel = creds.url
    ? (creds.url.replace(/^https?:\/\//, '').split('.')[0] ?? creds.url)
    : ''
  // Organization card gating: in clinic mode the admin ACCOUNT decides; in
  // field mode the admin DEVICE does (and the server still requires a
  // signed-in admin account for the actual flip - its refusal shows here).
  const orgAdmin = account ? account.isAdmin : isAdmin
  const orgGateReason = account
    ? 'Only an administrator account can change the organization mode.'
    : GATE_REASON

  return (
    <div className="screen settings">
      {message ? (
        <div
          className={message.tone === 'ok' ? 'alert alert-info' : 'alert alert-bad'}
          role={message.tone === 'ok' ? 'status' : 'alert'}
        >
          {message.text}
        </div>
      ) : null}

      {account ? (
        <section className="card">
          <h3>Account</h3>
          <div className="kv-list">
            <Kv k="Name" v={account.displayName || 'Not set'} />
            <Kv k="Role" v={account.role} />
            <Kv k="Admin" v={account.isAdmin ? 'Yes' : 'No'} />
          </div>
          <p className="muted small">
            Records saved on this device stay here when you sign out - nothing is deleted. But
            signing back in needs a working connection, so do not sign out on a device that is
            offline mid-clinic.
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (
                  window.confirm(
                    'Sign out of this device?\n\nRecords stay safely on the device. Signing back in needs a working internet connection, so avoid this while offline mid-clinic.',
                  )
                ) {
                  void onSignOut?.()
                }
              }}
              disabled={anyBusy}
            >
              Sign out
            </button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3>This device</h3>
        <div className="kv-list">
          <Kv k="Name" v={info.name || 'Not set'} />
          <Kv k="Role" v={info.role === 'admin' ? 'Admin' : 'Standard'} />
          <Kv k="Device ID" v={info.deviceId ? `${info.deviceId.slice(0, 8)}…` : 'Not registered'} mono />
          <Kv k="Mode" v={info.standalone ? 'Offline only' : 'Cloud sync'} />
        </div>
        <p className="muted small">
          Renaming keeps this device's identity: records it has already filed stay its own.
        </p>
        {renameOpen ? (
          <div className="inline-form">
            <label className="field">
              <span className="field-label">Device name</span>
              <input
                className="input"
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                placeholder='For example "iPad 2 - triage"'
              />
            </label>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void doRename(renameValue)
                }}
                disabled={anyBusy || !renameValue.trim()}
              >
                {busy === 'rename' ? 'Saving…' : 'Save name'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRenameOpen(false)}
                disabled={anyBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setRenameValue(info.name || '')
                setRenameOpen(true)
              }}
              disabled={anyBusy}
            >
              Rename this device
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Cloud sync</h3>
        {offlineOnly ? (
          <p className="muted">
            This device is offline only. Records stay here and are never sent anywhere. Take a
            backup regularly so a lost or wiped device does not lose a clinic day.
          </p>
        ) : (
          <>
            <div className="kv-list">
              <Kv k="Project" v={projectLabel} mono />
              <Kv k="Status" v={statusInfo.label} />
              <Kv
                k="Waiting to sync"
                v={pending === 0 ? 'Nothing pending' : `${pending} record${pending === 1 ? '' : 's'}`}
              />
            </div>
            <p className="muted small">{statusInfo.hint}</p>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void doSync()
                }}
                disabled={anyBusy}
              >
                {busy === 'sync' ? 'Syncing…' : 'Sync now'}
              </button>
            </div>
          </>
        )}
        {connectOpen ? (
          <div className="inline-form">
            <label className="field">
              <span className="field-label">Project address (from your admin)</span>
              <input
                className="input"
                type="url"
                value={connUrl}
                onChange={(e) => setConnUrl(e.target.value)}
                placeholder="https://yourproject.supabase.co"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span className="field-label">Project key</span>
              <input
                className="input"
                type="text"
                value={connKey}
                onChange={(e) => setConnKey(e.target.value)}
                placeholder="sb_publishable_..."
                autoComplete="off"
              />
            </label>
            <p className="muted small">
              Use the Publishable key, or the legacy anon key. NEVER a Secret or service_role
              key: those bypass every security rule and this app refuses them.
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void doConnect(connUrl, connKey)
                }}
                disabled={anyBusy || !connUrl.trim() || !connKey.trim()}
              >
                {busy === 'connect' ? 'Checking…' : 'Verify and connect'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setConnectOpen(false)
                  setConnKey('')
                }}
                disabled={anyBusy}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="btn-row">
            <button
              type="button"
              className={offlineOnly ? 'btn' : 'btn btn-ghost'}
              onClick={() => {
                setConnUrl(creds.url || '')
                setConnKey('')
                setConnectOpen(true)
              }}
              disabled={anyBusy}
            >
              {offlineOnly ? 'Connect this device to a cloud' : 'Change cloud project'}
            </button>
          </div>
        )}
      </section>

      {!offlineOnly ? (
        <section className="card">
          <h3>Organization</h3>
          <div className="kv-list">
            <Kv k="Mode" v={orgMode === 'clinic' ? 'Clinic' : 'Field'} />
          </div>
          <p className="muted">
            {orgMode === 'clinic'
              ? 'Clinic mode: every staff member signs in with their own account, an admin approves each account, and visits carry who recorded them.'
              : 'Field mode: devices share the project key and work offline-first. Anyone holding the key can read and write, so the key is the whole fence.'}
          </p>
          {!orgAdmin ? <p className="gate-note">{orgGateReason}</p> : null}
          {orgMode === 'field' ? (
            <p className="muted small">
              Switching to clinic mode needs a signed-in administrator account, and the server
              refuses the switch from anyone else. Sync every field device to zero pending
              records first: the moment the mode flips, devices that have not signed in cannot
              push.
            </p>
          ) : (
            <p className="muted small">
              Switching back to field mode reopens the shared-key surface. It is the recovery
              path when records are stranded on field devices: switch back, let them sync, then
              return to clinic mode.
            </p>
          )}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                void doSwitchMode(orgMode === 'clinic' ? 'field' : 'clinic')
              }}
              disabled={!orgAdmin || anyBusy}
              title={!orgAdmin ? orgGateReason : undefined}
            >
              {busy === 'orgmode'
                ? 'Switching…'
                : orgMode === 'clinic'
                  ? 'Switch to field mode'
                  : 'Switch to clinic mode'}
            </button>
          </div>
        </section>
      ) : null}

      <section className="card">
        <h3>Backup and restore</h3>
        <p className="muted">
          A backup is a single file holding every record on this device plus your form and preset
          settings. It never contains your cloud key or device identity. Take one at the end of
          each clinic day - it is the safety net if a device is lost, wiped, or replaced.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void doBackup()
            }}
            disabled={anyBusy}
          >
            {busy === 'backup' ? 'Preparing…' : 'Download backup'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => restoreRef.current?.click()}
            disabled={anyBusy}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore from a backup'}
          </button>
          {/* Clear the input FIRST: leaving the value set meant cancelling the
              confirmation wedged it, and re-picking the same file did nothing. */}
          <input
            ref={restoreRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.currentTarget.value = ''
              if (f) void doRestore(f)
            }}
          />
        </div>
        <p className="muted small">
          Restoring merges: nothing already on this device is lost, and where the same record
          exists in both the more recently saved version wins.
        </p>
      </section>

      <section className="card">
        <h3>Moving from another cloud project</h3>
        <p className="muted">
          Bringing records across from a project this device is not connected to, for example
          after moving to a new Supabase project. Export the records from the old project as JSON,
          then import the file here. They are merged in and will upload to your current project on
          the next sync.
        </p>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => importRef.current?.click()}
            disabled={anyBusy}
          >
            {busy === 'import' ? 'Importing…' : 'Import records from a file'}
          </button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.currentTarget.value = ''
              if (f) void doImport(f)
            }}
          />
        </div>
        <p className="muted small">
          Export as JSON, not CSV. CSV flattens lab results and medication lists into text and
          they cannot be read back reliably.
        </p>
      </section>

      {onPlaceholders ? (
        <div className="alert alert-bad" role="alert">
          <strong>This device is still filing records under placeholder names.</strong>
          <p>
            Every visit saved here is stamped "{storedLists.sites[0] ?? ''}" /{' '}
            "{storedLists.providers[0] ?? ''}", which is no use in a report. Set your real sites
            and clinicians below before the next clinic.
          </p>
        </div>
      ) : null}

      <section className="card">
        <h3>Clinic lists</h3>
        <p className="muted">
          These fill the pick lists on the visit form: sites, clinicians, complaints, procedures
          and referral destinations. On a cloud device your organization's lists replace these on
          the next sync. One entry per line, and commas belong inside an entry - "Grace N.,
          clinical officer" is one clinician.
        </p>
        {!isAdmin ? (
          <p className="gate-note">
            Editing is turned off: only an admin device can change clinic lists, the formulary or
            lab tests. This device is set to standard.
          </p>
        ) : null}
        {LIST_DEFS.map((def) => (
          <div className="list-editor" key={def.key}>
            <label className="field">
              <span className="field-label">{def.label}</span>
              <textarea
                rows={4}
                value={drafts[def.key]}
                onChange={(e) => setDrafts((d) => ({ ...d, [def.key]: e.target.value }))}
                disabled={!isAdmin}
                title={!isAdmin ? GATE_REASON : undefined}
              />
            </label>
            {def.help ? <p className="muted small">{def.help}</p> : null}
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  void saveList(def)
                }}
                disabled={!isAdmin || anyBusy}
                title={!isAdmin ? GATE_REASON : undefined}
              >
                {busy === `list-${def.key}` ? 'Saving…' : def.saveLabel}
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>Formulary</h3>
        <p className="muted small">
          Medications offered on the visit form. Edit carefully: saved prescriptions keep pointing
          at the same entry, so never reuse a row for a different drug - add a new row instead.
        </p>
        {!isAdmin ? <p className="gate-note">{GATE_REASON}</p> : null}
        <div className="table-scroll">
          <table className="cfg-table">
            <thead>
              <tr>
                <th>Medication</th>
                <th>Dose</th>
                <th>Unit</th>
                <th>Category</th>
                <th>Controlled</th>
                <th>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {formularyRows.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="text"
                      aria-label={`Medication ${i + 1} name`}
                      value={row.name}
                      onChange={(e) =>
                        setFormularyRows((rows) =>
                          rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Medication ${i + 1} dose`}
                      value={row.dose || ''}
                      onChange={(e) =>
                        setFormularyRows((rows) =>
                          rows.map((r) => (r.id === row.id ? { ...r, dose: e.target.value } : r)),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Medication ${i + 1} unit`}
                      value={row.unit || ''}
                      onChange={(e) =>
                        setFormularyRows((rows) =>
                          rows.map((r) => (r.id === row.id ? { ...r, unit: e.target.value } : r)),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Medication ${i + 1} category`}
                      value={row.category || ''}
                      onChange={(e) =>
                        setFormularyRows((rows) =>
                          rows.map((r) =>
                            r.id === row.id ? { ...r, category: e.target.value } : r,
                          ),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td className="cfg-check">
                    <input
                      type="checkbox"
                      aria-label={`Medication ${i + 1} controlled`}
                      checked={!!row.controlled}
                      onChange={(e) =>
                        setFormularyRows((rows) =>
                          rows.map((r) =>
                            r.id === row.id ? { ...r, controlled: e.target.checked } : r,
                          ),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() =>
                        setFormularyRows((rows) => rows.filter((r) => r.id !== row.id))
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              setFormularyRows((rows) => [
                ...rows,
                { id: newConfigId('med'), name: '', dose: '', unit: '', category: '', controlled: false },
              ])
            }
            disabled={!isAdmin}
            title={!isAdmin ? GATE_REASON : undefined}
          >
            Add medication
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void saveFormularyRows()
            }}
            disabled={!isAdmin || anyBusy}
            title={!isAdmin ? GATE_REASON : undefined}
          >
            {busy === 'formulary' ? 'Saving…' : 'Save formulary'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Lab tests</h3>
        <p className="muted small">
          Lab tests offered on the visit form. Saving replaces the whole panel for your
          organization. On a numeric test, Ranges sets the bands that interpret a value as it is
          entered; changing them affects new results only, and visits already saved keep the
          interpretation recorded at the time.
        </p>
        {!isAdmin ? <p className="gate-note">{GATE_REASON}</p> : null}
        <div className="table-scroll">
          <table className="cfg-table">
            <thead>
              <tr>
                <th>Test</th>
                <th>Type</th>
                <th>Unit</th>
                <th>On by default</th>
                <th>Ranges</th>
                <th>
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {labRows.map((row, i) => (
                <tr key={row.id}>
                  <td>
                    <input
                      type="text"
                      aria-label={`Lab test ${i + 1} name`}
                      value={row.name}
                      onChange={(e) =>
                        setLabRows((rows) =>
                          rows.map((r) => (r.id === row.id ? { ...r, name: e.target.value } : r)),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td>
                    <select
                      aria-label={`Lab test ${i + 1} type`}
                      value={row.type}
                      onChange={(e) =>
                        setLabRows((rows) =>
                          rows.map((r) =>
                            r.id === row.id
                              ? { ...r, type: e.target.value === 'numeric' ? 'numeric' : 'toggle' }
                              : r,
                          ),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    >
                      <option value="toggle">Positive / negative</option>
                      <option value="numeric">Number</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="text"
                      aria-label={`Lab test ${i + 1} unit`}
                      value={row.unit || ''}
                      onChange={(e) =>
                        setLabRows((rows) =>
                          rows.map((r) => (r.id === row.id ? { ...r, unit: e.target.value } : r)),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td className="cfg-check">
                    <input
                      type="checkbox"
                      aria-label={`Lab test ${i + 1} on by default`}
                      checked={!!row.enabledByDefault}
                      onChange={(e) =>
                        setLabRows((rows) =>
                          rows.map((r) =>
                            r.id === row.id ? { ...r, enabledByDefault: e.target.checked } : r,
                          ),
                        )
                      }
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    />
                  </td>
                  <td>
                    {row.type === 'numeric' ? (
                      // Opens read-only on a standard device (like the template
                      // editor); disabled only while the row itself is not in
                      // the persisted list yet, with the reason on the control.
                      <button
                        type="button"
                        className="btn btn-ghost"
                        aria-label={`Lab test ${i + 1} reference ranges`}
                        onClick={() => setRangeTest(row)}
                        disabled={!savedLabIds.has(row.id)}
                        title={!savedLabIds.has(row.id) ? UNSAVED_TEST_REASON : undefined}
                      >
                        Ranges{row.ranges?.length ? ` (${row.ranges.length})` : ''}
                      </button>
                    ) : null}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => setLabRows((rows) => rows.filter((r) => r.id !== row.id))}
                      disabled={!isAdmin}
                      title={!isAdmin ? GATE_REASON : undefined}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              setLabRows((rows) => [
                ...rows,
                { id: newConfigId('lab'), name: '', type: 'toggle', enabledByDefault: true },
              ])
            }
            disabled={!isAdmin}
            title={!isAdmin ? GATE_REASON : undefined}
          >
            Add lab test
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void saveLabRows()
            }}
            disabled={!isAdmin || anyBusy}
            title={!isAdmin ? GATE_REASON : undefined}
          >
            {busy === 'labs' ? 'Saving…' : 'Save lab tests'}
          </button>
        </div>
      </section>

      {rangeTest ? (
        <RangeEditor
          test={rangeTest}
          isAdmin={isAdmin}
          onClose={() => setRangeTest(null)}
          onSave={(ranges) => saveRangesFor(rangeTest, ranges)}
        />
      ) : null}

      {/* Diagnosis quick-picks and prescription presets (src/ui/presets). */}
      <PresetEditors isAdmin={isAdmin} onRefresh={onRefresh} />

      <section className="card">
        <h3>Form templates</h3>
        <p className="muted">
          The visit form itself: which forms your organization offers, their sections, and your
          own questions. These belong to your organization; a change reaches everyone on the next
          sync.
        </p>
        <ul className="template-list">
          {templates.map((t) => (
            <li key={t.id}>
              <span>{t.name}</span>
              <span className="muted small">{t.enabled === false ? 'Off' : 'On'}</span>
            </li>
          ))}
        </ul>
        {!isAdmin ? (
          <p className="gate-note">
            The editor opens read-only: only an admin device can change form templates. This
            device is set to standard.
          </p>
        ) : null}
        <div className="btn-row">
          <button
            type="button"
            className="btn"
            onClick={() => setTemplateBuilderOpen(true)}
            disabled={anyBusy}
          >
            Open the template editor
          </button>
        </div>
      </section>

      {templateBuilderOpen ? (
        <TemplateBuilder
          isAdmin={isAdmin}
          onClose={() => setTemplateBuilderOpen(false)}
          onChanged={() => {
            // Keep the read-only list above in step with the builder's saves.
            void loadLibrary(config).then((lib) => setTemplates(lib.templates))
            onRefresh?.()
          }}
        />
      ) : null}

      <section className="card">
        <h3>Moving to a new device</h3>
        <ol className="steps">
          <li>
            On the old device, tap <strong>Download backup</strong> and save the file somewhere
            you can reach it.
          </li>
          <li>
            On the new device, open the app and connect it to the same cloud project (or choose
            offline only).
          </li>
          <li>
            Tap <strong>Restore from a backup</strong> and pick the file.
          </li>
          <li>Check the record count matches before wiping the old device.</li>
        </ol>
      </section>

      <section className="card">
        <h3>About</h3>
        <div className="kv-list">
          <Kv k="App" v="DH EMR" />
          <Kv k="Version" v={APP_VERSION} />
        </div>
        <p className="muted small">
          DH EMR is an offline-first documentation tool for outreach clinics. It is not a
          certified EHR and is not HIPAA-compliant, and it must not be used where a certified
          EHR is required. It is intended for global-health use outside the US.
        </p>
      </section>
    </div>
  )
}
