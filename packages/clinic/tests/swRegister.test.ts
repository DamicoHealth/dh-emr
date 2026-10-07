/**
 * Service worker registration wiring (core/src/sw/register.ts), run in the shell suite because only the shells carry the PWA plugin that resolves the virtual module. The virtual
 * module is injected through the loader seam; nothing here touches a real
 * worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetServiceWorkerForTests, startServiceWorker, type RegisterSW } from '@dh/core/sw/register'

type Opts = Parameters<RegisterSW>[0]

function fakeRegistration() {
  return { update: vi.fn(async () => {}) } as unknown as ServiceWorkerRegistration
}

describe('service worker registration', () => {
  beforeEach(() => {
    resetServiceWorkerForTests()
    vi.useFakeTimers()
    Object.defineProperty(window.navigator, 'serviceWorker', { value: {}, configurable: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('asks the browser for an update check as soon as the worker registers, then hourly', async () => {
    let opts: Opts | null = null
    const registerSW: RegisterSW = (o) => {
      opts = o
      return async () => {}
    }
    startServiceWorker(async () => ({ registerSW }))
    await vi.waitFor(() => expect(opts).not.toBeNull())
    expect(opts!.immediate).toBe(true)
    const reg = fakeRegistration()
    opts!.onRegisteredSW?.('/sw.js', reg)
    // Immediately: the once-a-day navigation check is too slow after a release.
    expect(reg.update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(reg.update).toHaveBeenCalledTimes(3)
  })

  it('registers once per boot: a second call (StrictMode, UpdateBar) is a no-op', async () => {
    const registerSW = vi.fn<RegisterSW>(() => async () => {})
    startServiceWorker(async () => ({ registerSW }))
    startServiceWorker(async () => ({ registerSW }))
    await vi.waitFor(() => expect(registerSW).toHaveBeenCalledTimes(1))
    expect(registerSW).toHaveBeenCalledTimes(1)
  })

  it('a failed update check is swallowed (offline is normal)', async () => {
    let opts: Opts | null = null
    startServiceWorker(async () => ({
      registerSW: (o) => {
        opts = o
        return async () => {}
      },
    }))
    await vi.waitFor(() => expect(opts).not.toBeNull())
    const reg = { update: vi.fn(async () => { throw new Error('offline') }) } as unknown as ServiceWorkerRegistration
    expect(() => opts!.onRegisteredSW?.('/sw.js', reg)).not.toThrow()
    await Promise.resolve()
    expect(reg.update).toHaveBeenCalledTimes(1)
  })
})
