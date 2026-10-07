/**
 * Setup wizard invariants, each one a shipped bug in the previous app:
 *  - the wizard refuses to finish while the sites or providers list is empty
 *    (an empty list pinned to config blocks every save);
 *  - the offline path stores standaloneMode and setupComplete, registers a
 *    device identity, and keeps commas INSIDE entries;
 *  - the cloud path rejects a server key with the exact SERVER_KEY_ERROR
 *    copy and never stores credentials.
 *
 * The shell-level boot-gate case ("a leftover device id does NOT bypass the
 * setupComplete gate") renders the App shell, which lives in the app
 * packages, not in core; it moved out with the shell (see the field shell's
 * appBootGate test).
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, getSetting, setCurrentDeviceId, settings } from '../src/kernel'
import { SERVER_KEY_ERROR } from '../src/sync'
import SetupWizard from '../src/ui/setup/SetupWizard'

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

function renderWizard(product: 'field' | 'clinic' = 'field'): ReturnType<typeof vi.fn> {
  const onDone = vi.fn()
  render(h(SetupWizard, { product, onDone }))
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
    // The Field product's own name, never a bare "DH EMR".
    expect(screen.getByText('DH EMR Field')).toBeTruthy()
    expect(screen.queryByText('DH EMR')).toBeNull()
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

  it('the Clinic product opens on the cloud step and never offers the standalone option', async () => {
    const onDone = renderWizard('clinic')
    // Straight to the cloud step: no choice screen, no "on its own", and no
    // Back button to an earlier step that does not exist for Clinic.
    await screen.findByText('Connect to your cloud')
    expect(screen.queryByText('Set up this device')).toBeNull()
    expect(screen.queryByText('Use this device on its own')).toBeNull()
    expect(screen.queryByText('Back')).toBeNull()
    expect(screen.getByText('Check and continue')).toBeTruthy()
    // Branded as the Clinic product, like its top bar and About card.
    expect(screen.getByText('DH EMR Clinic')).toBeTruthy()
    expect(screen.queryByText('DH EMR Field')).toBeNull()

    // The server-key refusal is identical in Clinic, and stores nothing.
    fireEvent.change(screen.getByLabelText('Project URL'), {
      target: { value: 'https://myproject.supabase.co' },
    })
    fireEvent.change(screen.getByLabelText('Project key'), {
      target: { value: 'sb_secret_abc123def456' },
    })
    fireEvent.click(screen.getByText('Check and continue'))
    await screen.findByText(SERVER_KEY_ERROR)
    expect(onDone).not.toHaveBeenCalled()
    expect(await getSetting('supabaseUrl')).toBeNull()
    expect(await getSetting('supabaseKey')).toBeNull()
    expect(await getSetting('standaloneMode')).toBeNull()
  })
})
