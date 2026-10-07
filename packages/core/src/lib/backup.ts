/**
 * Backup and restore - the offline safety net.
 *
 * File format is unchanged from the previous apps (packages/pwa/backup.js and
 * the React port), so a backup taken on any of them restores into this one
 * and vice versa.
 *
 * ONE DELIBERATE CHANGE carried over from the React port: the original legacy
 * restore overwrote a local record with the backup's copy unconditionally, so
 * restoring an older file could silently undo newer work and RESURRECT
 * records deleted since. This restore is conflict-aware: the newer savedAt
 * wins, and a newer local delete is not undone.
 */
import type { PatientRecord } from '../types/record'
import {
  config as configKv,
  records,
  settings as settingsKv,
  storagePrefix,
} from '../kernel'
import { getDeviceId } from '../sync/device'
import { todayLocal } from '../domain/today'

/** Never leave the device in a backup file: credentials, device identity. */
const SENSITIVE = /deviceId|supabase|password|adminPassword|_idb_migrated/i

/**
 * Kernel-internal mirror state. Not org config: carrying a stale sidecar
 * into a restored device could make the recovery machine distrust a healthy
 * store. Excluded from both gather and restore.
 */
function isMirrorStateKey(k: string, prefix: string): boolean {
  return (
    k === prefix + 'records' ||
    k === prefix + 'records_meta' ||
    k === prefix + 'records_mirror_stale'
  )
}

export interface BackupFile {
  app: string
  backupVersion: number
  exportedAt: string
  recordCount: number
  records: PatientRecord[]
  config: Record<string, unknown>
}

export async function gatherBackup(): Promise<BackupFile> {
  const prefix = storagePrefix()
  // Snapshot: getAll() hands back the kernel's live cache array, and a
  // BackupFile held across later saves must not silently grow with them.
  const allRecords = [...(await records.getAll())]
  const config: Record<string, unknown> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (!k || !k.startsWith(prefix) || isMirrorStateKey(k, prefix) || SENSITIVE.test(k)) continue
    try {
      config[k] = JSON.parse(localStorage.getItem(k) as string)
    } catch {
      config[k] = localStorage.getItem(k)
    }
  }
  return {
    app: 'DH Field EMR',
    backupVersion: 1,
    exportedAt: new Date().toISOString(),
    recordCount: allRecords.length,
    records: allRecords,
    config,
  }
}

export async function downloadBackup(): Promise<number> {
  const data = await gatherBackup()
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `dh-emr-backup-${todayLocal()}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  return data.recordCount
}

export interface RestoreResult {
  added: number
  updated: number
  skipped: number
  total: number
  configRestored: boolean
}

export interface RestoreOptions {
  /**
   * Also overwrite this device's form schema, sites, providers and formulary
   * with the ones in the file.
   *
   * Defaults to FALSE, and that default matters. Config was previously
   * restored unconditionally, with none of the newer-wins comparison the
   * records path uses. Restoring a month-old backup onto an admin device
   * silently reverted the org's form for everyone the moment that device
   * next pushed config.
   */
  includeConfig?: boolean
}

/**
 * Decide whether the incoming (backup) copy should replace the local one.
 * Newer savedAt wins; ties keep local. A local delete that is newer than the
 * backup copy stands, so restoring an old file cannot bring back a record
 * the team deleted afterwards.
 */
export function shouldReplace(local: PatientRecord | undefined, incoming: PatientRecord): boolean {
  if (!local) return true
  // A local DELETION always stands.
  //
  // The kernel's softDelete bumps sync_version but leaves savedAt at its
  // pre-delete value, so a tombstone can easily carry an OLDER savedAt than
  // a backup copy taken while the visit was still live. Comparing savedAt
  // alone then let a restore un-delete it - and the sync_version bump pushed
  // that resurrection out to the whole fleet. A deliberate deletion must not
  // be undone by restoring a backup.
  if (local.deleted && !incoming.deleted) return false
  const l = local.savedAt || ''
  const i = incoming.savedAt || ''
  if (!l && !i) return false
  return i > l
}

/** Merge a backup into the local store, through the single-writer lock. */
export async function restoreFromData(
  data: unknown,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  // Whose device id do restored records carry? It must be THIS one.
  //
  // The project's RLS requires the record's device_id to exist in ITS
  // devices table, and the push sends the record's OWN deviceId. A backup
  // from a standalone or de-registered device therefore carries an id this
  // project has never seen, so every upsert 403s forever - the records sit
  // pending permanently and the backup alarm never clears. Re-stamping is
  // also honest: this device is the one responsible for getting them to the
  // cloud now. The original id stays in the backup file.
  const ownDeviceId = await getDeviceId()
  const file = data as BackupFile
  // Validate the envelope, not just the shape: merging an arbitrary JSON
  // file with a `records` array into the patient store is permanent.
  if (!file || !Array.isArray(file.records) || file.app !== 'DH Field EMR') {
    throw new Error('That is not a DH Field EMR backup file.')
  }
  if (typeof file.backupVersion !== 'number' || file.backupVersion > 1) {
    throw new Error('That backup was made by a newer version of the app. Update this device first.')
  }
  let added = 0
  let updated = 0
  let skipped = 0
  const touched = new Set<string>()

  await records.mutate((all) => {
    // WIPE GUARD. The kernel distinguishes "unreadable" from "genuinely
    // empty", but that distinction is internal. If we see zero records while
    // its sidecar says the device had some, the store is unreadable right now
    // and a wholesale replace would destroy them. Refuse rather than
    // overwrite.
    if (all.length === 0) {
      try {
        // EXCEPT when the kernel has already diagnosed this device.
        //
        // A non-null mirrorRefusal means the kernel positively knows the
        // store was evicted AND the local mirror is too far behind to trust.
        // In that state restoring a backup is not a risk, it is the remedy -
        // and the app is actively telling the user to do it. Without this
        // exemption the two guards deadlock: saving is blocked by the wipe
        // guard and restoring is blocked by this one, with no way out of
        // either.
        const refused = records.mirrorRefusal()
        const meta = localStorage.getItem(storagePrefix() + 'records_meta')
        const count = meta ? ((JSON.parse(meta) as { count?: number }).count ?? 0) : 0
        if (count > 0 && !refused) {
          throw new Error(
            `This device is reporting no records, but it previously held ${count}. ` +
              'Restoring now could overwrite them. Close and reopen the app, check the ' +
              'records list, and try again.',
          )
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('This device is reporting')) throw e
        // A malformed sidecar is not itself a reason to block the restore.
      }
    }
    const byId = new Map(all.map((r) => [r.id, r]))
    for (const incoming of file.records) {
      if (!incoming || !incoming.id) continue
      const local = byId.get(incoming.id)
      const claimed = ownDeviceId ? { ...incoming, deviceId: ownDeviceId } : incoming
      if (!local) {
        byId.set(incoming.id, claimed)
        touched.add(incoming.id)
        added++
        continue
      }
      if (shouldReplace(local, incoming)) {
        byId.set(incoming.id, claimed)
        touched.add(incoming.id)
        updated++
      } else {
        skipped++
      }
    }
    // Replace the array contents in place; the kernel persists the changed
    // rows plus mirror/sidecar.
    all.length = 0
    all.push(...byId.values())

    // Everything the restore touched must be re-uploaded.
    //
    // Two reasons. First, a record carried in from a backup may never have
    // reached THIS device's cloud project at all, yet arrives with
    // synced_version already equal to sync_version and so looks uploaded.
    // Second, the engine's push does its network calls outside the lock and
    // then re-locks to stamp synced_version from the version it snapshotted;
    // a restore landing in that window would have its records stamped as
    // uploaded when they never were. Bumping sync_version here makes any
    // such late stamp land BELOW the current version, so the record stays
    // pending.
    const changed: PatientRecord[] = []
    for (const r of all) {
      if (!touched.has(r.id)) continue
      r.sync_version = Math.max(r.sync_version ?? 1, r.synced_version ?? 0) + 1
      changed.push(r)
    }
    return { changed, result: undefined }
  })

  // Restore non-sensitive config (form templates, presets, formulary,
  // sites...) ONLY when explicitly asked. See RestoreOptions.includeConfig.
  const prefix = storagePrefix()
  let configRestored = false
  if (opts.includeConfig && file.config && typeof file.config === 'object') {
    configRestored = true
    for (const k of Object.keys(file.config)) {
      if (!k.startsWith(prefix) || isMirrorStateKey(k, prefix) || SENSITIVE.test(k)) continue
      try {
        // gatherBackup JSON.parsed these, and every reader JSON.parses again,
        // so they must be re-encoded. Writing a bare string back corrupted
        // deviceName / role / standaloneMode on a fresh device. The KV
        // dual-writes the JSON-encoded copy to localStorage and the raw value
        // to the keyval store, so both read paths see the restored value.
        const bare = k.slice(prefix.length)
        if (bare.startsWith('setting_')) {
          await settingsKv.set(bare.slice('setting_'.length), file.config[k])
        } else {
          await configKv.set(bare, file.config[k])
        }
      } catch {
        /* quota */
      }
    }
  }

  const total = (await records.getAll()).length
  return { added, updated, skipped, total, configRestored }
}

export async function restoreFromFile(
  file: File,
  opts: RestoreOptions = {},
): Promise<RestoreResult> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  return restoreFromData(parsed, opts)
}
