/**
 * DH EMR Clinic shell: config push follows the ACCOUNT.
 *
 * The shell installs the engine's config-push policy from the account gate
 * (core/sync engine, setConfigPushPolicy): an admin account pushes the
 * org's lists, formulary and templates even from a standard device (every
 * link-joined device is standard by design), a non-admin account never
 * pushes even when the device row says admin, and leaving the shell restores
 * the engine's default. Without this an admin's Settings edits on a
 * link-joined device would stay local forever while the screen said saved.
 *
 * Same mocks as roleWorkspaces.test.ts: the auth layer with a controllable
 * admin flag, the sync singletons neutered, the heavy screens stubbed.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { resetStorage } from '../../core/tests/setup'

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
  default: () => React.createElement('div', null, 'BOARD STUB'),
}))

const authState = vi.hoisted(() => ({
  role: 'reception',
  isAdmin: false,
}))
vi.mock('@dh/core/auth', () => ({
  loadCurrentProfile: async () => ({
    state: 'active',
    profile: {
      userId: 'u1',
      displayName: 'Grace',
      role: authState.role,
      isAdmin: authState.isAdmin,
      confirmedAt: new Date().toISOString(),
    },
    fromCache: false,
    stale: false,
  }),
  authSession: {
    onAuthChange: () => () => {},
    signOut: async () => {},
    getAccessToken: () => 'tok',
    getSession: async () => null,
    init: async () => {},
  },
  getOrgMode: async () => 'clinic',
}))

import { setCurrentDeviceId, setSetting, settings } from '@dh/core/kernel'
import { realtimeTrigger, syncEngine, type ConfigPushPolicy } from '@dh/core/sync'
import { App } from '../src/App'

const h = React.createElement

const SETTING_KEYS = [
  'setupComplete',
  'deviceName',
  'deviceId',
  'deviceRole',
  'supabaseUrl',
  'supabaseKey',
  'authProfile',
]

let installed: (ConfigPushPolicy | null)[] = []

beforeEach(async () => {
  await resetStorage()
  for (const k of SETTING_KEYS) await settings.remove(k)
  await setSetting('setupComplete', 'true')
  await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
  await setSetting('deviceName', 'Clinic iPad')
  await setSetting('supabaseUrl', 'https://myproject.supabase.co')
  await setSetting('supabaseKey', 'sb_publishable_test_key_000')
  setCurrentDeviceId('b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
  syncEngine.updateCredentials('https://myproject.supabase.co', 'sb_publishable_test_key_000')
  authState.role = 'reception'
  authState.isAdmin = false
  installed = []
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(syncEngine, 'startAutoSync').mockImplementation(() => {})
  vi.spyOn(syncEngine, 'stopAutoSync').mockImplementation(() => {})
  vi.spyOn(syncEngine, 'setConfigPushPolicy').mockImplementation((p) => {
    installed.push(p)
  })
  vi.spyOn(realtimeTrigger, 'start').mockImplementation(() => {})
  vi.spyOn(realtimeTrigger, 'stop').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  syncEngine.updateCredentials(null, null)
})

/** The policy the shell installed (the last non-null one). */
function policy(): ConfigPushPolicy {
  const p = [...installed].reverse().find((x) => x !== null)
  if (!p) throw new Error('the shell installed no config push policy')
  return p
}

describe('config push follows the account', () => {
  it('an admin account on a STANDARD device may push config', async () => {
    await setSetting('deviceRole', 'standard')
    authState.isAdmin = true
    render(h(App))
    await screen.findByText('BOARD STUB')
    expect(await policy()()).toBe(true)
  })

  it('a non-admin account on an ADMIN device may not', async () => {
    await setSetting('deviceRole', 'admin')
    authState.isAdmin = false
    render(h(App))
    await screen.findByText('BOARD STUB')
    expect(await policy()()).toBe(false)
  })

  it('leaving the shell restores the engine default', async () => {
    authState.isAdmin = true
    render(h(App))
    await screen.findByText('BOARD STUB')
    cleanup()
    expect(installed[installed.length - 1]).toBeNull()
  })
})
