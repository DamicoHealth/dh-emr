/**
 * Awaiting-approval screen. A signed-in account whose profile is still
 * pending (activated_at null) lands here - which is EVERY new account by
 * design: signing up grants nothing until an admin approves it.
 *
 * The offline flavor is honest about why access cannot be confirmed: the
 * server could not be reached and this device has no confirmed account to
 * fall back on, so nothing may open yet.
 */
import { useState } from 'react'
import './auth.css'

export interface PendingScreenProps {
  displayName: string
  /** True when this is a could-not-reach-the-server answer, not a server verdict. */
  offline: boolean
  /** Re-check the account state (reloads the profile). */
  onCheckAgain: () => Promise<void>
  onSignOut: () => void | Promise<void>
  /**
   * The product name on the card. Defaults to DH EMR Clinic: only the
   * Clinic product has accounts, so only Clinic renders this screen.
   */
  brand?: string
}

export default function PendingScreen({
  displayName,
  offline,
  onCheckAgain,
  onSignOut,
  brand = 'DH EMR Clinic',
}: PendingScreenProps) {
  const [checking, setChecking] = useState(false)

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span className="brand-name">{brand}</span>
        </div>

        <h2>{offline ? 'Cannot confirm your account yet' : 'Waiting for approval'}</h2>
        {offline ? (
          <p className="muted">
            You are signed in{displayName ? ` as ${displayName}` : ''}, but this device could not
            reach your organization's server to confirm the account. Check the connection and try
            again - nothing opens until the account is confirmed once.
          </p>
        ) : (
          <>
            <p className="muted">
              Your account{displayName ? ` (${displayName})` : ''} is set up and waiting for your
              administrator to approve it. That is a normal step for every new account, and it
              usually takes them only a moment.
            </p>
            <p className="muted small">
              Ask whoever runs this organization's records to approve you, then tap Check again.
            </p>
          </>
        )}

        <div className="btn-row">
          <button
            type="button"
            className="btn"
            disabled={checking}
            onClick={() => {
              setChecking(true)
              void onCheckAgain().finally(() => setChecking(false))
            }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={checking}
            onClick={() => {
              void onSignOut()
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  )
}
