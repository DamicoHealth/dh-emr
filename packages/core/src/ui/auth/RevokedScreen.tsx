/**
 * Revoked-account screen. Plain and kind, with no dead ends: it says who
 * can fix it (the org's administrator, in a moment), offers a re-check for
 * the restored case, and offers sign-out so a shared device is not stuck
 * showing someone else's revocation.
 *
 * Nothing on this device is deleted by revocation: records already synced
 * are safe on the server, and the device itself is untouched.
 */
import { useState } from 'react'
import './auth.css'

export interface RevokedScreenProps {
  displayName: string
  /** Re-check the account state (an admin may have restored it). */
  onCheckAgain: () => Promise<void>
  onSignOut: () => void | Promise<void>
  /**
   * The product name on the card. Defaults to DH EMR Clinic: only the
   * Clinic product has accounts, so only Clinic renders this screen.
   */
  brand?: string
}

export default function RevokedScreen({
  displayName,
  onCheckAgain,
  onSignOut,
  brand = 'DH EMR Clinic',
}: RevokedScreenProps) {
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

        <h2>This account has been turned off</h2>
        <p className="muted">
          {displayName ? `The account for ${displayName}` : 'This account'} was turned off by your
          organization's administrator. If you think that is a mistake, talk to them - they can
          turn it back on in a moment, and then Check again will let you straight in.
        </p>
        <p className="muted small">
          No records have been lost. Anything this account already saved is safe with your
          organization.
        </p>

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
