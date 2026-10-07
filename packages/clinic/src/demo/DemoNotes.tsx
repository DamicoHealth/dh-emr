/**
 * The small demo-only pieces the shell slots in through DemoAppHooks: the
 * note above Settings (cloud sync and accounts are not available here),
 * the chip that replaces the sync chip, and the Sign out refusal.
 */
import { DEMO_CLOUD_MESSAGE } from './cloudGuard'

export const DEMO_SIGN_OUT_MESSAGE =
  'Signing out is not available in the demo. Use the "You are simulating" panel to work as a different role.'

export const DEMO_SETTINGS_NOTE =
  'Staff accounts and sign-in are simulated: use the "You are simulating" panel to switch roles. ' +
  'Everything else on this screen works, and the organization lists, formulary and form templates are the real editors.'

export function DemoSettingsNote() {
  return (
    <div className="alert alert-info demo-note" role="note">
      <strong>Cloud sync and accounts are not available in the demo.</strong> {DEMO_CLOUD_MESSAGE}{' '}
      {DEMO_SETTINGS_NOTE}
    </div>
  )
}

export function DemoSyncChip() {
  return (
    <span className="sync sync-idle demo-sync" title="Nothing leaves this browser in the demo.">
      <span className="dot" aria-hidden="true" />
      <span>Local demo</span>
    </span>
  )
}
