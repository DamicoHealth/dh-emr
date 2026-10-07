/**
 * Field shell boot gate.
 *
 * This case used to live in tests/setupWizard.test.ts (now in
 * packages/core/tests, where it exercises the SetupWizard component alone).
 * It asserts a boot-gate invariant of the APP SHELL, not of the wizard:
 * the setupComplete flag ALONE decides first-run, and a leftover device id
 * must NOT bypass the wizard (a legacy install, or a crash between device
 * registration and the final setupComplete write, otherwise boots into the
 * app with unverified credentials and placeholder clinic lists).
 *
 * The Clinic shell needs the same gate and carries its own copy whose
 * expectations match that shell's first-run flow.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { resetStorage } from '../../core/tests/setup'

// The App import pulls in every tab screen; mock the heavy ones so this
// suite only exercises the boot gate, deterministically.
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
import { config, setCurrentDeviceId, setSetting, settings } from '@dh/core/kernel'
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

describe('app boot gate', () => {
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
