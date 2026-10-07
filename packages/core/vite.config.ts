/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// @dh/core is never built or served on its own: this config exists ONLY so
// the shared test suite runs here exactly as it did before the split. The
// app shells (packages/field, packages/clinic) own the PWA plugin, the
// manifest, the service worker story and the real build defines.
//
// The two defines mirror what a plain production build sets, so every test
// sees the bare storage namespace ('' = production prefix, asserted by the
// kernel tests) and the user-gated (non-demo) update path.
export default defineConfig({
  plugins: [react()],
  define: {
    __DH_STORAGE_SUFFIX__: JSON.stringify(''),
    __DH_DEMO__: JSON.stringify(false),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['tests/setup.ts', 'tests/slowIo.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
})
