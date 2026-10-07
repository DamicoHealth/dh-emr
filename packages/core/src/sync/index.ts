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
  ensureFleetRow,
  getDeviceId,
  getDeviceName,
  getDeviceRole,
  registerDevice,
  registerDeviceWithRole,
  renameDevice,
  setDeviceRole,
} from './device'
export type { DeviceContext, DeviceRole, RenameResult } from './device'
export {
  CLINIC_AUTO_SYNC_INTERVAL_MS,
  SYNC_LABELS,
  createSyncEngine,
  effectiveStatus,
  syncEngine,
} from './engine'
export type {
  AutoSyncOptions,
  ConfigPushPolicy,
  SyncEngine,
  SyncEngineDeps,
  SyncLabel,
  SyncOutcome,
  SyncStatus,
} from './engine'
export {
  LIVE_LABEL,
  REALTIME_BACKOFF_BASE_MS,
  REALTIME_BACKOFF_CAP_MS,
  REALTIME_CHANNEL_TOPIC,
  REALTIME_TABLES,
  createRealtimeTrigger,
  realtimeTrigger,
} from './realtime'
export type {
  PostgresChangesFilter,
  RealtimeChannelLike,
  RealtimeClientFactory,
  RealtimeClientLike,
  RealtimeStartOptions,
  RealtimeStatus,
  RealtimeSubscribeStatus,
  RealtimeTrigger,
  RealtimeTriggerDeps,
} from './realtime'
export { defaultTransport } from './transport'
export type { Transport } from './transport'
export {
  JOIN_LINK_MALFORMED_ERROR,
  JOIN_LINK_VERSION,
  JOIN_LINK_VERSION_ERROR,
  JOIN_PARAM,
  ORG_NAME_MAX,
  ORG_NAME_SETTING,
  currentAppUrl,
  defaultJoinedDeviceName,
  encodeJoinLink,
  joinProject,
  parseJoinLink,
  projectHost,
  readJoinLink,
  stripJoinParam,
} from './joinLink'
export type { JoinDeps, JoinLinkRead, JoinPayload, JoinResult } from './joinLink'
