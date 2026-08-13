/**
 * Settings and config KV on the keyval object store, with a localStorage
 * dual-write fallback. Key conventions are IDENTICAL to v1 so upgraded
 * devices find their data:
 *   - settings: `dhemr{suffix}_setting_<key>`
 *   - config:   `dhemr{suffix}_<key>` (plain names, e.g. dhemr_formulary)
 *
 * Semantics carried over from the old kernel:
 *   - set() writes BOTH copies, best-effort, errors swallowed.
 *   - get() reads IndexedDB first, falls back to localStorage JSON.parse,
 *     resolves null on failure. (Settings are recoverable config, not
 *     patient data - unlike records reads, failure here may resolve null.)
 */
import type { KV } from './api'
import { kvGet, kvRemove, kvSet } from './idb'
import { storagePrefix } from './namespace'

function makeKv(fullKey: (key: string) => string): KV {
  return {
    async get<T>(key: string): Promise<T | null> {
      const k = fullKey(key)
      try {
        const v = await kvGet(k)
        if (v !== null && v !== undefined) return v as T
      } catch {
        /* fall through to localStorage */
      }
      try {
        const raw = localStorage.getItem(k)
        return raw !== null ? (JSON.parse(raw) as T) : null
      } catch {
        return null
      }
    },
    async set(key: string, value: unknown): Promise<void> {
      const k = fullKey(key)
      try {
        await kvSet(k, value)
      } catch {
        /* best-effort */
      }
      try {
        localStorage.setItem(k, JSON.stringify(value))
      } catch (e) {
        console.warn('ls write fail', e)
      }
    },
    async remove(key: string): Promise<void> {
      const k = fullKey(key)
      try {
        await kvRemove(k)
      } catch {
        /* best-effort */
      }
      try {
        localStorage.removeItem(k)
      } catch {
        /* best-effort */
      }
    },
  }
}

/** Device/sync settings, keyed `dhemr{suffix}_setting_<key>`. */
export const settings: KV = makeKv((key) => storagePrefix() + 'setting_' + key)

/** Org config (sites, formulary, templates...), keyed `dhemr{suffix}_<key>`. */
export const config: KV = makeKv((key) => storagePrefix() + key)

export function getSetting<T>(key: string): Promise<T | null> {
  return settings.get<T>(key)
}

export function setSetting(key: string, value: unknown): Promise<void> {
  return settings.set(key, value)
}
