/**
 * Setup wizard invariants, each one a shipped bug in the previous app:
 *  - the wizard refuses to finish while the sites or providers list is empty
 *    (an empty list pinned to config blocks every save);
 *  - the offline path stores standaloneMode and setupComplete, registers a
 *    device identity, and keeps commas INSIDE entries;
 *  - the cloud path rejects a server key with the exact SERVER_KEY_ERROR
 *    copy and never stores credentials;
 *  - a leftover device id does NOT bypass the setupComplete boot gate.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetStorage } from './setup'

// The App import pulls in every tab screen. The records and encounter
// modules belong to other owners and are built in parallel; mock them so
// this suite only exercises the setup gate and wizard, deterministically.
vi.mock('../src/ui/encounter/EncounterForm', () => ({
  __esModule: true,
  default: () => null,
  EncounterForm: () => null,
}))
vi.mock('../src/ui/records/RecordsScreen', () => ({
  __esModule: true,
  default: () => null,
  RecordsScreen: () => null,
}))
import { config, getSetting, setCurrentDeviceId, setSetting, settings } from '../src/kernel'
import { SERVER_KEY_ERROR } from '../src/sync'
import SetupWizard from '../src/ui/setup/SetupWizard'
import { App } from '../src/App'

const h = React.createElement

/** Settings the wizard (or a legacy install) may write; cleared between tests. */
const SETTING_KEYS = [
  'setupComplete',
  'standaloneMode',
  'deviceName',
  'deviceId',
  'deviceRole',
  'supabaseUrl',
  'supabaseKey',
]

beforeEach(async () => {
  await resetStorage()
  for (const k of SETTING_KEYS) await settings.remove(k)
  await config.remove('sites')
  await config.remove('providers')
  setCurrentDeviceId(null)
})

afterEach(() => {
  cleanup()
})

function renderWizard(): ReturnType<typeof vi.fn> {
  const onDone = vi.fn()
  render(h(SetupWizard, { onDone }))
  return onDone
}

/** Walk the offline path up to the clinic-lists step. */
async function goOfflineToClinic(name: string): Promise<void> {
  fireEvent.click(screen.getByText('Use this device on its own'))
  await screen.findByText('Name this device')
  fireEvent.change(screen.getByLabelText('Device name'), { target: { value: name } })
  fireEvent.click(screen.getByText('Next'))
  await screen.findByText('Where is this device working?')
}

describe('setup wizard', () => {
  it('refuses to finish while sites or providers are empty, writing nothing', async () => {
    const onDone = renderWizard()
    await goOfflineToClinic('iPad 2 - triage')

    // Both lists empty: refused on sites first.
    fireEvent.click(screen.getByText('Start using the app'))
    await screen.findByText('You need at least one site. An empty list would block every save.')

    // Sites filled, providers still empty: refused on providers.
    fireEvent.change(screen.getByLabelText('Clinic or site names'), {
      target: { value: 'Kabale Community Clinic' },
    })
    fireEvent.click(screen.getByText('Start using the app'))
    await screen.findByText(
      'You need at least one clinician. An empty list would block every save.',
    )

    // The refusal happens BEFORE any write: nothing was stored.
    expect(onDone).not.toHaveBeenCalled()
    expect(await getSetting('setupComplete')).toBeNull()
    expect(await getSetting('standaloneMode')).toBeNull()
    expect(await getSetting('deviceId')).toBeNull()
    expect(await config.get('sites')).toBeNull()
    expect(await config.get('providers')).toBeNull()
  })

  it('offline path registers the device, writes the lists, and sets standaloneMode and setupComplete', async () => {
    const onDone = renderWizard()
    await goOfflineToClinic('iPad 2 - triage')

    fireEvent.change(screen.getByLabelText('Clinic or site names'), {
      target: { value: 'Kabale Community Clinic\nMobile Unit A\n' },
    })
    // The comma stays INSIDE the entry: one clinician per line, never split.
    fireEvent.change(screen.getByLabelText('Clinicians working on this device'), {
      target: { value: 'Dr. A. Mensah\nGrace N., clinical officer' },
    })
    fireEvent.click(screen.getByText('Start using the app'))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))

    expect(await getSetting<string>('standaloneMode')).toBe('true')
    expect(await getSetting<string>('setupComplete')).toBe('true')
    expect(await getSetting<string>('deviceName')).toBe('iPad 2 - triage')
    // A real minted identity, not a legacy shared id.
    const deviceId = await getSetting<string>('deviceId')
    expect(deviceId).toBeTruthy()
    expect(deviceId).not.toBe('pwa-device-001')
    // Lists written through the config keys, de-duped and trimmed.
    expect(await config.get<string[]>('sites')).toEqual([
      'Kabale Community Clinic',
      'Mobile Unit A',
    ])
    expect(await config.get<string[]>('providers')).toEqual([
      'Dr. A. Mensah',
      'Grace N., clinical officer',
    ])
    // Offline only: no credentials were stored.
    expect(await getSetting('supabaseUrl')).toBeNull()
    expect(await getSetting('supabaseKey')).toBeNull()
  })

  it('cloud path refuses a server key with the exact SERVER_KEY_ERROR copy and stores nothing', async () => {
    const onDone = renderWizard()
    fireEvent.click(screen.getByText('Connect to our clinic cloud'))
    await screen.findByText('Connect to your cloud')

    fireEvent.change(screen.getByLabelText('Project URL'), {
      target: { value: 'https://myproject.supabase.co' },
    })
    fireEvent.change(screen.getByLabelText('Project key'), {
      target: { value: 'eyJhbGciOiJIUzI1NiJ9.role-service_role.signature' },
    })
    fireEvent.click(screen.getByText('Check and continue'))

    // Exact rejection copy, shown inline. No network call is involved.
    await screen.findByText(SERVER_KEY_ERROR)

    // The wizard did not advance, and no credentials were persisted.
    expect(screen.getByText('Check and continue')).toBeTruthy()
    expect(onDone).not.toHaveBeenCalled()
    expect(await getSetting('supabaseUrl')).toBeNull()
    expect(await getSetting('supabaseKey')).toBeNull()

    // sb_secret_ keys are refused the same way.
    fireEvent.change(screen.getByLabelText('Project key'), {
      target: { value: 'sb_secret_abc123def456' },
    })
    fireEvent.click(screen.getByText('Check and continue'))
    await screen.findByText(SERVER_KEY_ERROR)
    expect(await getSetting('supabaseKey')).toBeNull()
  })

  it('a leftover device id does NOT bypass the setupComplete gate', async () => {
    // A legacy install (or a crash between device registration and the final
    // setupComplete write) leaves a device id behind with no setupComplete.
    await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
    await setSetting('deviceName', 'Legacy iPad')

    render(h(App))

    // The wizard shows; the main shell does not boot.
    await screen.findByText('Set up this device')
    expect(screen.queryByRole('button', { name: 'New visit' })).toBeNull()
    expect(screen.queryByText('Visits')).toBeNull()
  })
})
