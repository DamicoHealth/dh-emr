/**
 * Storage health for the UI: is this device still keeping a usable second
 * copy of its records?
 *
 * The mirror is BOUNDED (newest MIRROR_LIMIT rows by savedAt), so a mirror
 * of 500 on a 5,000-record store is HEALTHY BY DESIGN - the warning must not
 * cry wolf just because liveCount exceeds the limit. The alarm conditions
 * are: the stale flag (last mirror write failed), a refusal (the recovery
 * machine blocked adoption), or the mirror running short of what it SHOULD
 * hold: min(liveCount, MIRROR_LIMIT), with slack for in-flight drift.
 */
import type { StorageHealth } from './api'
import { MIRROR_LIMIT, mirrorStaleKey, recordsKey, recordsMetaKey } from './namespace'
import { records } from './records'

export async function readStorageHealth(): Promise<StorageHealth> {
  let mirrorStale = false
  let mirrorCount: number | null = null
  let mirrorAt: string | null = null
  try {
    mirrorStale = localStorage.getItem(mirrorStaleKey()) === '1'
    const rawMirror = localStorage.getItem(recordsKey())
    if (rawMirror) {
      const mirror = JSON.parse(rawMirror) as unknown
      if (Array.isArray(mirror)) mirrorCount = mirror.length
    }
    const rawMeta = localStorage.getItem(recordsMetaKey())
    if (rawMeta) {
      const meta = JSON.parse(rawMeta) as { at?: unknown }
      mirrorAt = typeof meta.at === 'string' ? meta.at : null
    }
  } catch {
    // A device whose localStorage is unreadable is exactly the device that
    // needs the warning, so treat the failure itself as stale.
    mirrorStale = true
  }

  let liveCount = 0
  try {
    liveCount = (await records.getAll()).length
  } catch {
    /* reported elsewhere */
  }
  // Read AFTER the load above, which is what sets it.
  const refusal = records.mirrorRefusal()

  // The mirror should hold min(liveCount, MIRROR_LIMIT). 5% of the store or
  // 25 records of drift, whichever is larger, before we call it material.
  const shouldHold = Math.min(liveCount, MIRROR_LIMIT)
  const slack = Math.max(25, Math.round(liveCount * 0.05))
  const mirrorWouldLoseRecords = mirrorCount !== null && shouldHold - mirrorCount > slack

  return { refusal, mirrorStale, liveCount, mirrorCount, mirrorAt, mirrorWouldLoseRecords }
}

/** The emergency copy, when the device cannot read its records at all. */
export function storageEmergency(h: StorageHealth): string | null {
  if (!h.refusal) return null
  const held =
    h.refusal.expectedCount !== null
      ? `about ${h.refusal.expectedCount} records`
      : 'more records than that'
  return (
    `This device can no longer read its records. It still has an on-device backup copy ` +
    `holding ${h.refusal.mirrorCount}, but this device last had ${held}, so that copy is ` +
    `out of date and has NOT been loaded. Saving is blocked so nothing overwrites it. ` +
    `Restore from a backup file if you have one - that is the safest way back. ` +
    `Only use the older copy if there is no backup file anywhere.`
  )
}

export function storageWarning(h: StorageHealth): string | null {
  if (h.refusal) return null // storageEmergency covers this, louder
  if (!h.mirrorStale && !h.mirrorWouldLoseRecords) return null
  const behind =
    h.mirrorCount === null
      ? 'has never been written'
      : `is stuck at ${h.mirrorCount} of ${h.liveCount} records`
  return (
    `This device is down to a single copy of its records. The on-device backup copy ${behind}` +
    `${h.mirrorAt ? `, last updated ${new Date(h.mirrorAt).toLocaleDateString()}` : ''}. ` +
    'Download a backup now and at the end of every clinic day, and ask your admin to ' +
    'archive older encounters off this device.'
  )
}
