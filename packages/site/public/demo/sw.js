/**
 * Kill switch for the RETIRED demo worker.
 *
 * Before 2026-10-07 damicohealth.com served a single-product demo at
 * /demo/ with a workbox service worker registered at this exact URL and
 * scope (/demo/). That scope covers the new demo hub and both new demos
 * (/demo/field/, /demo/clinic/), so a browser that ever opened the old
 * demo keeps serving its cached index.html for every navigation under
 * /demo/: "the Clinic demo opens the old Field demo".
 *
 * Browsers re-fetch a registered worker's script on navigation (at most
 * once a day) and install any byte-different version. This file is that
 * version: it takes over at once, drops the old worker's caches (only the
 * ones named for this scope; the new demos' caches end in /demo/field/
 * and /demo/clinic/), unregisters itself, and reloads every open tab so
 * it loads the new site from the network. A browser that never had the
 * old worker never fetches this file. Keep it for at least a year.
 */
self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim()
      const scope = self.registration.scope
      const names = await caches.keys()
      await Promise.all(names.filter((n) => n.endsWith(scope)).map((n) => caches.delete(n)))
      await self.registration.unregister()
      const tabs = await self.clients.matchAll({ type: 'window' })
      await Promise.all(tabs.map((tab) => tab.navigate(tab.url).catch(() => undefined)))
    })(),
  )
})
