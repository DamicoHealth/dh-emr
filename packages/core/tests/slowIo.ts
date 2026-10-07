/**
 * Opt-in slow-storage mode for the suite: DH_SLOW_IO=1 (delay in ms via
 * DH_SLOW_IO_MS, default 15). Loads for every suite like setup.ts and does
 * NOTHING unless the variable is set.
 *
 * Why: the UI renders most content only after an async read from the
 * kernel (records list, config, the template library). A test that awaits
 * one marker and then queries later content synchronously passes on a fast
 * laptop and fails on a slow CI runner (the first deploy run of the public
 * repo failed exactly this way). Delaying every async kernel call makes
 * that race deterministic locally, so `npm run test:slow` finds such tests
 * before GitHub does.
 *
 * The delay uses the real setTimeout captured here, before any test
 * installs fake timers, so fake-timer suites are not stalled by it.
 *
 * 15 ms is enough to surface every race found so far. Much above ~30 ms
 * the heaviest suites (the Clinic demo's scripted activity walks hundreds
 * of storage calls) hit the 5 s test timeout, which is not a race.
 */
import { config, records, settings } from '../src/kernel'

const { env } = (await import('node:process' as string)) as { env: Record<string, string | undefined> }

const realSetTimeout = globalThis.setTimeout.bind(globalThis)

/** Sync members of the kernel objects: never wrapped. */
const SYNC = new Set(['invalidate', 'mirrorRefusal', 'onExternalWrite', 'withLock'])

function slowDown(target: object, delayMs: number): void {
  const obj = target as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    const fn = obj[key]
    if (typeof fn !== 'function' || SYNC.has(key)) continue
    obj[key] = (...args: unknown[]) =>
      new Promise<void>((resolve) => realSetTimeout(resolve, delayMs)).then(() =>
        (fn as (...a: unknown[]) => unknown).apply(obj, args),
      )
  }
}

if (env.DH_SLOW_IO) {
  const delayMs = Number(env.DH_SLOW_IO_MS ?? 15)
  slowDown(records, delayMs)
  slowDown(config, delayMs)
  slowDown(settings, delayMs)
}
