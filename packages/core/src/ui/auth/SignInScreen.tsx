/**
 * Clinic-mode sign-in (and account creation). Shown when the org is in
 * clinic mode, the device holds cloud credentials, and no session exists.
 *
 * Copy rules:
 *  - Server error strings surface VERBATIM (the session layer passes them
 *    through untouched), because guessing at a friendlier paraphrase has
 *    hidden real causes before.
 *  - Creating an account grants NOTHING until an admin approves it - the
 *    server enforces that, and this screen says so kindly up front so the
 *    pending screen that follows is never a surprise.
 */
import { useState, type FormEvent } from 'react'
import { authSession } from '../../auth'
import './auth.css'

export interface SignInScreenProps {
  /** A session now exists; the shell re-checks the account state. */
  onSignedIn: () => void
  /**
   * The product name on the card. Defaults to DH EMR Clinic: only the
   * Clinic product has accounts, so only Clinic renders this screen.
   */
  brand?: string
}

type Mode = 'signIn' | 'signUp'

export default function SignInScreen({ onSignedIn, brand = 'DH EMR Clinic' }: SignInScreenProps) {
  const [mode, setMode] = useState<Mode>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'signIn') {
        const r = await authSession.signIn(email.trim(), password)
        if (!r.ok) {
          setError(r.error)
          return
        }
        onSignedIn()
      } else {
        const r = await authSession.signUp(email.trim(), password, displayName.trim())
        if (!r.ok) {
          setError(r.error)
          return
        }
        if (r.needsSignIn) {
          // No session came back (the org left email confirmation on).
          setMode('signIn')
          setNotice(
            'Your account was created. Sign in with the same email and password once your administrator has approved it.',
          )
        } else {
          onSignedIn()
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <span className="brand-name">{brand}</span>
        </div>

        <h2>{mode === 'signIn' ? 'Sign in' : 'Create your account'}</h2>
        <p className="muted small">
          {mode === 'signIn'
            ? 'This organization uses staff accounts. Sign in with the email and password for your account.'
            : 'A new account starts with no access at all. Your administrator approves it from their device, and then you can sign in and work. That usually takes a moment, not a day.'}
        </p>

        {notice ? (
          <div className="alert alert-info" role="status">
            {notice}
          </div>
        ) : null}
        {error ? (
          <div className="alert alert-bad" role="alert">
            {error}
          </div>
        ) : null}

        <form
          onSubmit={(e) => {
            void submit(e)
          }}
        >
          {mode === 'signUp' ? (
            <label className="field">
              <span className="field-label">Your name</span>
              <input
                className="input"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder='For example "Grace N."'
                autoComplete="name"
              />
            </label>
          ) : null}
          <label className="field">
            <span className="field-label">Email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'}
            />
          </label>
          <div className="btn-row">
            <button type="submit" className="btn" disabled={busy || !email.trim() || !password}>
              {busy
                ? mode === 'signIn'
                  ? 'Signing in…'
                  : 'Creating…'
                : mode === 'signIn'
                  ? 'Sign in'
                  : 'Create account'}
            </button>
          </div>
        </form>

        <button
          type="button"
          className="auth-switch"
          onClick={() => {
            setMode((m) => (m === 'signIn' ? 'signUp' : 'signIn'))
            setError(null)
            setNotice(null)
          }}
          disabled={busy}
        >
          {mode === 'signIn' ? 'New here? Create an account' : 'Already have an account? Sign in'}
        </button>

        <p className="muted small">
          Forgot your password? Your administrator can set up a fresh account for you - password
          reset emails are not reliable on most clinic projects.
        </p>
      </div>
    </div>
  )
}
