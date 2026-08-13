/** Public surface of the sync module. */
export {
  BAD_URL_ERROR,
  EMPTY_KEY_ERROR,
  SERVER_KEY_ERROR,
  classifySupabaseKey,
  normalizeSupabaseUrl,
  supabaseHeaders,
} from './keys'
export type { KeyClassification, SupabaseKeyKind } from './keys'
export { mergeRecords, recordToSupabaseRow, supabaseRowToRecord } from './mapping'
export type { SupabaseRow } from './mapping'
export {
  LEGACY_SHARED_DEVICE_IDS,
  getDeviceId,
  getDeviceName,
  getDeviceRole,
  registerDevice,
  registerDeviceWithRole,
  renameDevice,
  setDeviceRole,
} from './device'
export type { DeviceContext, DeviceRole, RenameResult } from './device'
export { SYNC_LABELS, createSyncEngine, effectiveStatus, syncEngine } from './engine'
export type { SyncEngine, SyncEngineDeps, SyncLabel, SyncOutcome, SyncStatus } from './engine'
export { defaultTransport } from './transport'
export type { Transport } from './transport'
