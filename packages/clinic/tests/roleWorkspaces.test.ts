/**
 * DH EMR Clinic shell: role workspaces.
 *
 * Every account lands on its role's workspace, and the tab set follows the
 * role (core/config/roles.ts decides; tabsFor in App.tsx is the one place
 * the list is built):
 *  - reception, triage, provider: Board first (focused on their station);
 *  - lab: the Lab workspace first, no Board;
 *  - pharmacy: the Pharmacy workspace first, no Board;
 *  - Analytics for providers and admins; New visit for the roles that
 *    register patients; Staff for admins; Settings for everyone.
 *
 * The auth layer is mocked at the module boundary with a controllable role
 * (no network); the sync singletons are neutered as in liveWiring.test.ts.
 * The Board, Records and visit form are stubbed; the Lab and Pharmacy
 * screens are the REAL ones so the landing is proven end to end.
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
  // The admin case runs ensureClinicOrgMode; an org already in clinic mode
  // makes it a no-op, so no network is touched.
  getOrgMode: async () => 'clinic',
}))

import { setCurrentDeviceId, setSetting, settings } from '@dh/core/kernel'
import { realtimeTrigger, syncEngine } from '@dh/core/sync'
import type { ActiveProfile } from '@dh/core/auth'
import { App, landingFor, tabsFor } from '../src/App'

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

function profile(role: string, isAdmin = false): ActiveProfile {
  return { userId: 'u1', displayName: 'Grace', role, isAdmin, confirmedAt: '2026-10-06T00:00:00Z' }
}

const labels = (p: ActiveProfile) => tabsFor(p).map((t) => t.label)

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
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(syncEngine, 'startAutoSync').mockImplementation(() => {})
  vi.spyOn(syncEngine, 'stopAutoSync').mockImplementation(() => {})
  vi.spyOn(realtimeTrigger, 'start').mockImplementation(() => {})
  vi.spyOn(realtimeTrigger, 'stop').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  syncEngine.updateCredentials(null, null)
})

describe('tab sets per role (pure)', () => {
  it('reception: Board, Visits, New visit, Settings', () => {
    expect(labels(profile('reception'))).toEqual(['Board', 'Visits', 'New visit', 'Settings'])
    expect(landingFor(profile('reception'))).toBe('board')
  })

  it('triage: Board, Visits, Settings (no registration, no analytics)', () => {
    expect(labels(profile('triage'))).toEqual(['Board', 'Visits', 'Settings'])
    expect(landingFor(profile('triage'))).toBe('board')
    // The pre-split nurse role is triage.
    expect(labels(profile('nurse'))).toEqual(['Board', 'Visits', 'Settings'])
  })

  it('provider: Board, Visits, New visit, Analytics, Settings', () => {
    expect(labels(profile('provider'))).toEqual(['Board', 'Visits', 'New visit', 'Analytics', 'Settings'])
    expect(landingFor(profile('provider'))).toBe('board')
  })

  it('lab: Lab workspace first, then Visits and Settings; no Board', () => {
    expect(labels(profile('lab'))).toEqual(['Lab', 'Visits', 'Settings'])
    expect(landingFor(profile('lab'))).toBe('lab')
  })

  it('pharmacy: Pharmacy workspace first, then Visits and Settings; no Board', () => {
    expect(labels(profile('pharmacy'))).toEqual(['Pharmacy', 'Visits', 'Settings'])
    expect(landingFor(profile('pharmacy'))).toBe('pharmacy')
  })

  it('an admin adds New visit, Analytics and Staff whatever the role, keeping the role\'s workspace', () => {
    expect(labels(profile('reception', true))).toEqual([
      'Board',
      'Visits',
      'New visit',
      'Analytics',
      'Staff',
      'Settings',
    ])
    // An admin always has the Board, after the workspace of their own role.
    expect(labels(profile('pharmacy', true))).toEqual([
      'Pharmacy',
      'Board',
      'Visits',
      'New visit',
      'Analytics',
      'Staff',
      'Settings',
    ])
    expect(labels(profile('lab', true))).toEqual([
      'Lab',
      'Board',
      'Visits',
      'New visit',
      'Analytics',
      'Staff',
      'Settings',
    ])
    expect(landingFor(profile('pharmacy', true))).toBe('pharmacy')
    // A non-admin lab or pharmacy account has no Board tab at all.
    expect(labels(profile('lab'))).not.toContain('Board')
  })
})

describe('landing per role (rendered shell)', () => {
  it('a pharmacist lands on the Pharmacy workspace with no Board tab', async () => {
    authState.role = 'pharmacy'
    render(h(App))
    await screen.findByRole('heading', { name: 'Pharmacy' })
    expect(screen.getByRole('button', { name: 'Pharmacy' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Analytics' })).toBeNull()
    expect(screen.queryByText('BOARD STUB')).toBeNull()
    await screen.findByText('Nothing is waiting to be dispensed')
  })

  it('a lab tech lands on the Lab workspace', async () => {
    authState.role = 'lab'
    render(h(App))
    await screen.findByRole('heading', { name: 'Lab' })
    expect(screen.getByRole('button', { name: 'Lab' }).getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
    await screen.findByText('No visits are waiting on lab results')
  })

  it('a provider lands on the Board with Analytics available', async () => {
    authState.role = 'provider'
    render(h(App))
    await screen.findByText('BOARD STUB')
    expect(screen.getByRole('button', { name: 'Board' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New visit' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Staff' })).toBeNull()
  })

  it('an admin gets Staff in addition to the role\'s workspace', async () => {
    authState.role = 'reception'
    authState.isAdmin = true
    render(h(App))
    await screen.findByText('BOARD STUB')
    expect(screen.getByRole('button', { name: 'Staff' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Analytics' })).toBeTruthy()
  })
})
