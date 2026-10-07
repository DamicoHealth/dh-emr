/**
 * First-run setup wizard. Mandatory: the shell gates on the setupComplete
 * flag ALONE, so a leftover device id never bypasses this screen.
 *
 * Shared by both products through the REQUIRED `product` prop: DH EMR
 * Field offers cloud sync or this device on its own; DH EMR Clinic is
 * always cloud, so it starts on the cloud step and never shows the
 * standalone option (a Clinic device without a project is not set up).
 *
 * Deliberate choices, each one a shipped bug in the previous app:
 *  - In Field, offline only is a FIRST-CLASS EQUAL option, not a fallback.
 *    Most outreach devices never get a cloud project.
 *  - The cloud step VERIFIES the project tables before the key is accepted
 *    (via the sync engine), and credentials are never stored before
 *    verification. A URL typo used to surface days later as "nothing ever
 *    synced".
 *  - Server keys (service_role / sb_secret_) are rejected at the door with
 *    the exact classifySupabaseKey copy.
 *  - EVERY device collects sites and providers, cloud included: on a brand
 *    new project the config table is empty and the device would otherwise
 *    fall back to the "Site A" / "Physician A" placeholders.
 *  - The wizard REFUSES to finish with an empty sites or providers list:
 *    an empty list pinned to config blocks every save.
 *  - setupComplete is written LAST, after registration and lists, so a crash
 *    mid-finish re-runs the wizard instead of booting half-configured.
 */
import { useEffect, useState } from 'react'
import { config, setSetting } from '../../kernel'
import { parseList, setProviders, setSites } from '../../config/keys'
import {
  classifySupabaseKey,
  normalizeSupabaseUrl,
  registerDeviceWithRole,
  syncEngine,
  type DeviceRole,
} from '../../sync'
import './setup.css'

/** Which product is running the wizard. See SetupWizardProps.product. */
export type SetupProduct = 'field' | 'clinic'

export interface SetupWizardProps {
  /**
   * REQUIRED, no default: the two products are separate apps over this one
   * wizard and must say which they are. 'field' opens on the choice between
   * cloud sync and this device on its own; 'clinic' opens on the cloud step
   * and never offers the standalone option.
   */
  product: SetupProduct
  onDone: () => void
  /**
   * Clinic only: why a join link this device was opened with could not be
   * used (src/sync/joinLink.ts). Shown in the wizard's alert slot, so the
   * person reads the reason instead of a silent fall back to typing.
   */
  joinError?: string | null
}

/** Wizard steps. 'lists' collects the sites and clinicians (every device). */
type Step = 'choose' | 'cloud' | 'naming' | 'lists'

const NAME_ERROR = 'Give this device a name so it can be told apart from the others.'
const EMPTY_SITES_ERROR = 'You need at least one site. An empty list would block every save.'
const EMPTY_PROVIDERS_ERROR =
  'You need at least one clinician. An empty list would block every save.'

export default function SetupWizard({ product, onDone, joinError }: SetupWizardProps) {
  const cloudOnly = product === 'clinic'
  const [mode, setMode] = useState<Step>(cloudOnly ? 'cloud' : 'choose')
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [role, setRole] = useState<DeviceRole>('standard')
  const [standalone, setStandalone] = useState(false)
  const [sitesText, setSitesText] = useState('')
  const [providersText, setProvidersText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(joinError ?? null)

  // A join-link verdict that arrives after mount still lands in the slot.
  useEffect(() => {
    if (joinError) setError(joinError)
  }, [joinError])

  const checkCloud = async (): Promise<void> => {
    // Order is contract: URL shape -> empty key -> server key -> live verify.
    const norm = normalizeSupabaseUrl(url)
    if (!norm.ok) {
      setError(norm.error)
      return
    }
    const cls = classifySupabaseKey(key)
    if (!cls.ok) {
      setError(cls.error)
      return
    }
    const cleanKey = key.trim()
    setBusy(true)
    setError(null)
    try {
      const res = await syncEngine.verifyTables(norm.url, cleanKey)
      if (!res.ok) {
        setError(
          res.error
            ? `Could not reach the project tables: ${res.error}`
            : 'Connected, but the records table was not found. Run the setup SQL on this Supabase project first.',
        )
        return
      }
      // Verified. Held in state only - nothing is stored until finish()
      // runs connectToProject, so credentials are never persisted before
      // the final verification.
      setUrl(norm.url)
      setKey(cleanKey)
      setStandalone(false)
      setMode('naming')
    } catch (e) {
      setError(
        `Could not reach that project. Check the device is online and the URL is right. (${e instanceof Error ? e.message : String(e)})`,
      )
    } finally {
      setBusy(false)
    }
  }

  const toLists = (): void => {
    if (!deviceName.trim()) {
      setError(NAME_ERROR)
      return
    }
    setError(null)
    setMode('lists')
  }

  const finish = async (sites: string[], providers: string[]): Promise<void> => {
    const name = deviceName.trim()
    if (!name) {
      setError(NAME_ERROR)
      return
    }
    // Refuse BEFORE any write: a half-finished device must re-run the wizard
    // clean, and an empty list pinned to config would block every save.
    if (!sites.length) {
      setError(EMPTY_SITES_ERROR)
      return
    }
    if (!providers.length) {
      setError(EMPTY_PROVIDERS_ERROR)
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (standalone) {
        await setSetting('standaloneMode', 'true')
        await setSetting('deviceName', name)
        await registerDeviceWithRole(name, role)
      } else {
        // Verify again, store credentials, set standaloneMode 'false' and
        // register this device in the project - the project's security rules
        // only accept records from a device its fleet table knows.
        const res = await syncEngine.connectToProject(url, key, name, role)
        if (!res.ok) {
          setError(
            `Could not finish setup: ${res.error || 'the project could not be verified.'}`,
          )
          return
        }
      }
      await setSites(config, sites)
      await setProviders(config, providers)
      // LAST: only a fully set-up device is allowed past the boot gate.
      await setSetting('setupComplete', 'true')
      onDone()
    } catch (e) {
      setError(`Could not finish setup: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setup">
      <div className="setup-card">
        <div className="setup-brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          {/* The product's own name, same as its top bar and manifest. */}
          <span>{cloudOnly ? 'DH EMR Clinic' : 'DH EMR Field'}</span>
        </div>

        {error ? (
          <div className="alert alert-bad" role="alert">
            {error}
          </div>
        ) : null}

        {mode === 'choose' ? (
          <>
            <h2>Set up this device</h2>
            <p className="muted">
              This takes about a minute and only happens once. You can change any of it later
              under Settings.
            </p>
            <button
              type="button"
              className="btn setup-choice"
              onClick={() => {
                setError(null)
                setMode('cloud')
              }}
            >
              <strong>Connect to our clinic cloud</strong>
              <span>
                Records sync between every device on the team. Needs the project address and key
                from your admin.
              </span>
            </button>
            <button
              type="button"
              className="btn btn-ghost setup-choice"
              onClick={() => {
                setError(null)
                setStandalone(true)
                setMode('naming')
              }}
            >
              <strong>Use this device on its own</strong>
              <span>
                Records stay on this device and are never sent anywhere. Take a backup at the end
                of each clinic day.
              </span>
            </button>
          </>
        ) : null}

        {mode === 'cloud' ? (
          <>
            <h2>Connect to your cloud</h2>
            {cloudOnly ? (
              <>
                {/* Clinic: the join link is the normal path; typing is the
                    fallback for a device that cannot open the link. */}
                <div className="alert" role="note">
                  <strong>Open the link your admin sent you</strong>
                  <p className="muted">
                    Your admin's Staff screen has an invite link and a QR code. Open the link
                    on this device, or scan the code with this device's camera, and the app
                    sets itself up and brings you to sign-in. Nothing to type.
                  </p>
                </div>
                <p className="muted">
                  No link? Your admin can read you the project address and key instead. Both
                  come from the Supabase project, under Settings then API Keys.
                </p>
              </>
            ) : (
              <p className="muted">
                Your admin gets both of these from the Supabase project, under Settings then API
                Keys.
              </p>
            )}
            <label className="field">
              <span className="field-label">Project URL</span>
              <input
                type="url"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="https://yourproject.supabase.co"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">Project key</span>
              <textarea
                rows={3}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="sb_publishable_... or the long legacy anon key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <p className="muted small">
              Use the <strong>Publishable</strong> key, or the legacy <strong>anon</strong> key.
              Never a <strong>Secret</strong> or <strong>service_role</strong> key: those bypass
              every database security rule and must not leave the office.
            </p>
            <div className="btn-row">
              {/* Clinic starts here; there is no earlier step to go back to. */}
              {cloudOnly ? null : (
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => {
                    setError(null)
                    setMode('choose')
                  }}
                  disabled={busy}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void checkCloud()
                }}
                disabled={busy}
              >
                {busy ? 'Checking…' : 'Check and continue'}
              </button>
            </div>
          </>
        ) : null}

        {mode === 'naming' ? (
          <>
            <h2>Name this device</h2>
            <p className="muted">
              The name shows up in your device list and on the records this device files, so make
              it something you can recognise: "iPad 2 - triage", "Grace's tablet".
            </p>
            <label className="field">
              <span className="field-label">Device name</span>
              <input
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                placeholder="iPad 2 - triage"
              />
            </label>
            <label className="field">
              <span className="field-label">What is this device allowed to do?</span>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'standard')}
              >
                <option value="standard">Enter and view records (most devices)</option>
                <option value="admin">Also change the form and clinic settings for everyone</option>
              </select>
            </label>
            <p className="muted small">
              {standalone
                ? 'This device is offline only. Nothing it records leaves the device.'
                : 'This device is connected to your cloud. Records sync automatically.'}
            </p>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setError(null)
                  setMode(standalone ? 'choose' : 'cloud')
                }}
                disabled={busy}
              >
                Back
              </button>
              <button type="button" className="btn" onClick={toLists} disabled={busy}>
                {busy ? 'Finishing…' : 'Next'}
              </button>
            </div>
          </>
        ) : null}

        {mode === 'lists' ? (
          <>
            <h2>Where is this device working?</h2>
            <p className="muted">
              These fill the Site and Provider lists on the visit form. Without them every record
              is filed under the placeholder "Site A", which is no use in a report. One per line,
              and you can change them later under Settings.
              {standalone
                ? ''
                : ' If your organization has already set these up in the cloud, its list replaces these on the first sync.'}
            </p>
            <p className="muted small">
              Both lists are needed to finish: a device with an empty list cannot save a visit.
              Commas belong inside an entry - "Grace N., clinical officer" is one clinician.
            </p>
            <label className="field">
              <span className="field-label">Clinic or site names</span>
              <textarea
                rows={3}
                value={sitesText}
                onChange={(e) => setSitesText(e.target.value)}
                placeholder={'Kabale Community Clinic\nMobile Unit A'}
              />
            </label>
            <label className="field">
              <span className="field-label">Clinicians working on this device</span>
              <textarea
                rows={3}
                value={providersText}
                onChange={(e) => setProvidersText(e.target.value)}
                placeholder={'Dr. A. Mensah\nGrace N., clinical officer'}
              />
            </label>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setError(null)
                  setMode('naming')
                }}
                disabled={busy}
              >
                Back
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  void finish(parseList(sitesText), parseList(providersText))
                }}
                disabled={busy}
              >
                {busy ? 'Finishing…' : 'Start using the app'}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
