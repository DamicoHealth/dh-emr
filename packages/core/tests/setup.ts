/**
 * Global test harness (vitest setupFiles - loads for EVERY suite, including
 * pure-function ones, so it must have no side effects beyond the storage
 * environment and must never throw outside storage use).
 *
 *  - fake-indexeddb backs the kernel's IndexedDB.
 *  - jsdom's localStorage is broken in this toolchain, and the mirror is a
 *    real durability path under test, not something to mock away - so a
 *    Map-backed spec-shaped Storage is installed on BOTH globalThis and
 *    window (the same object, so a test monkey-patching one patches both).
 *  - resetStorage() empties the store through the kernel's OWN locked path.
 *    We never indexedDB.deleteDatabase(): the kernel caches its open
 *    connection, so a delete blocks and leaves the cached handle pointing
 *    at a dead database.
 */
import 'fake-indexeddb/auto'
import { hardResetRecords, records } from '../src/kernel'

function installLocalStorage(): void {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(String(k)) ? map.get(String(k))! : null),
    setItem: (k: string, v: string) => {
      map.set(String(k), String(v))
    },
    removeItem: (k: string) => {
      map.delete(String(k))
    },
    clear: () => {
      map.clear()
    },
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      value: storage,
      configurable: true,
      writable: true,
    })
  }
}
installLocalStorage()

/** Reset to an empty record set between tests, through the kernel itself. */
export async function resetStorage(): Promise<void> {
  await hardResetRecords()
  records.invalidate()
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
}
