/**
 * Public shape of the storage kernel. See DESIGN.md in this directory for
 * the behavioral contract behind every method; each rule there corresponds
 * to a shipped data-loss bug in the previous implementation.
 */
import type { PatientRecord } from '../types/record'

/** Why the kernel refused to auto-adopt the localStorage mirror. */
export interface MirrorRefusal {
  mirrorCount: number
  expectedCount: number | null
  stale: boolean
  mirrorAt: string | null
  newest: string | null
}

export interface StorageHealth {
  refusal: MirrorRefusal | null
  mirrorStale: boolean
  liveCount: number
  mirrorCount: number | null
  mirrorAt: string | null
  mirrorWouldLoseRecords: boolean
}

export interface RecordsStore {
  /** Non-deleted records. */
  getActive(): Promise<PatientRecord[]>
  /** Every record including tombstones. Runs the recovery machine when uncached. */
  getAll(): Promise<PatientRecord[]>
  /**
   * Save one record under the single-writer lock. Stamps savedAt, resolves
   * deviceId, bumps sync_version (spread-merge on existing id, preserving
   * unknown fields), initializes versioning on new ids. Returns the
   * refreshed active list. THROWS on wipe guard or total write failure.
   */
  save(record: PatientRecord): Promise<PatientRecord[]>
  /** Tombstone: deleted = true, sync_version bump, savedAt untouched. */
  softDelete(id: string): Promise<PatientRecord[]>
  /** Locked read-patch-write of one row; bumps sync_version AND savedAt. False if id unknown. */
  update(id: string, patch: (r: PatientRecord) => PatientRecord): Promise<boolean>
  /**
   * Sync engine entry point: under the lock, fn receives all records
   * (including tombstones), mutates freely, and returns exactly the rows it
   * changed; the kernel persists those rows plus sidecar/mirror once.
   */
  mutate<T>(fn: (all: PatientRecord[]) => MutationResult<T> | Promise<MutationResult<T>>): Promise<T>
  /** Cross-tab lock outside, per-tab promise mutex inside. */
  withLock<T>(fn: () => Promise<T> | T): Promise<T>
  /** Persist specific rows + sidecar/mirror. ONLY call inside withLock. */
  persist(changed: PatientRecord[]): Promise<void>
  /** Drop the in-memory cache; next read hits storage. */
  invalidate(): void
  /** Non-null after a read that refused the stale/short mirror. */
  mirrorRefusal(): MirrorRefusal | null
  /** Explicit, human-confirmed adoption of the mirror copy. Returns count. */
  adoptMirror(): Promise<number>
  /** Another tab wrote; our cache was invalidated. Returns unsubscribe. */
  onExternalWrite(cb: () => void): () => void
}

export interface MutationResult<T> {
  changed: PatientRecord[]
  result: T
}

/** Settings/config KV on the keyval store with localStorage dual-write. */
export interface KV {
  get<T>(key: string): Promise<T | null>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}
