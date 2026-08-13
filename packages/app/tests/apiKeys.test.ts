/**
 * Supabase has two kinds of client key and the difference is load-bearing.
 *
 * The legacy anon key is a JWT. The current publishable key (sb_publishable_)
 * is not, and sending a non-JWT as an Authorization bearer token makes
 * PostgREST try to parse it as one and reject the request.
 *
 * This is not cosmetic. A leaked LEGACY key cannot be rotated on its own: it
 * is derived from the project's JWT secret, so rotating it invalidates
 * service_role at the same moment. A publishable key can be deleted by
 * itself. If the client cannot speak to publishable keys, the only
 * remediation for a leak is the disruptive one.
 */
import { describe, expect, it } from 'vitest'
import { SERVER_KEY_ERROR, classifySupabaseKey, supabaseHeaders } from '../src/sync/keys'

// The repo ships no @types/node (the app is browser-only), so node builtins
// come in through an untyped dynamic import. Vitest runs tests in Node,
// where it always resolves.
const { readFileSync, readdirSync } = (await import('node:fs' as string)) as {
  readFileSync: (p: string, enc: 'utf8') => string
  readdirSync: (p: string) => string[]
}

// The intermediate variable keeps vite's static `new URL(x, import.meta.url)`
// asset rewriting away from a plain filesystem path computation.
const metaUrl: string = import.meta.url
const SYNC_DIR = decodeURIComponent(new URL('../src/sync/', metaUrl).pathname)

const LEGACY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.sig'

describe('Supabase key handling', () => {
  it('sends a legacy anon JWT in both headers, as PostgREST expects', () => {
    const h = supabaseHeaders(LEGACY)
    expect(h.apikey).toBe(LEGACY)
    expect(h.Authorization).toBe(`Bearer ${LEGACY}`)
  })

  it('does NOT bearer a publishable key', () => {
    const h = supabaseHeaders('sb_publishable_AbCdEf123')
    expect(h.apikey).toBe('sb_publishable_AbCdEf123')
    expect(h.Authorization).toBeUndefined()
  })

  it('does NOT bearer a secret key either', () => {
    expect(supabaseHeaders('sb_secret_XyZ789').Authorization).toBeUndefined()
  })

  it('keeps caller-supplied headers', () => {
    const h = supabaseHeaders('sb_publishable_x', {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    })
    expect(h['Content-Type']).toBe('application/json')
    expect(h.Prefer).toBe('resolution=merge-duplicates')
    expect(h.apikey).toBe('sb_publishable_x')
  })

  it('never leaves a stray Bearer anywhere in the sync engine', () => {
    // Every call site must go through the helper, or one forgotten fetch
    // breaks the whole rotation on a path nobody exercises until it matters.
    // In the rebuild the engine is TS modules, so the scan covers every file
    // in src/sync except keys.ts (the helper's one legitimate home).
    const strays: [string, number, string][] = []
    for (const file of readdirSync(SYNC_DIR)) {
      if (file === 'keys.ts') continue
      const src = readFileSync(SYNC_DIR + file, 'utf8')
      src.split('\n').forEach((l, i) => {
        if (/Bearer/.test(l)) strays.push([file, i + 1, l])
      })
    }
    expect(strays).toEqual([])
  })
})

describe('key classification at entry (every key-entry UI calls this)', () => {
  it('REJECTS a service_role key with the exact warning', () => {
    const r = classifySupabaseKey('eyJhbGciOiJIUzI1NiJ9.service_role.sig')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe(
        'That is a server key (service_role or sb_secret). It bypasses every database security rule and must never go on a field device. Use the Publishable key, or the legacy anon key.',
      )
      expect(r.error).toBe(SERVER_KEY_ERROR)
    }
  })

  it('REJECTS an sb_secret_ key with the same warning', () => {
    const r = classifySupabaseKey('sb_secret_XyZ789')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe(SERVER_KEY_ERROR)
  })

  it('rejects an empty key', () => {
    const r = classifySupabaseKey('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Paste the project anon key.')
  })

  it('accepts the two legitimate client key kinds', () => {
    expect(classifySupabaseKey('sb_publishable_AbCdEf123')).toEqual({
      ok: true,
      kind: 'publishable',
    })
    expect(classifySupabaseKey(LEGACY)).toEqual({ ok: true, kind: 'legacy-anon' })
  })
})
