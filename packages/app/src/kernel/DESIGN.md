# Storage kernel v2 - design contract

The rebuild of the hardened storage layer. The OLD kernel stored all records
as ONE array under one IndexedDB key with a full localStorage mirror; the NEW
kernel uses a per-record object store. The implementation changes freely; the
INVARIANTS below are the product and every one of them was a shipped data-loss
bug. ES modules throughout - no window globals, no eval loading.

## Storage layout

IndexedDB database `dh-emr-db` + suffix, DB_VERSION 2:
- object store `records`, keyPath `id` - one row per PatientRecord,
  INCLUDING tombstones (deleted: true). Saves are O(1) single-row puts.
- object store `keyval`, out-of-line keys - settings and config, same key
  names as v1 (`dhemr{suffix}_setting_*`, config under plain names). Version 1
  databases (the old app) had ONLY `keyval`; on upgrade to 2, create `records`
  and run a one-time migration: if a legacy whole-array blob exists under
  keyval key `dhemr{suffix}_records` and the records store is empty, copy each
  element into the records store, then leave the blob in place (read-only
  safety copy; never delete it).

localStorage (prefix `dhemr{suffix}_`):
- `dhemr_records` - BOUNDED mirror: JSON array of the newest MIRROR_LIMIT
  (500) records by savedAt (string compare), including tombstones. Same key
  as the legacy full mirror so old devices recover through the same path.
- `dhemr_records_meta` - sidecar `{ count, newest, at }` where count is the
  FULL store row count (including tombstones), newest is the max savedAt
  across ALL rows, at is the write time ISO. Written only in the same step as
  a successful mirror write.
- `dhemr_records_mirror_stale` - literal '1' when the last mirror write
  failed; removeItem on every successful mirror write.

Namespacing: suffix comes from the build define `__DH_STORAGE_SUFFIX__`
(fallback ''). ONE function computes the prefix and db name; nothing else
recomputes it. Production is ''. A test asserts the default is ''.

navigator.storage.persist() is requested once at kernel init, best-effort.

## Invariants (each was a live data-loss incident)

1. SINGLE WRITER. Every mutation goes through withLock: cross-tab
   navigator.locks mutex named 'dh-emr-records' OUTSIDE, per-tab promise
   mutex INSIDE. The per-tab chain never poisons: `.then(fn, fn)` semantics,
   a rejection propagates to the caller but the next writer still runs.
   BroadcastChannel 'dh-emr-records-changed' message `{ t: <epoch ms> }`
   invalidates other tabs' caches; invalidate own cache on lock ENTRY,
   announce AFTER the mutation while still holding the lock. Presence
   channel 'dh-emr-presence' with {kind:'ping'}/{kind:'pong'} detects other
   tabs when Web Locks is unavailable.
2. WIPE GUARD. If the last full read did not complete cleanly
   (loadOk false) AND the working set is empty, save() THROWS with a message
   containing 'could not be read' (tests match /could not be read/i).
   Unreadable must never look like empty.
3. RECOVERY NEVER TRUSTS A STALE COPY. On a read finding the records store
   EMPTY: consult the localStorage mirror. Decision table:
   - no mirror -> legitimately fresh device, loadOk = true.
   - mirror present, stale flag set OR mirror.length < sidecar.count OR
     reading the flag THREW -> REFUSE: expose
     mirrorRefusal() = { mirrorCount, expectedCount, stale, mirrorAt,
     newest }, treat the store as UNREADABLE (loadOk = false) so the wipe
     guard blocks saving, and return []. (iOS eviction reads as successful
     and empty; this line is what catches it.)
   - mirror present, fresh and not short (or NO sidecar at all - a legacy
     device; expectedCount null means short = false) -> adopt silently,
     write the rows back into the records store (best-effort repair).
   mirrorRefusal resets to null at the top of EVERY uncached read.
   adoptMirror() is the explicit human-confirmed path: under withLock,
   re-reads the mirror, throws Error('There is no local backup copy on this
   device to recover from.') when absent/empty, writes rows through the
   normal persist path, clears the refusal, returns the count.
4. LOUD SAVE FAILURES. persist path: put row(s) into the records store
   (idbOk), rewrite mirror+sidecar (mirrorOk). If BOTH fail, THROW
   'Could not save to this device’s storage - both the database and the
   local backup failed to write. The device may be out of space or in a
   private-browsing window. Your entry was NOT saved.'
   (U+2019 apostrophe in device's; plain hyphens only.) After a successful
   in-memory update the wipe-guard condition clears (we hold an
   authoritative copy) even if the IDB write failed.
5. SAVE SEMANTICS. save(record) under withLock:
   - stamps record.savedAt = new Date().toISOString() ALWAYS
   - deviceId: keep record.deviceId, else current device id, else mint
     crypto.randomUUID() and console.warn (never a shared default)
   - existing id: merged = { ...old, ...record, sync_version: (old.sync_version || 1) + 1 }
     (spread-merge preserves unknown/extra fields and synced_version)
   - new id: sync_version = 1, synced_version = 0
   - returns the refreshed ACTIVE list (non-deleted), like the old kernel.
6. SOFT DELETE. softDelete(id): set deleted = true, bump sync_version,
   DO NOT touch savedAt. Missing id is a silent no-op. getActive() filters
   tombstones; getAll() includes them.
7. update(id, patchFn): under withLock, apply patch to the stored row, bump
   sync_version AND savedAt. Returns false when the id is unknown.
8. mutate(fn): under withLock, fn(allIncludingTombstones) returns the array
   of records it CHANGED (or []); kernel persists exactly those rows plus
   sidecar/mirror once. This is the sync engine's entry point.
9. CACHE. In-memory cache of the full array (including tombstones); any
   uncached read runs the recovery machine; invalidate() drops it. Reads
   dedupe concurrent callers through one in-flight promise.
10. STORAGE HEALTH for the UI: readStorageHealth() reporting refusal,
    mirrorStale, liveCount, mirrorCount, mirrorAt, and
    mirrorWouldLoseRecords computed against min(liveCount, MIRROR_LIMIT)
    with slack max(25, 5% of liveCount). A bounded mirror on a big store is
    HEALTHY by design (the warning must not cry wolf at
    liveCount > MIRROR_LIMIT); the alarm conditions are the stale flag, a
    refusal, or the mirror running short of what it SHOULD hold.
    storageEmergency()/storageWarning() user strings: plain language, name
    the counts, tell the user to restore from a backup file FIRST and only
    then adopt the older copy. No em dashes.

## Module layout (all under src/kernel/)

- namespace.ts - suffix/prefix/dbName, MIRROR_LIMIT
- idb.ts - open (v2 + upgrade/migration), typed row ops, keyval ops;
  reads THROW when storage is unreadable (never resolve null on failure)
- locks.ts - per-tab mutex, cross-tab lock, broadcast, presence
- records.ts - the store: cache, recovery machine, save/softDelete/update/
  mutate/getAll/getActive/adoptMirror/mirrorRefusal/invalidate/
  onExternalWrite, mirror+sidecar persistence
- settings.ts - getSetting/setSetting on keyval with localStorage
  dual-write fallback (same 'setting_' key convention as v1)
- health.ts - StorageHealth + message builders
- index.ts - public API surface re-exports

## Test files owned by the kernel

tests/setup.ts (fake-indexeddb/auto, Map-backed localStorage polyfill on
globalThis AND window, resetStorage() that empties via the kernel's own
locked path - NEVER indexedDB.deleteDatabase), tests/mirrorGuard.test.ts,
tests/invariants.test.ts, tests/bench.test.ts - ported from the reference
with expectations adapted to the per-record store (e.g. eviction in tests =
clear the records store via the test's own IDB handle + invalidate();
planting a mirror stays identical since the localStorage contract is
unchanged; the invariants suite keeps: round trip, no-silent-field-loss
including an extra unknown field, mirror written after save, versioning,
tombstone semantics, mutex serialization 2 / 25-burst / mixed
mutate-vs-save, namespace default '').
