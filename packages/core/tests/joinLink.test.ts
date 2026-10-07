/**
 * Join links (src/sync/joinLink.ts): the way a Clinic device learns its
 * project without anyone typing an address or a key.
 *  - encode and read are inverses, the URL is normalized, the org name is
 *    trimmed and capped;
 *  - the fragment is base64url with no padding: nothing a chat app, a mail
 *    client or a QR reader would mangle;
 *  - a server key is refused INSIDE a link with the exact SERVER_KEY_ERROR,
 *    the same sentence every typed-key UI shows, and never encoded;
 *  - every malformed shape reads as invalid with copy for the wizard and
 *    parses to null; an ordinary open (no join parameter) is 'none';
 *  - joinProject configures through connectToProject, writes setupComplete
 *    LAST, and leaves the device untouched when verification fails.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { resetStorage } from './setup'
import type { KV } from '../src/kernel/api'
import { settings } from '../src/kernel'
import InviteCard, { COPY_FAILED, COPY_OK, NO_PROJECT_LINK } from '../src/ui/staff/InviteCard'
import { NOT_ADMIN_REASON } from '../src/ui/staff/staffApi'
import {
  BAD_URL_ERROR,
  EMPTY_KEY_ERROR,
  JOIN_LINK_MALFORMED_ERROR,
  JOIN_LINK_VERSION_ERROR,
  ORG_NAME_MAX,
  ORG_NAME_SETTING,
  SERVER_KEY_ERROR,
  currentAppUrl,
  defaultJoinedDeviceName,
  encodeJoinLink,
  joinProject,
  parseJoinLink,
  projectHost,
  readJoinLink,
  stripJoinParam,
} from '../src/sync'

const APP = 'https://damicohealth.com/clinic/'
const URL = 'https://myproject.supabase.co'
const KEY = 'sb_publishable_abcdefghijklmnopqrstuvwxyz012345'
const ORG = 'Kabale Community Clinic'

/** A link from an arbitrary (possibly malformed) payload object. */
function handMade(payload: unknown): string {
  const json = JSON.stringify(payload)
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `${APP}#join=${b64}`
}

function memKv(): KV & { data: Map<string, unknown>; writes: string[] } {
  const data = new Map<string, unknown>()
  const writes: string[] = []
  return {
    data,
    writes,
    async get<T>(key: string): Promise<T | null> {
      return data.has(key) ? (data.get(key) as T) : null
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value)
      writes.push(key)
    },
    async remove(key: string): Promise<void> {
      data.delete(key)
    },
  }
}

// ---------------------------------------------------------------------------
// Encode / read
// ---------------------------------------------------------------------------

describe('encodeJoinLink / readJoinLink', () => {
  it('round-trips the payload and normalizes the project URL', () => {
    const link = encodeJoinLink({ url: `${URL}/`, key: ` ${KEY} `, orgName: `  ${ORG}  ` }, { appUrl: APP })
    expect(link.startsWith(`${APP}#join=`)).toBe(true)
    expect(readJoinLink(link)).toEqual({
      kind: 'ok',
      payload: { url: URL, key: KEY, orgName: ORG },
    })
    expect(parseJoinLink(link)).toEqual({ url: URL, key: KEY, orgName: ORG })
  })

  it('reads a full href, a bare fragment, or the fragment body alone', () => {
    const link = encodeJoinLink({ url: URL, key: KEY, orgName: ORG }, { appUrl: APP })
    const hash = link.slice(link.indexOf('#'))
    expect(parseJoinLink(link)).toEqual({ url: URL, key: KEY, orgName: ORG })
    expect(parseJoinLink(hash)).toEqual({ url: URL, key: KEY, orgName: ORG })
    expect(parseJoinLink(hash.slice(1))).toEqual({ url: URL, key: KEY, orgName: ORG })
    // Other fragment parameters may sit beside it.
    expect(parseJoinLink(`#foo=1&${hash.slice(1)}&bar=2`)).toEqual({
      url: URL,
      key: KEY,
      orgName: ORG,
    })
  })

  it('the fragment is base64url without padding, for every org name tried', () => {
    const names = [
      ORG,
      'Ólafur Þór',
      'ሰላም ክሊኒክ',
      'عيادة',
      'Клиника',
      '診所',
      '>>>???///+++',
      'a',
      'ab',
      'abc',
      '',
    ]
    let standardWouldHaveNeededEscaping = 0
    for (const name of names) {
      const link = encodeJoinLink({ url: URL, key: KEY, orgName: name }, { appUrl: APP })
      const fragment = link.slice(link.indexOf('#join=') + 6)
      expect(fragment).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(fragment).not.toMatch(/[+/=]/)
      // The same bytes in standard base64 would have carried + / or =.
      const json = JSON.stringify({ v: 1, url: URL, key: KEY, orgName: name.trim() })
      if (/[+/=]/.test(btoa(unescape(encodeURIComponent(json))))) standardWouldHaveNeededEscaping++
      expect(parseJoinLink(link)?.orgName).toBe(name.trim())
    }
    // The corpus really exercised the url-safe substitutions.
    expect(standardWouldHaveNeededEscaping).toBeGreaterThan(0)
  })

  it('caps the org name on encode and on read', () => {
    const long = 'x'.repeat(ORG_NAME_MAX + 40)
    const link = encodeJoinLink({ url: URL, key: KEY, orgName: long }, { appUrl: APP })
    expect(parseJoinLink(link)?.orgName).toBe('x'.repeat(ORG_NAME_MAX))
    const hand = handMade({ v: 1, url: URL, key: KEY, orgName: long })
    expect(parseJoinLink(hand)?.orgName).toBe('x'.repeat(ORG_NAME_MAX))
  })

  it('strips any query or fragment from the app address and defaults it to this page', () => {
    const link = encodeJoinLink({ url: URL, key: KEY }, { appUrl: `${APP}?x=1#old` })
    expect(link.startsWith(`${APP}#join=`)).toBe(true)
    expect(parseJoinLink(link)?.orgName).toBe('')
    // jsdom serves the test page at its own origin; that is the default.
    const here = currentAppUrl()
    expect(here).toBe(`${window.location.origin}${window.location.pathname}`)
    expect(encodeJoinLink({ url: URL, key: KEY }).startsWith(`${here}#join=`)).toBe(true)
  })

  it('accepts the legacy anon JWT as well as a publishable key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.signature'
    const link = encodeJoinLink({ url: URL, key: jwt }, { appUrl: APP })
    expect(parseJoinLink(link)?.key).toBe(jwt)
  })
})

// ---------------------------------------------------------------------------
// Server keys: never in, never out
// ---------------------------------------------------------------------------

describe('server keys inside a link', () => {
  it('a service_role JWT in a hand-made link is refused with the exact SERVER_KEY_ERROR', () => {
    const link = handMade({
      v: 1,
      url: URL,
      key: 'eyJhbGciOiJIUzI1NiJ9.role-service_role.signature',
      orgName: ORG,
    })
    expect(readJoinLink(link)).toEqual({ kind: 'invalid', error: SERVER_KEY_ERROR })
    expect(parseJoinLink(link)).toBeNull()
  })

  it('an sb_secret_ key in a hand-made link is refused the same way', () => {
    const link = handMade({ v: 1, url: URL, key: 'sb_secret_abc123def456', orgName: ORG })
    expect(readJoinLink(link)).toEqual({ kind: 'invalid', error: SERVER_KEY_ERROR })
    expect(parseJoinLink(link)).toBeNull()
  })

  it('encodeJoinLink refuses to mint a link from a server key, with the same sentence', () => {
    expect(() => encodeJoinLink({ url: URL, key: 'sb_secret_abc123def456' }, { appUrl: APP })).toThrow(
      SERVER_KEY_ERROR,
    )
    expect(() => encodeJoinLink({ url: 'http://myproject.supabase.co', key: KEY })).toThrow(
      BAD_URL_ERROR,
    )
    expect(() => encodeJoinLink({ url: URL, key: '   ' })).toThrow(EMPTY_KEY_ERROR)
  })
})

// ---------------------------------------------------------------------------
// Malformed and absent
// ---------------------------------------------------------------------------

describe('malformed links', () => {
  const malformed: [string, string][] = [
    ['not base64url characters', `${APP}#join=@@@`],
    ['empty value', `${APP}#join=`],
    ['bare name, no value', `${APP}#join`],
    ['valid base64url, not JSON', `${APP}#join=${btoa('hello').replace(/=+$/, '')}`],
    ['a JSON array', handMade([URL, KEY])],
    ['a JSON string', handMade('join me')],
    ['a JSON number', handMade(42)],
    ['null', handMade(null)],
    ['missing key', handMade({ v: 1, url: URL })],
    ['missing url', handMade({ v: 1, key: KEY })],
    ['missing version', handMade({ url: URL, key: KEY })],
    ['non-integer version', handMade({ v: 1.5, url: URL, key: KEY })],
    ['version as string', handMade({ v: '1', url: URL, key: KEY })],
    ['older version number', handMade({ v: 0, url: URL, key: KEY })],
    ['url not a string', handMade({ v: 1, url: 7, key: KEY })],
    ['key not a string', handMade({ v: 1, url: URL, key: { k: KEY } })],
    ['orgName not a string', handMade({ v: 1, url: URL, key: KEY, orgName: ['x'] })],
    ['an extra field riding along', handMade({ v: 1, url: URL, key: KEY, password: 'hunter2' })],
    ['a session token riding along', handMade({ v: 1, url: URL, key: KEY, token: 'eyJ' })],
    ['invalid UTF-8 bytes', `${APP}#join=${btoa('\xff\xfe{').replace(/=+$/, '')}`],
  ]
  for (const [label, link] of malformed) {
    it(`${label}: invalid with the malformed copy, parses to null`, () => {
      expect(readJoinLink(link)).toEqual({ kind: 'invalid', error: JOIN_LINK_MALFORMED_ERROR })
      expect(parseJoinLink(link)).toBeNull()
    })
  }

  it('a link from a newer payload version says so instead of calling it damaged', () => {
    const link = handMade({ v: 2, url: URL, key: KEY, orgName: ORG })
    expect(readJoinLink(link)).toEqual({ kind: 'invalid', error: JOIN_LINK_VERSION_ERROR })
    expect(parseJoinLink(link)).toBeNull()
  })

  it('a bad project URL or an empty key surfaces the keys.ts copy', () => {
    expect(readJoinLink(handMade({ v: 1, url: 'http://evil.example.com', key: KEY }))).toEqual({
      kind: 'invalid',
      error: BAD_URL_ERROR,
    })
    expect(readJoinLink(handMade({ v: 1, url: 'https://myproject.supabase.co.evil.com', key: KEY }))).toEqual({
      kind: 'invalid',
      error: BAD_URL_ERROR,
    })
    expect(readJoinLink(handMade({ v: 1, url: URL, key: '' }))).toEqual({
      kind: 'invalid',
      error: EMPTY_KEY_ERROR,
    })
  })

  it('an ordinary open is none, never invalid', () => {
    for (const s of ['', '#', '#foo=1', `${APP}`, `${APP}?x=1`, `${APP}#other=join`]) {
      expect(readJoinLink(s)).toEqual({ kind: 'none' })
      expect(parseJoinLink(s)).toBeNull()
    }
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('stripJoinParam / projectHost / defaultJoinedDeviceName', () => {
  it('removes only the join parameter', () => {
    expect(stripJoinParam('#join=abc')).toBe('')
    expect(stripJoinParam('join=abc')).toBe('')
    expect(stripJoinParam('#foo=1&join=abc&bar=2')).toBe('#foo=1&bar=2')
    expect(stripJoinParam('#foo')).toBe('#foo')
    expect(stripJoinParam('')).toBe('')
    expect(stripJoinParam('#')).toBe('')
  })

  it('projectHost shows the host only', () => {
    expect(projectHost('https://myproject.supabase.co')).toBe('myproject.supabase.co')
    expect(projectHost('https://myproject.supabase.co/rest/v1')).toBe('myproject.supabase.co')
  })

  it('names a joined device by platform and local date', () => {
    const day = new Date(2026, 9, 6, 23, 30) // local 6 Oct, late evening
    expect(
      defaultJoinedDeviceName(
        'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15',
        day,
      ),
    ).toBe('iPad joined 2026-10-06')
    expect(
      defaultJoinedDeviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X)', day),
    ).toBe('iPhone joined 2026-10-06')
    expect(defaultJoinedDeviceName('Mozilla/5.0 (Linux; Android 14; Pixel 8)', day)).toBe(
      'Android device joined 2026-10-06',
    )
    expect(defaultJoinedDeviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4)', day)).toBe(
      'Mac joined 2026-10-06',
    )
    expect(defaultJoinedDeviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)', day)).toBe(
      'Windows PC joined 2026-10-06',
    )
    expect(defaultJoinedDeviceName('', day)).toBe('Device joined 2026-10-06')
  })
})

// ---------------------------------------------------------------------------
// joinProject
// ---------------------------------------------------------------------------

describe('joinProject', () => {
  const payload = { url: URL, key: KEY, orgName: ORG }

  it('connects through connectToProject as a standard device, then stores the org name and setupComplete LAST', async () => {
    const kv = memKv()
    const calls: unknown[][] = []
    const engine = {
      connectToProject: async (...args: unknown[]) => {
        calls.push(args)
        kv.writes.push('<connect>')
        return { ok: true }
      },
    }
    const r = await joinProject(payload, { engine, settings: kv, deviceName: 'Triage iPad' })
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual([[URL, KEY, 'Triage iPad', 'standard']])
    expect(kv.data.get(ORG_NAME_SETTING)).toBe(ORG)
    expect(kv.data.get('setupComplete')).toBe('true')
    // Registration first, the completion flag last: a crash in between
    // re-runs the wizard instead of booting half-configured.
    expect(kv.writes.indexOf('<connect>')).toBeLessThan(kv.writes.indexOf('setupComplete'))
    expect(kv.writes[kv.writes.length - 1]).toBe('setupComplete')
  })

  it('uses the platform default device name when none is given', async () => {
    const kv = memKv()
    let name = ''
    const engine = {
      connectToProject: async (_u: string, _k: string, deviceName: string) => {
        name = deviceName
        return { ok: true }
      },
    }
    await joinProject(payload, { engine, settings: kv })
    expect(name).toMatch(/ joined \d{4}-\d{2}-\d{2}$/)
  })

  it('a refused verification stores nothing and names the org in the reason', async () => {
    const kv = memKv()
    const engine = {
      connectToProject: async () => ({
        ok: false,
        error: 'Table "records" not found. Please run the SQL setup script first.',
      }),
    }
    const r = await joinProject(payload, { engine, settings: kv })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe(
      'Could not join Kabale Community Clinic: Table "records" not found. Please run the SQL setup script first.',
    )
    expect(kv.data.size).toBe(0)
  })

  it('an unreachable project stores nothing and asks for the link to be opened again', async () => {
    const kv = memKv()
    const engine = {
      connectToProject: async () => {
        throw new Error('fetch failed')
      },
    }
    const r = await joinProject({ ...payload, orgName: '' }, { engine, settings: kv })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe(
      'Could not reach myproject.supabase.co. Check the device is online and open the link again. (fetch failed)',
    )
    expect(kv.data.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// The Staff screen's "Invite a device" card
// ---------------------------------------------------------------------------

describe('InviteCard', () => {
  const h = React.createElement
  const linkBox = (): HTMLTextAreaElement => screen.getByLabelText('Join link') as HTMLTextAreaElement

  beforeEach(async () => {
    await resetStorage()
    await settings.remove(ORG_NAME_SETTING)
  })

  afterEach(() => {
    cleanup()
  })

  it('admin: shows the link for this device project with a QR, regenerates it as the org name is typed, and copies it', async () => {
    const copied: string[] = []
    render(
      h(InviteCard, {
        isAdmin: true,
        getCredentials: () => ({ url: URL, key: KEY }),
        appUrl: APP,
        copyText: async (t: string) => {
          copied.push(t)
        },
      }),
    )
    await screen.findByLabelText('Join link')
    expect(linkBox().value.startsWith(`${APP}#join=`)).toBe(true)
    expect(parseJoinLink(linkBox().value)).toEqual({ url: URL, key: KEY, orgName: '' })
    expect(screen.getByRole('img', { name: 'QR code of the join link' })).toBeTruthy()
    expect(screen.queryByText(NOT_ADMIN_REASON)).toBeNull()

    fireEvent.change(screen.getByLabelText(/Organization name/), { target: { value: ORG } })
    await waitFor(() => expect(parseJoinLink(linkBox().value)?.orgName).toBe(ORG))
    await waitFor(async () => expect(await settings.get<string>(ORG_NAME_SETTING)).toBe(ORG))

    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await screen.findByText(COPY_OK)
    expect(copied).toEqual([linkBox().value])
  })

  it('uses the organization name this device already stored', async () => {
    await settings.set(ORG_NAME_SETTING, ORG)
    render(
      h(InviteCard, { isAdmin: true, getCredentials: () => ({ url: URL, key: KEY }), appUrl: APP }),
    )
    await screen.findByLabelText('Join link')
    expect(parseJoinLink(linkBox().value)?.orgName).toBe(ORG)
  })

  it('non-admin: the reason is shown, the controls are disabled, and no link or QR is rendered', async () => {
    render(
      h(InviteCard, { isAdmin: false, getCredentials: () => ({ url: URL, key: KEY }), appUrl: APP }),
    )
    await screen.findByText(NOT_ADMIN_REASON)
    expect(screen.queryByLabelText('Join link')).toBeNull()
    expect(screen.queryByRole('img', { name: 'QR code of the join link' })).toBeNull()
    const copy = screen.getByRole('button', { name: 'Copy link' }) as HTMLButtonElement
    expect(copy.disabled).toBe(true)
    expect(copy.title).toBe(NOT_ADMIN_REASON)
    expect((screen.getByLabelText(/Organization name/) as HTMLInputElement).disabled).toBe(true)
  })

  it('without a project there is no link, and it says so', async () => {
    render(h(InviteCard, { isAdmin: true, getCredentials: () => ({ url: null, key: null }) }))
    await screen.findByText(NO_PROJECT_LINK)
    expect(screen.queryByLabelText('Join link')).toBeNull()
  })

  it('a failed clipboard write tells the person to copy by hand', async () => {
    render(
      h(InviteCard, {
        isAdmin: true,
        getCredentials: () => ({ url: URL, key: KEY }),
        appUrl: APP,
        copyText: async () => {
          throw new Error('denied')
        },
      }),
    )
    await screen.findByLabelText('Join link')
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))
    await screen.findByText(COPY_FAILED)
  })
})
