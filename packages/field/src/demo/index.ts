/**
 * Public surface of the demo module. main.tsx uses exactly two things in
 * DH_DEMO builds: bootDemo() before first render, and <DemoBanner /> above
 * the app shell. Everything else is exported for the demo tests.
 */
export {
  DEMO_DEVICE_ID,
  DEMO_DEVICE_NAME,
  DEMO_PROVIDERS,
  DEMO_SITES,
  SEED_FLAG,
  SEED_VERSION,
  buildDemoLibrary,
  buildDemoRecords,
  demoDaysAgo,
  djb2,
  isDemoBuild,
  resetDemo,
  seedDemo,
} from './seed'
export { DEMO_CLOUD_MESSAGE, installDemoCloudGuard } from './cloudGuard'
export { DemoBanner } from './DemoBanner'

import { installDemoCloudGuard } from './cloudGuard'
import { seedDemo } from './seed'

/**
 * Demo boot: neuter every cloud path first, then seed (idempotent per
 * SEED_VERSION). Called from main.tsx BEFORE the app renders, only when the
 * build set DH_DEMO.
 */
export async function bootDemo(): Promise<void> {
  installDemoCloudGuard()
  await seedDemo()
}
