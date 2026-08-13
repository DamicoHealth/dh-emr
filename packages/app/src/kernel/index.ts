/**
 * Public surface of the storage kernel. Everything downstream imports from
 * here; nothing outside src/kernel touches IndexedDB or the localStorage
 * mirror directly.
 */
export type { KV, MirrorRefusal, MutationResult, RecordsStore, StorageHealth } from './api'
export { MIRROR_LIMIT, dbName, storagePrefix, storageSuffix } from './namespace'
export { DB_VERSION, KEYVAL_STORE, RECORDS_STORE } from './idb'
export {
  getCurrentDeviceId,
  hardResetRecords,
  records,
  setCurrentDeviceId,
} from './records'
export { config, getSetting, setSetting, settings } from './settings'
export { readStorageHealth, storageEmergency, storageWarning } from './health'
export {
  announceWrite,
  detectOtherTabs,
  hasCrossTabLock,
  onExternalWrite,
  withCrossTabLock,
  withTabLock,
} from './locks'
