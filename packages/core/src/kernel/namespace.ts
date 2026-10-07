/**
 * THE one place the storage namespace is computed. Nothing else in the app
 * may rebuild these strings: the old kernel computed the prefix in four
 * places and a drift between them would point a build at an empty database
 * and look exactly like total data loss.
 *
 * The suffix comes from the build define __DH_STORAGE_SUFFIX__ (vite.config
 * `define`), falling back to ''. Production is ALWAYS '' - demo/preview
 * builds set '-demo'/'-react' so they never share a patient database with
 * production on the same origin. A test asserts the default is ''.
 */

declare const __DH_STORAGE_SUFFIX__: string | undefined

/** Newest-N bound on the localStorage mirror (records, by savedAt). */
export const MIRROR_LIMIT = 500

export function storageSuffix(): string {
  return typeof __DH_STORAGE_SUFFIX__ === 'string' ? __DH_STORAGE_SUFFIX__ : ''
}

/** localStorage / keyval key prefix, e.g. 'dhemr_' in production. */
export function storagePrefix(): string {
  return 'dhemr' + storageSuffix() + '_'
}

/** IndexedDB database name, e.g. 'dh-emr-db' in production. */
export function dbName(): string {
  return 'dh-emr-db' + storageSuffix()
}

/**
 * Key of the records mirror in localStorage AND of the legacy v1 whole-array
 * blob in the keyval store. Same name on purpose: old devices recover
 * through the same path.
 */
export function recordsKey(): string {
  return storagePrefix() + 'records'
}

/** Sidecar { count, newest, at } written only alongside a successful mirror write. */
export function recordsMetaKey(): string {
  return storagePrefix() + 'records_meta'
}

/** Literal '1' when the last mirror write failed; removed on every success. */
export function mirrorStaleKey(): string {
  return storagePrefix() + 'records_mirror_stale'
}
