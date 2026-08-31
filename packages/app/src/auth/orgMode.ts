/**
 * The org-mode signal. The mode lives in the org's cloud config under key
 * 'orgMode' ({"mode":"field"} or {"mode":"clinic"}); the sync engine's
 * pullConfig replicates it into the local config KV like any other key.
 * The server keeps that one row anon-readable in clinic mode precisely so
 * a device holding only URL + key can discover it must show a sign-in
 * screen (see supabase/setup.sql section 9).
 *
 * ABSENT MEANS FIELD. v3 orgs have no orgMode row and must keep working
 * unchanged; an unreadable or garbled value also reads as field, because
 * failing toward "lock the device behind a sign-in screen" on a parse
 * hiccup would take working field clinics offline.
 */
import { useEffect, useState } from 'react'
import type { KV } from '../kernel/api'
import { config as kernelConfig } from '../kernel'
import { syncEngine } from '../sync'

export type OrgMode = 'field' | 'clinic'

/** Parse a stored orgMode value. Only an explicit clinic marker counts. */
export function parseOrgMode(value: unknown): OrgMode {
  if (value && typeof value === 'object' && (value as { mode?: unknown }).mode === 'clinic') {
    return 'clinic'
  }
  // Tolerate a bare string (hand-edited config rows exist in the wild).
  if (value === 'clinic') return 'clinic'
  return 'field'
}

export async function getOrgMode(kv: KV = kernelConfig): Promise<OrgMode> {
  try {
    return parseOrgMode(await kv.get<unknown>('orgMode'))
  } catch {
    return 'field'
  }
}

export interface OrgModeSubscriptionDeps {
  kv?: KV
  /** Config-change signal; defaults to the sync engine's. */
  onConfigUpdated?: (cb: () => void) => () => void
}

/**
 * The shell's subscription hook: fires once with the current mode, then
 * again whenever a config pull changes it (deduplicated - unchanged pulls
 * are silent). Returns the unsubscribe.
 */
export function subscribeOrgMode(
  cb: (mode: OrgMode) => void,
  deps: OrgModeSubscriptionDeps = {},
): () => void {
  const kv = deps.kv ?? kernelConfig
  const onConfigUpdated = deps.onConfigUpdated ?? ((fn) => syncEngine.onConfigUpdated(fn))

  let last: OrgMode | null = null
  let stopped = false

  const read = (): void => {
    void getOrgMode(kv).then((mode) => {
      if (stopped || mode === last) return
      last = mode
      cb(mode)
    })
  }

  read()
  const unsub = onConfigUpdated(read)
  return () => {
    stopped = true
    unsub()
  }
}

/** React flavor of the subscription, for screens that only need the value. */
export function useOrgMode(): OrgMode {
  const [mode, setMode] = useState<OrgMode>('field')
  useEffect(() => subscribeOrgMode(setMode), [])
  return mode
}
