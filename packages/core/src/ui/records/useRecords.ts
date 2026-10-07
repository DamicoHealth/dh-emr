/**
 * Data plumbing for the Records screens.
 *
 * useRecords is a live view of the active (non-deleted) records read through
 * the kernel store. Unlike the previous implementation, it does NOT subscribe
 * to sync events itself: the app shell already listens to onExternalWrite and
 * syncEngine.onRecordsUpdated and bumps refreshSignal, and RecordsScreen
 * re-reads on that signal. Subscribing here as well would double every read.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PatientRecord } from '../../types/record'
import { records as recordsStore } from '../../kernel'

export function useRecords(): {
  records: PatientRecord[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
} {
  const [records, setRecords] = useState<PatientRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Guards against an older, slower read landing after a newer one. */
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const r = await recordsStore.getActive()
      if (seq !== seqRef.current) return // superseded
      setRecords(r)
      setError(null)
    } catch (e) {
      if (seq !== seqRef.current) return
      // A read failure is meaningful: it can mean storage is unreadable,
      // which the kernel deliberately surfaces rather than reporting
      // "no records".
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { records, loading, error, refresh }
}

/** Tombstone a visit through the kernel (soft delete; the tombstone syncs). */
export function deleteRecord(id: string): Promise<PatientRecord[]> {
  return recordsStore.softDelete(id)
}

/** Debounce a rapidly-changing value (search input) to keep typing smooth. */
export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
