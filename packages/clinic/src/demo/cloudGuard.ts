/**
 * Demo safety law 4 for the Clinic demo build: the demo can never sync.
 *
 * The demo build is the real Clinic shell served at a public URL under its
 * own storage namespace (-clinic-demo). Without this guard a visitor could
 * type a real project's address and key into the demo's Settings cloud
 * card and run an actual clinic on the demo URL, whose namespace the
 * seeder resets. So every connect/verify entry point is neutered at the
 * engine seam: each returns a refusal whose message is the note the visitor
 * sees ("not available in the demo"), and credential writes become no-ops.
 * Installed once at demo boot (bootDemo in index.ts), before the seed;
 * never imported by production code paths.
 */
import { syncEngine } from '@dh/core/sync'

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
