/**
 * Render error boundary. Used as the root backstop in main.tsx and per tab
 * in the shell (keyed by tab, so navigating away resets a failed screen).
 *
 * The recovery copy is ordered least-destructive first and NEVER suggests
 * clearing browser/site data or deleting the app - on an offline-first EMR
 * that is the one action that destroys records that have not synced.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children?: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only. No telemetry - the app must not phone home.
    console.error('[dh-emr] render failed', error, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="screen">
        <div className="alert alert-bad" role="alert">
          <strong>Something went wrong displaying this screen.</strong>
          <p>
            Your records are still on this device. Nothing has been deleted, and anything you had
            already saved is safe.
          </p>
          <ol className="steps">
            <li>
              Tap <strong>Try again</strong> below.
            </li>
            <li>If it happens again, close the app completely and reopen it.</li>
            <li>
              If it still happens, go to Settings on a working device and take a backup before
              doing anything else. Do not clear the browser data on this device - that would erase
              records that have not synced.
            </li>
          </ol>
          <button className="btn" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <details className="mt">
            <summary>Technical details</summary>
            <pre className="mono small">{this.state.error.message}</pre>
          </details>
        </div>
      </div>
    )
  }
}
