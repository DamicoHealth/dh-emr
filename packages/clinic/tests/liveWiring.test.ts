/**
 * DH EMR Clinic shell: the live-board wiring.
 *
 * Once the account gate is ACTIVE the shell starts the engine's auto-sync
 * at the Clinic cadence and the realtime trigger with the session's token
 * getter; when the gate leaves 'active' (sign-out, revocation) both stop.
 * A gate re-evaluation that lands on the same active account must NOT
 * bounce either. The chip says "Live" only while the trigger reports live.
 *
 * The auth layer is mocked at the module boundary (no network, no real
 * supabase-js); the sync singletons are the real objects with their start
 * and stop methods spied and neutered, so nothing opens a socket under
 * jsdom. Heavy screens are stubbed as in appBootGate.test.ts.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
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
  default: () => null,
}))

// The auth seam: a controllable profile verdict and a session manager fake
// whose onAuthChange listeners the test can fire.
const authState = vi.hoisted(() => ({
  profile: 'active' as 'active' | 'signedOut',
  listeners: new Set<() => void>(),
  token: 'tok-live-1' as string | null,
}))
vi.mock('@dh/core/auth', () => ({
  loadCurrentProfile: async () =>
    authState.profile === 'active'
      ? {
          state: 'active',
          profile: {
            userId: 'u1',
            displayName: 'Grace',
            role: 'reception',
            isAdmin: false,
            confirmedAt: new Date().toISOString(),
          },
          fromCache: false,
          stale: false,
        }
      : { state: 'signedOut' },
  authSession: {
    onAuthChange: (cb: () => void) => {
      authState.listeners.add(cb)
      return () => {
        authState.listeners.delete(cb)
      }
    },
    signOut: async () => {
      authState.profile = 'signedOut'
    },
    getAccessToken: () => authState.token,
    getSession: async () => null,
    init: async () => {},
  },
}))

import { setCurrentDeviceId, setSetting, settings } from '@dh/core/kernel'
import { CLINIC_AUTO_SYNC_INTERVAL_MS, realtimeTrigger, syncEngine } from '@dh/core/sync'
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

let startAuto: ReturnType<typeof vi.spyOn>
let stopAuto: ReturnType<typeof vi.spyOn>
let startRt: ReturnType<typeof vi.spyOn>
let stopRt: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  await resetStorage()
  for (const k of SETTING_KEYS) await settings.remove(k)
  await setSetting('setupComplete', 'true')
  await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
  await setSetting('deviceName', 'Reception iPad')
  await setSetting('supabaseUrl', 'https://myproject.supabase.co')
  await setSetting('supabaseKey', 'sb_publishable_test_key_000')
  setCurrentDeviceId('b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
  syncEngine.updateCredentials('https://myproject.supabase.co', 'sb_publishable_test_key_000')
  authState.profile = 'active'
  authState.listeners.clear()
  // The active gate's best-effort fleet-row POST hits a dead network here;
  // its warning is expected and only noise.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  startAuto = vi.spyOn(syncEngine, 'startAutoSync').mockImplementation(() => {})
  stopAuto = vi.spyOn(syncEngine, 'stopAutoSync').mockImplementation(() => {})
  startRt = vi.spyOn(realtimeTrigger, 'start').mockImplementation(() => {})
  stopRt = vi.spyOn(realtimeTrigger, 'stop').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  syncEngine.updateCredentials(null, null)
})

const fireAuthChange = async (): Promise<void> => {
  await act(async () => {
    authState.listeners.forEach((cb) => cb())
  })
}

describe('clinic shell live wiring', () => {
  it('starts auto-sync at the Clinic cadence and the realtime trigger once the gate is active', async () => {
    render(h(App))
    await screen.findByRole('button', { name: 'Board' })

    // The Board tab paints in the same commit that activates the gate; the
    // effect that starts sync flushes after it, so wait for the call.
    await waitFor(() => expect(startAuto).toHaveBeenCalledTimes(1))
    expect(startAuto).toHaveBeenCalledWith({ intervalMs: CLINIC_AUTO_SYNC_INTERVAL_MS })
    expect(startAuto).toHaveBeenCalledWith({ intervalMs: 20_000 })
    expect(startRt).toHaveBeenCalledTimes(1)
    // The trigger gets the SESSION's token getter, read live, not a snapshot.
    const opts = startRt.mock.calls[0]?.[0] as { getAccessToken?: () => string | null }
    expect(opts.getAccessToken?.()).toBe('tok-live-1')
    authState.token = 'tok-live-2'
    expect(opts.getAccessToken?.()).toBe('tok-live-2')
    expect(stopAuto).not.toHaveBeenCalled()
    expect(stopRt).not.toHaveBeenCalled()
  })

  it('a gate re-evaluation on the same active account does not bounce either', async () => {
    render(h(App))
    await screen.findByRole('button', { name: 'Board' })
    await fireAuthChange()
    await fireAuthChange()
    expect(startAuto).toHaveBeenCalledTimes(1)
    expect(startRt).toHaveBeenCalledTimes(1)
    expect(stopRt).not.toHaveBeenCalled()
  })

  it('stops both when the gate leaves active (sign-out)', async () => {
    render(h(App))
    await screen.findByRole('button', { name: 'Board' })
    authState.profile = 'signedOut'
    await fireAuthChange()
    await screen.findByRole('heading', { name: 'Sign in' })
    await waitFor(() => {
      expect(stopRt).toHaveBeenCalledTimes(1)
      expect(stopAuto).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()
  })

  it('the chip says Live only while the trigger reports live', async () => {
    // Let the real start run so the status path is exercised end to end,
    // with a fake channel factory standing in for supabase-js.
    startRt.mockRestore()
    stopRt.mockRestore()
    const { createRealtimeTrigger } = await import('@dh/core/sync')
    let statusCb: ((s: 'SUBSCRIBED' | 'CHANNEL_ERROR') => void) | null = null
    const trigger = createRealtimeTrigger({
      engine: syncEngine,
      clientFactory: () => ({
        channel: () => {
          const ch = {
            on: () => ch,
            subscribe: (cb: (s: 'SUBSCRIBED' | 'CHANNEL_ERROR') => void) => {
              statusCb = cb
              return ch
            },
          }
          return ch
        },
        removeChannel: async () => 'ok',
        setAuth: async () => {},
      }),
    })
    vi.spyOn(realtimeTrigger, 'start').mockImplementation((o) => trigger.start(o))
    vi.spyOn(realtimeTrigger, 'stop').mockImplementation(() => trigger.stop())
    vi.spyOn(realtimeTrigger, 'getStatus').mockImplementation(() => trigger.getStatus())
    vi.spyOn(realtimeTrigger, 'onStatus').mockImplementation((cb) => trigger.onStatus(cb))

    const { container } = render(h(App))
    await screen.findByRole('button', { name: 'Board' })
    const chip = (): HTMLElement => {
      const el = container.querySelector('button.sync')
      if (!(el instanceof HTMLElement)) throw new Error('sync chip not rendered')
      return el
    }
    expect(chip().textContent).not.toContain('Live')
    expect(statusCb).not.toBeNull()

    await act(async () => {
      statusCb?.('SUBSCRIBED')
    })
    expect(chip().textContent).toContain('Live')

    await act(async () => {
      statusCb?.('CHANNEL_ERROR')
    })
    expect(chip().textContent).not.toContain('Live')
    trigger.stop()
  })
})
