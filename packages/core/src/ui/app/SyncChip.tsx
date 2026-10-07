/**
 * The sync status chip in the top bar. Shows SYNC_LABELS for the effective
 * status, a pending-upload badge, and runs an honest manual sync on tap
 * (syncNowChecked: the post-run unsynced count is ground truth, because the
 * engine's cycle swallows push failures).
 *
 * Sync affordances only exist when the device actually has a cloud:
 * '1 pending' on an offline-only device reads as 'a record has not been
 * backed up', which is alarming and untrue.
 */
import { useCallback, useEffect, useState } from 'react'
import { LIVE_LABEL, SYNC_LABELS, effectiveStatus, syncEngine, type SyncStatus } from '../../sync'

export interface SyncChipProps {
  standalone: boolean
  /** Called after a manual sync so the shell can refresh its snapshot. */
  onSynced: () => void
  /**
   * The realtime channel is SUBSCRIBED right now (the Clinic shell passes
   * its trigger's status). Honest by construction: "Live" shows only while
   * this is true AND the engine is at rest (idle or synced); syncing,
   * errors and offline keep their own labels. Field never passes it.
   */
  live?: boolean
}

export function SyncChip({ standalone, onSynced, live = false }: SyncChipProps) {
  const [status, setStatus] = useState<SyncStatus>(() => effectiveStatus(syncEngine.getStatus()))
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(0)
  const cloud = syncEngine.hasCloud() && !standalone

  useEffect(() => {
    const unsub = syncEngine.onStatus((s) => setStatus(effectiveStatus(s)))
    // Never claim connected while the browser says offline.
    const onOnline = (): void => setStatus(effectiveStatus(syncEngine.getStatus()))
    const onOffline = (): void => setStatus('offline')
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      unsub()
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // Pending badge: polled every 15s, re-armed on status change.
  useEffect(() => {
    if (!cloud) return
    let stop = false
    const poll = async (): Promise<void> => {
      try {
        const n = await syncEngine.getUnsyncedCount()
        if (!stop) setPending(n)
      } catch {
        /* count is cosmetic; never crash the chip */
      }
    }
    void poll()
    const timer = setInterval(() => {
      void poll()
    }, 15_000)
    return () => {
      stop = true
      clearInterval(timer)
    }
  }, [cloud, status])

  const doSync = useCallback(async () => {
    if (busy) return
    setBusy(true)
    try {
      const r = await syncEngine.syncNowChecked()
      if (!r.ok) {
        window.alert(
          `Not backed up.\n\n${r.stillPending} record${r.stillPending === 1 ? ' is' : 's are'} still waiting to upload. ${r.reason}\n\nTry again when you have signal. Do not wipe or hand on this device until this clears.`,
        )
      }
      onSynced()
    } finally {
      setBusy(false)
    }
  }, [busy, onSynced])

  const info =
    live && (status === 'synced' || status === 'idle') ? LIVE_LABEL : SYNC_LABELS[status]
  return (
    <button
      type="button"
      className={`sync sync-${info.tone}`}
      disabled={!cloud || busy}
      title={cloud ? info.hint : 'Cloud sync is off. Records stay on this device.'}
      onClick={() => {
        void doSync()
      }}
    >
      <span className="dot" aria-hidden="true" />
      <span>{cloud ? (busy ? 'Syncing…' : info.label) : 'Offline only'}</span>
      {cloud && pending > 0 ? <span className="pending">{pending} pending</span> : null}
    </button>
  )
}
