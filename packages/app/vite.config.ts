/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// DH_STORAGE_SUFFIX namespaces localStorage and IndexedDB per deployment.
// Production gets the bare prefix; demo/preview/staging builds MUST set a
// suffix or they share a patient database with production on the same
// origin (this was a live incident in the old app).
const storageSuffix = process.env.DH_STORAGE_SUFFIX ?? ''
const demoMode = process.env.DH_DEMO === '1'

export default defineConfig({
  plugins: [react()],
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
