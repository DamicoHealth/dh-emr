/**
 * Import records exported straight out of a Supabase project.
 *
 * This exists so an organization can leave a cloud project behind - a leaked
 * key, a migration, a new host - without abandoning the records in it.
 * Export the rows, stand up a fresh project, import, carry on.
 *
 * The conversion is NOT reimplemented here. supabaseRowToRecord in
 * src/sync/mapping is the same function every pull has always used, so it is
 * the most exercised code in the system; a second implementation would be a
 * second chance to get a lab result or a medication array subtly wrong.
 *
 * Everything then goes through restoreFromData, which already owns the rules
 * that matter: newer-wins merging, a local deletion always standing, records
 * re-stamped to this device so they can actually upload, and a wipe guard.
 */
import type { PatientRecord } from '../types/record'
import { supabaseRowToRecord } from '../sync/mapping'
import { getDeviceId } from '../sync/device'
import { restoreFromData, type RestoreResult } from './backup'

/** What a Supabase row looks like: snake_case, JSONB columns already parsed. */
type CloudRow = Record<string, unknown>

export type ImportShape = 'app-backup' | 'supabase-rows' | 'unknown'

/**
 * Work out what was handed to us.
 *
 * Deliberately structural rather than trusting a filename or a wrapper key:
 * the cost of guessing wrong is importing nothing, or worse, importing
 * garbage into a patient database.
 */
export function detectShape(data: unknown): ImportShape {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const o = data as Record<string, unknown>
    if (o.app === 'DH Field EMR' && Array.isArray(o.records)) return 'app-backup'
    // Supabase's own export sometimes wraps the array.
    if (Array.isArray(o.data)) return detectShape(o.data)
    if (Array.isArray(o.records)) return detectShape(o.records)
  }
  if (Array.isArray(data)) {
    const first = data.find((r) => r && typeof r === 'object') as CloudRow | undefined
    if (!first) return 'unknown'
    // A cloud row is snake_case; an app record is camelCase. Either key alone
    // could be absent on a sparse row, so test for any of them.
    const cloudish = ['device_id', 'saved_at', 'sync_version', 'given_name', 'chief_concern'].some(
      (k) => k in first,
    )
    if (cloudish) return 'supabase-rows'
    if ('id' in first) return 'app-backup' // a bare array of app records
  }
  return 'unknown'
}

/** Pull the row array out of whatever wrapper it arrived in. */
function unwrap(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const o = data as Record<string, unknown>
    if (Array.isArray(o.data)) return o.data
    if (Array.isArray(o.records)) return o.records
  }
  return []
}

export interface CloudImportResult extends RestoreResult {
  shape: ImportShape
  /** Rows that could not be converted, with the reason. Never silently dropped. */
  rejected: { index: number; reason: string }[]
}

/**
 * Convert Supabase rows into app records.
 *
 * A row missing an id is rejected rather than given one: an invented id
 * makes the record un-mergeable with the same encounter arriving from
 * anywhere else, so the patient quietly ends up with two of everything.
 */
export function rowsToRecords(rows: unknown[]): {
  records: PatientRecord[]
  rejected: { index: number; reason: string }[]
} {
  const records: PatientRecord[] = []
  const rejected: { index: number; reason: string }[] = []
  rows.forEach((row, index) => {
    if (!row || typeof row !== 'object') {
      rejected.push({ index, reason: 'not a record' })
      return
    }
    const r = row as CloudRow
    if (!r.id) {
      rejected.push({ index, reason: 'no id' })
      return
    }
    try {
      records.push(supabaseRowToRecord(r))
    } catch (e) {
      rejected.push({ index, reason: e instanceof Error ? e.message : String(e) })
    }
  })
  return { records, rejected }
}

/**
 * Import an export file, whichever of the two shapes it is.
 *
 * `includeConfig` is only honoured for an app backup; a Supabase records
 * export carries no settings.
 */
export async function importCloudExport(
  data: unknown,
  opts: { includeConfig?: boolean } = {},
): Promise<CloudImportResult> {
  const shape = detectShape(data)

  if (shape === 'app-backup') {
    const r = await restoreFromData(data, opts)
    return { ...r, shape, rejected: [] }
  }

  if (shape === 'supabase-rows') {
    // This device must have an identity BEFORE the import, because that is
    // what restoreFromData re-stamps each record with. Without one the
    // records keep the old project's device id, and the new project's RLS
    // rejects every upload from a device it has never heard of - so they
    // would sit pending forever with nothing to explain why. Finish setup
    // first.
    if (!(await getDeviceId())) {
      throw new Error(
        'Finish setting up this device before importing. Imported records are filed under this ' +
          'device, and until it has been set up there is nothing to file them under.',
      )
    }
    const { records, rejected } = rowsToRecords(unwrap(data))
    if (!records.length) {
      throw new Error('That file has rows in it, but none of them could be read as patient records.')
    }
    // Hand restoreFromData an envelope in its own format, so every rule it
    // enforces applies to a cloud import exactly as it does to a backup.
    const r = await restoreFromData({
      app: 'DH Field EMR',
      backupVersion: 1,
      exportedAt: new Date().toISOString(),
      recordCount: records.length,
      records,
      config: {},
    })
    return { ...r, shape, rejected }
  }

  throw new Error(
    'That file was not recognised. It should be either a backup downloaded from this app, ' +
      'or the records exported from a Supabase project.',
  )
}

export async function importCloudFile(
  file: File,
  opts: { includeConfig?: boolean } = {},
): Promise<CloudImportResult> {
  const text = await file.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      'That file is not valid JSON. Export as JSON rather than CSV: CSV flattens the lab results and medication lists into text and they cannot be read back reliably.',
    )
  }
  return importCloudExport(parsed, opts)
}
