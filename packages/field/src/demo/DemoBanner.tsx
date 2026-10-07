/**
 * The standing "this is a demo" bar (SAFETY LAW 5: fictional patients, said
 * out loud). Always visible in demo builds - mounted above the app shell in
 * main.tsx - with the Reset Demo button, which re-seeds through the kernel's
 * own locked writes (see seed.ts) after an explicit confirm.
 */
import { useState } from 'react'
import { records } from '@dh/core/kernel'
import { resetDemo } from './seed'
import './demo.css'

export function DemoBanner() {
  const [busy, setBusy] = useState(false)

  const doReset = async (): Promise<void> => {
    if (
      !window.confirm(
        'Reset the demo clinic?\n\nAnything you added or changed here will be removed, and the original sample patients come back.',
      )
    ) {
      return
    }
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
        A fictional clinic with sample patients. Everything stays in this browser and never syncs
        anywhere. DH EMR is not a certified EHR and is not HIPAA-compliant. It is intended for
        global-health use outside the US.
      </span>
      <button
        type="button"
        className="demo-reset"
        onClick={() => {
          void doReset()
        }}
        disabled={busy}
      >
        {busy ? 'Resetting…' : 'Reset Demo'}
      </button>
    </div>
  )
}
