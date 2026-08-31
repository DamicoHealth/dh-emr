/**
 * SAFETY LAW 4 enforcement for demo builds: the demo can never sync.
 *
 * The seeder already forces standalone mode with null credentials, but the
 * Settings screen (and, if storage were cleared, the setup wizard) still
 * offer "connect to a cloud" flows. This module is owned by the demo build
 * and neuters those paths at the engine seam instead of forking the UI:
 * every connect/verify entry point returns a refusal whose message is the
 * "not available in the demo" note the user sees, and credential writes
 * become no-ops. Installed once at demo boot (see bootDemo in index.ts);
 * never imported by production code paths.
 */
import { syncEngine } from '../sync'

export const DEMO_CLOUD_MESSAGE =
  'Cloud sync is not available in the demo. This demo clinic is fictional ' +
  'and everything stays in this browser.'

export function installDemoCloudGuard(): void {
  const refuse = async (): Promise<{ ok: boolean; error?: string }> => ({
    ok: false,
    error: DEMO_CLOUD_MESSAGE,
  })
  syncEngine.connectToProject = refuse
  syncEngine.verifyTables = refuse
  syncEngine.seedConfig = refuse
  // Credentials can never be stored, even if some future path skips the
  // verify step above.
  syncEngine.updateCredentials = () => {}
}
