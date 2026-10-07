/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// DH_STORAGE_SUFFIX namespaces localStorage and IndexedDB per deployment
// (REBUILD-HANDOFF section 4.1 invariant 5: IndexedDB is origin-scoped, not
// path-scoped, and two builds on one origin WILL share a patient database
// unless namespaced - a live incident in the old app).
//
// CLINIC PRODUCTION IS '-clinic', NOT THE BARE PREFIX. DH EMR Field and
// DH EMR Clinic are two separate products that an organization may install
// side by side on the same device (Field is the paper-entry backup app for
// a Clinic org whose backend is down). Field keeps the bare production
// prefix (dhemr_ / dh-emr-db) for continuity with every device already in
// service; Clinic takes '-clinic' (dhemr-clinic_ / dh-emr-db-clinic) so the
// two never read or write each other's records, settings, device identity
// or auth session. The demo build sets its own suffix ('-clinic-demo').
const storageSuffix = process.env.DH_STORAGE_SUFFIX ?? '-clinic'
const demoMode = process.env.DH_DEMO === '1'

// Shared core. Every app shell imports it through the @dh/core/* alias,
// which resolves straight into packages/core/src (no build step, no package
// export map). Keep this in step with tsconfig.json "paths".
const coreSrc = fileURLToPath(new URL('../core/src/', import.meta.url))

export default defineConfig({
  resolve: {
    alias: [{ find: /^@dh\/core\/(.*)$/, replacement: `${coreSrc}$1` }],
  },
  plugins: [
    react(),
    // Two service worker stories (REBUILD-HANDOFF sections 7 and 8):
    //  - Clinical build: 'prompt'. The waiting worker sits until the user
    //    clicks "Update now" in the UpdateBar; an update must never reload
    //    the app mid-encounter. An unannounced release sitting untaken is
    //    the accepted consequence, not a bug.
    //  - Demo build (DH_DEMO=1): 'autoUpdate' with skipWaiting+clientsClaim
    //    baked into the worker, so returning visitors never evaluate a
    //    stale build.
    // No runtime caching on purpose: the app shell is precached and the
    // records live in IndexedDB; Clinic expects a constant connection for
    // everything else.
    VitePWA({
      registerType: demoMode ? 'autoUpdate' : 'prompt',
      // Registration goes through core/sw/register.ts (started by the
      // UpdateBar mount) so both builds share one guarded code path.
      injectRegister: false,
      manifest: {
        name: 'DH EMR Clinic',
        short_name: 'DH EMR Clinic',
        description: 'Live clinic records with staff accounts and a patient-flow board',
        // --bg from core/styles/tokens.css; matches index.html theme-color.
        theme_color: '#f7f8fa',
        background_color: '#f7f8fa',
        display: 'standalone',
        icons: [
          // Solid --primary teal square, white cross; generated PNGs in
          // public/. Full-bleed background keeps the same art safe as a
          // maskable icon.
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        skipWaiting: demoMode,
        clientsClaim: demoMode,
      },
    }),
  ],
  define: {
    __DH_STORAGE_SUFFIX__: JSON.stringify(storageSuffix),
    __DH_DEMO__: JSON.stringify(demoMode),
  },
  test: {
    environment: 'jsdom',
    // The storage harness (fake-indexeddb + Map-backed localStorage +
    // resetStorage) is shared from core; shells never carry a second copy.
    setupFiles: ['../core/tests/setup.ts', '../core/tests/slowIo.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
