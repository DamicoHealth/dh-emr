/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// DH_STORAGE_SUFFIX namespaces localStorage and IndexedDB per deployment.
// Production gets the bare prefix; demo/preview/staging builds MUST set a
// suffix or they share a patient database with production on the same
// origin (this was a live incident in the old app).
const storageSuffix = process.env.DH_STORAGE_SUFFIX ?? ''
const demoMode = process.env.DH_DEMO === '1'

export default defineConfig({
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
    // No runtime caching on purpose: the app is offline-first through
    // IndexedDB; the worker only precaches the app shell.
    VitePWA({
      registerType: demoMode ? 'autoUpdate' : 'prompt',
      // Registration goes through src/sw/register.ts (started by the
      // UpdateBar mount) so both builds share one guarded code path.
      injectRegister: false,
      manifest: {
        name: 'DH EMR',
        short_name: 'DH EMR',
        description: 'Offline-first clinic records',
        // --bg from src/styles/tokens.css; matches index.html theme-color.
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
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
