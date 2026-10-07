/**
 * The standing "this is a demo" bar (SAFETY LAW 5: fictional patients and
 * staff, said out loud). Always visible in demo builds, mounted above the
 * app shell by DemoShell so the notice shows in every boot state. Carries
 * the Reset demo button, which re-seeds through the kernel's own locked
 * writes (see seed.ts) after an explicit confirm, and the Pause activity
 * toggle for the simulated colleagues.
 */
import { useState } from 'react'
import { records } from '@dh/core/kernel'
import { resetDemo } from './seed'
import './demo.css'

export interface DemoBannerProps {
  /** Simulated colleagues are paused. */
  paused: boolean
  onTogglePause: () => void
}

export const RESET_CONFIRM =
  'Reset the demo clinic?\n\nAnything you added or changed here will be removed, and the original clinic day comes back with its sample patients and staff.'

export function DemoBanner({ paused, onTogglePause }: DemoBannerProps) {
  const [busy, setBusy] = useState(false)

  const doReset = async (): Promise<void> => {
    if (!window.confirm(RESET_CONFIRM)) return
    setBusy(true)
    try {
      await resetDemo()
      records.invalidate()
      window.location.reload()
    } catch (e) {
      setBusy(false)
      window.alert(`Could not reset the demo: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="demo-bar" role="note">
      <span className="demo-chip">DEMO</span>
      <span className="demo-text">
        A fictional clinic with sample patients and simulated staff. Everything stays in this
        browser and never syncs anywhere. DH EMR is not a certified EHR and is not
        HIPAA-compliant. It is intended for global-health use outside the US.
      </span>
      <span className="demo-bar-actions">
        <button
          type="button"
          className="demo-bar-btn"
          aria-pressed={paused}
          onClick={onTogglePause}
        >
          {paused ? 'Resume activity' : 'Pause activity'}
        </button>
        <button
          type="button"
          className="demo-bar-btn"
          onClick={() => {
            void doReset()
          }}
          disabled={busy}
        >
          {busy ? 'Resetting…' : 'Reset demo'}
        </button>
      </span>
    </div>
  )
}
