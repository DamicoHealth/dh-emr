/**
 * DH EMR Clinic shell: join links at boot (src/App.tsx consumeJoinLink).
 *
 * A device opened with <app>/#join=<payload> must configure itself BEFORE
 * the wizard could render and land on sign-in, with nothing typed:
 *  - the tables are verified against the project in the link and the device
 *    is registered there (the real verifyTables + connectToProject path, on
 *    a stubbed fetch), credentials and setupComplete are stored, the org
 *    name is remembered, and the fragment is stripped from the NEW_URL;
 *  - an unusable link (a server key inside it, an unreachable project)
 *    shows its reason on the wizard, strips the fragment, and stores
 *    nothing;
 *  - a device already on a DIFFERENT project gets a clear confirm; cancel
 *    changes nothing, accept signs out of the old project first and then
 *    re-registers in the new one;
 *  - a device already on THAT project does nothing (no network, same id).
 *
 * The auth layer is mocked at the module boundary (signed out throughout,
 * with signOut recorded); fetch is stubbed so the sync engine's own code
 * runs end to end without a network. Heavy screens are stubbed as in
 * appBootGate.test.ts.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
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

/** Order of side effects across the auth seam and the network. */
const trace = vi.hoisted(() => ({ events: [] as string[] }))
vi.mock('@dh/core/auth', () => ({
  loadCurrentProfile: async () => ({ state: 'signedOut' }),
  authSession: {
    onAuthChange: () => () => {},
    signOut: async () => {
      trace.events.push('signOut')
    },
    getAccessToken: () => null,
    getSession: async () => null,
    init: async () => {},
  },
}))

import { getSetting, setCurrentDeviceId, setSetting, settings } from '@dh/core/kernel'
import { ORG_NAME_SETTING, SERVER_KEY_ERROR, encodeJoinLink, syncEngine } from '@dh/core/sync'
import { App } from '../src/App'

const h = React.createElement

const NEW_URL = 'https://newproject.supabase.co'
const NEW_KEY = 'sb_publishable_new_project_key_0123456789'
const ORG = 'Kabale Community Clinic'
const OLD_URL = 'https://oldproject.supabase.co'
const OLD_KEY = 'sb_publishable_old_project_key_0123456789'
const OLD_DEVICE = 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab'

const SETTING_KEYS = [
  'setupComplete',
  'standaloneMode',
  'deviceName',
  'deviceId',
  'deviceRole',
  'supabaseUrl',
  'supabaseKey',
  'authProfile',
  ORG_NAME_SETTING,
]

interface Hit {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

let hits: Hit[] = []

function stubFetch(opts: { fail?: boolean } = {}): void {
  hits = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const method = init?.method ?? 'GET'
    hits.push({
      url,
      method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    })
    trace.events.push(`fetch ${method}`)
    if (opts.fail) throw new TypeError('Failed to fetch')
    return method === 'GET'
      ? new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(null, { status: 204 })
  })
}

function openWith(hash: string): void {
  window.history.replaceState(null, '', `/${hash}`)
}

/** A join link's fragment for the given payload, or a hand-made one. */
function fragmentFor(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload)
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `#join=${b64}`
}

function goodLinkHash(): string {
  const link = encodeJoinLink({ url: NEW_URL, key: NEW_KEY, orgName: ORG }, { appUrl: 'http://localhost/' })
  return link.slice(link.indexOf('#'))
}

/** Boots the shell set up and connected to the OLD project. */
async function seedConnectedDevice(): Promise<void> {
  await setSetting('setupComplete', 'true')
  await setSetting('deviceId', OLD_DEVICE)
  await setSetting('deviceName', 'Reception iPad')
  await setSetting('supabaseUrl', OLD_URL)
  await setSetting('supabaseKey', OLD_KEY)
  setCurrentDeviceId(OLD_DEVICE)
  syncEngine.updateCredentials(OLD_URL, OLD_KEY)
}

beforeEach(async () => {
  await resetStorage()
  for (const k of SETTING_KEYS) await settings.remove(k)
  setCurrentDeviceId(null)
  syncEngine.updateCredentials(null, null)
  trace.events = []
  window.history.replaceState(null, '', '/')
  // Device-registration warnings on the failing-network case are expected.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  syncEngine.updateCredentials(null, null)
  window.history.replaceState(null, '', '/')
})

describe('clinic shell: join link at boot', () => {
  it('a fresh device opened with a valid link verifies, registers, stores, strips the hash and lands on sign-in', async () => {
    stubFetch()
    openWith(goodLinkHash())
    expect(window.location.hash).not.toBe('')

    render(h(App))
    await screen.findByRole('heading', { name: 'Sign in' })

    // Never the wizard, never the shell.
    expect(screen.queryByText('Connect to your cloud')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Board' })).toBeNull()

    // The fragment is gone from the NEW_URL.
    expect(window.location.hash).toBe('')
    expect(window.location.pathname).toBe('/')

    // Credentials stored and live in the engine, setup complete, org name kept.
    expect(await getSetting<string>('supabaseUrl')).toBe(NEW_URL)
    expect(await getSetting<string>('supabaseKey')).toBe(NEW_KEY)
    expect(await getSetting<string>('setupComplete')).toBe('true')
    expect(await getSetting<string>('standaloneMode')).toBe('false')
    expect(await getSetting<string>(ORG_NAME_SETTING)).toBe(ORG)
    expect(syncEngine.getCredentials()).toEqual({ url: NEW_URL, key: NEW_KEY })
    const deviceId = await getSetting<string>('deviceId')
    expect(deviceId).toBeTruthy()
    expect(deviceId).not.toBe('pwa-device-001')
    expect(await getSetting<string>('deviceName')).toMatch(/ joined \d{4}-\d{2}-\d{2}$/)

    // The real verify path: the three tables, with the key as apikey and
    // NO bearer (a publishable key is not a JWT).
    const gets = hits.filter((x) => x.method === 'GET')
    expect(gets.map((x) => x.url)).toEqual([
      `${NEW_URL}/rest/v1/records?limit=0`,
      `${NEW_URL}/rest/v1/devices?limit=0`,
      `${NEW_URL}/rest/v1/config?limit=0`,
    ])
    for (const g of gets) {
      expect(g.headers.apikey).toBe(NEW_KEY)
      expect(g.headers.Authorization).toBeUndefined()
    }
    // Then the registration POST in the new project, as a standard device.
    const post = hits.find((x) => x.method === 'POST')
    expect(post?.url).toBe(`${NEW_URL}/rest/v1/devices`)
    expect((post?.body as { id: string; role: string }).id).toBe(deviceId)
    expect((post?.body as { role: string }).role).toBe('standard')
    // No old project to sign out of.
    expect(trace.events).not.toContain('signOut')
  })

  it('a link carrying a server key shows the exact SERVER_KEY_ERROR on the wizard, strips the hash, stores nothing', async () => {
    stubFetch()
    openWith(fragmentFor({ v: 1, url: NEW_URL, key: 'sb_secret_abc123def456', orgName: ORG }))

    render(h(App))
    await screen.findByText(SERVER_KEY_ERROR)
    expect(screen.getByText('Connect to your cloud')).toBeTruthy()
    // The clinic wizard leads with the link path.
    expect(screen.getByText('Open the link your admin sent you')).toBeTruthy()
    expect(screen.queryByText('Use this device on its own')).toBeNull()

    expect(window.location.hash).toBe('')
    expect(hits).toHaveLength(0)
    expect(await getSetting('supabaseUrl')).toBeNull()
    expect(await getSetting('supabaseKey')).toBeNull()
    expect(await getSetting('setupComplete')).toBeNull()
    expect(await getSetting('deviceId')).toBeNull()
    expect(syncEngine.hasCloud()).toBe(false)
  })

  it('a damaged link says so on the wizard rather than silently falling back', async () => {
    stubFetch()
    openWith('#join=not-a-payload')

    render(h(App))
    await screen.findByText('That join link is damaged or incomplete. Ask your admin to send it again.')
    expect(screen.getByText('Connect to your cloud')).toBeTruthy()
    expect(window.location.hash).toBe('')
    expect(hits).toHaveLength(0)
    expect(await getSetting('setupComplete')).toBeNull()
  })

  it('an unreachable project shows the reason on the wizard and stores nothing', async () => {
    stubFetch({ fail: true })
    openWith(goodLinkHash())

    render(h(App))
    // verifyTables reports the transport failure; joinProject names the org.
    await screen.findByText('Could not join Kabale Community Clinic: Failed to fetch')
    expect(screen.getByText('Connect to your cloud')).toBeTruthy()

    expect(window.location.hash).toBe('')
    // verifyTables failed on the first table: nothing was stored.
    expect(hits.length).toBeGreaterThan(0)
    expect(await getSetting('supabaseUrl')).toBeNull()
    expect(await getSetting('supabaseKey')).toBeNull()
    expect(await getSetting('setupComplete')).toBeNull()
    expect(await getSetting('deviceId')).toBeNull()
    expect(syncEngine.hasCloud()).toBe(false)
  })

  it('a device on a DIFFERENT project is asked first; cancel changes nothing', async () => {
    stubFetch()
    await seedConnectedDevice()
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => false)
    openWith(goodLinkHash())

    render(h(App))
    await screen.findByRole('heading', { name: 'Sign in' })

    expect(confirm).toHaveBeenCalledTimes(1)
    const msg = String(confirm.mock.calls[0]?.[0])
    expect(msg).toContain('already connected to oldproject.supabase.co')
    expect(msg).toContain('Kabale Community Clinic (newproject.supabase.co)')

    expect(window.location.hash).toBe('')
    expect(hits).toHaveLength(0)
    expect(trace.events).not.toContain('signOut')
    expect(await getSetting<string>('supabaseUrl')).toBe(OLD_URL)
    expect(await getSetting<string>('supabaseKey')).toBe(OLD_KEY)
    expect(await getSetting<string>('deviceId')).toBe(OLD_DEVICE)
    expect(syncEngine.getCredentials()).toEqual({ url: OLD_URL, key: OLD_KEY })
    expect(screen.queryByText(/could not be used/)).toBeNull()
  })

  it('accepting the switch signs out of the old project FIRST, then re-registers in the new one', async () => {
    stubFetch()
    await seedConnectedDevice()
    vi.spyOn(window, 'confirm').mockImplementation(() => true)
    openWith(goodLinkHash())

    render(h(App))
    await screen.findByRole('heading', { name: 'Sign in' })

    await waitFor(async () => {
      expect(await getSetting<string>('supabaseUrl')).toBe(NEW_URL)
    })
    expect(await getSetting<string>('supabaseKey')).toBe(NEW_KEY)
    expect(syncEngine.getCredentials()).toEqual({ url: NEW_URL, key: NEW_KEY })
    // Re-registered: a fresh identity in the new project.
    const deviceId = await getSetting<string>('deviceId')
    expect(deviceId).toBeTruthy()
    expect(deviceId).not.toBe(OLD_DEVICE)
    const post = hits.find((x) => x.method === 'POST')
    expect(post?.url).toBe(`${NEW_URL}/rest/v1/devices`)
    expect((post?.body as { id: string }).id).toBe(deviceId)
    // The old session was cleared before any request went to the new project.
    expect(trace.events[0]).toBe('signOut')
    expect(trace.events.filter((e) => e === 'signOut')).toHaveLength(1)
    expect(window.location.hash).toBe('')
  })

  it('a device already on THAT project does nothing: no confirm, no network, same identity', async () => {
    stubFetch()
    await seedConnectedDevice()
    const confirm = vi.spyOn(window, 'confirm').mockImplementation(() => true)
    const link = encodeJoinLink({ url: OLD_URL, key: OLD_KEY, orgName: ORG }, { appUrl: 'http://localhost/' })
    openWith(link.slice(link.indexOf('#')))

    render(h(App))
    await screen.findByRole('heading', { name: 'Sign in' })

    expect(confirm).not.toHaveBeenCalled()
    expect(hits).toHaveLength(0)
    expect(trace.events).toEqual([])
    expect(await getSetting<string>('deviceId')).toBe(OLD_DEVICE)
    expect(await getSetting<string>('supabaseKey')).toBe(OLD_KEY)
    expect(window.location.hash).toBe('')
  })

  it('a link that lands in an already-open tab (hashchange, no reload) is consumed too', async () => {
    stubFetch()
    await seedConnectedDevice()
    vi.spyOn(window, 'confirm').mockImplementation(() => true)

    render(h(App))
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(hits).toHaveLength(0)

    // Same-document navigation: the fragment changes, nothing reloads.
    window.location.hash = goodLinkHash()
    window.dispatchEvent(new Event('hashchange'))

    await waitFor(async () => {
      expect(await getSetting<string>('supabaseUrl')).toBe(NEW_URL)
    })
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(syncEngine.getCredentials()).toEqual({ url: NEW_URL, key: NEW_KEY })
    expect(await getSetting<string>('deviceId')).not.toBe(OLD_DEVICE)
    expect(hits.find((x) => x.method === 'POST')?.url).toBe(`${NEW_URL}/rest/v1/devices`)
    expect(trace.events[0]).toBe('signOut')
    expect(window.location.hash).toBe('')
  })

  it('an ordinary open (no join parameter) touches nothing', async () => {
    stubFetch()
    await seedConnectedDevice()
    openWith('#other=1')

    render(h(App))
    await screen.findByRole('heading', { name: 'Sign in' })
    expect(hits).toHaveLength(0)
    expect(window.location.hash).toBe('#other=1')
    expect(await getSetting<string>('deviceId')).toBe(OLD_DEVICE)
  })
})
