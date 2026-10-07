/**
 * DH EMR Clinic shell boot gate.
 *
 * The Clinic product is always cloud and always behind the account gate.
 * These cases pin the shell's first-run and no-credentials behavior:
 *  - the setupComplete flag ALONE decides first-run: a leftover device id
 *    (legacy install, or a crash between device registration and the final
 *    setupComplete write) must NOT bypass the wizard;
 *  - the Clinic wizard opens on the cloud step and never offers "Use this
 *    device on its own" - a Clinic device without a project is not set up;
 *  - a device marked set up that holds no cloud credentials lands back on
 *    the wizard's cloud step, never in a field-shaped shell;
 *  - with credentials and no session, the sign-in screen shows: the gate
 *    applies without any orgMode check, because a Clinic org IS clinic mode.
 *
 * Shared modules come in through the @dh/core alias; the storage harness is
 * core's tests/setup.ts (vite.config.ts setupFiles), never duplicated here.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { resetStorage } from '../../core/tests/setup'

// The App import pulls in every tab screen; mock the heavy ones so this
// suite only exercises the boot and account gates, deterministically.
vi.mock('@dh/core/ui/encounter/EncounterForm', () => ({
  __esModule: true,
  default: () => null,
  EncounterForm: () => null,
}))
vi.mock('@dh/core/ui/records/RecordsScreen', () => ({
  __esModule: true,
  default: () => null,
  RecordsScreen: () => null,
}))
vi.mock('@dh/core/ui/board/BoardScreen', () => ({
  __esModule: true,
  default: () => null,
}))
import { config, setCurrentDeviceId, setSetting, settings } from '@dh/core/kernel'
import { syncEngine } from '@dh/core/sync'
// The worker registration is a side effect of mounting the shell; the
// tests only need to know it was asked for.
vi.mock('@dh/core/sw/register', () => ({
  startServiceWorker: vi.fn(),
  applyUpdateNow: vi.fn(async () => {}),
}))
import { App } from '../src/App'
import { startServiceWorker } from '@dh/core/sw/register'

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
  'authProfile',
]

beforeEach(async () => {
  await resetStorage()
  for (const k of SETTING_KEYS) await settings.remove(k)
  await config.remove('sites')
  await config.remove('providers')
  await config.remove('orgMode')
  setCurrentDeviceId(null)
  // The engine's in-memory credentials outlive a settings wipe; every case
  // starts with none, exactly like a fresh install.
  syncEngine.updateCredentials(null, null)
})

afterEach(() => {
  cleanup()
})

function expectWizardCloudStep(): void {
  // The Clinic wizard: cloud step only, no choice screen, no standalone.
  expect(screen.queryByText('Set up this device')).toBeNull()
  expect(screen.queryByText('Use this device on its own')).toBeNull()
  // The main shell did not boot.
  expect(screen.queryByRole('button', { name: 'New visit' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
}

describe('clinic shell boot gate', () => {
  it('a leftover device id does NOT bypass the setupComplete gate', async () => {
    await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
    await setSetting('deviceName', 'Legacy iPad')

    render(h(App))

    await screen.findByText('Connect to your cloud')
    expectWizardCloudStep()
  })

  it('a set-up device without cloud credentials lands on the cloud step, never a field shell', async () => {
    await setSetting('setupComplete', 'true')
    await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
    await setSetting('deviceName', 'Clinic iPad')

    render(h(App))

    await screen.findByText('Connect to your cloud')
    expectWizardCloudStep()
    expect(screen.queryByText('Visits')).toBeNull()
  })

  it('with credentials and no session the account gate shows sign-in, without any orgMode check', async () => {
    await setSetting('setupComplete', 'true')
    await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
    await setSetting('deviceName', 'Clinic iPad')
    await setSetting('supabaseUrl', 'https://myproject.supabase.co')
    await setSetting('supabaseKey', 'sb_publishable_test_key_000')
    syncEngine.updateCredentials('https://myproject.supabase.co', 'sb_publishable_test_key_000')
    // No orgMode row at all (absent reads as field in the shared parser):
    // the Clinic gate must still apply.

    render(h(App))

    await screen.findByRole('heading', { name: 'Sign in' })
    expect(screen.queryByText('Connect to your cloud')).toBeNull()
    expect(screen.queryByRole('button', { name: 'New visit' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
  })

  it('the service worker registers on a fresh device at the cloud step, before any sign-in', async () => {
    vi.mocked(startServiceWorker).mockClear()
    render(h(App))
    await screen.findByText('Connect to your cloud')
    // UpdateBar (the active shell's own registration path) is not mounted here.
    expect(startServiceWorker).toHaveBeenCalled()
  })
})
