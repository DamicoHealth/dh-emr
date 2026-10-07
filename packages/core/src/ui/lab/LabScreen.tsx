/**
 * The Lab workspace (Clinic product): today's visits waiting on a lab
 * result, longest-waiting first, each one tap from results entry. A visit
 * opens in the LAB role's view of the form (Labs editable, Patient and
 * Chief Concern read-only), so a lab save writes results and nothing else.
 *
 * Selection logic is pure (labModel.ts). Data rules match the board:
 * records re-read on the shell's refreshSignal (never a second subscription
 * here), and EncounterForm renders bare - it owns its own dialog chrome.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ActiveProfile } from '../../auth'
import { todayLocal } from '../../domain/today'
import { formatDate } from '../../lib/patients'
import { displayName, type PatientRecord } from '../../types/record'
import { EncounterForm } from '../encounter/EncounterForm'
import { useRecords } from '../records/useRecords'
import { pendingLabs, resultedLabs, visitsResultedToday, visitsWaitingOnLabs } from './labModel'
import './lab.css'

export interface LabScreenProps {
  /** This device's id (null while unregistered), for record saves. */
  deviceId: string | null
  /** Bumps when records changed underneath (sync pull, other tab). */
  refreshSignal: number
  /** The signed-in, active account; its role shapes the form it opens. */
  profile: ActiveProfile
  /** Call after this screen changes records, so the shell refreshes others. */
  onRefresh?: () => void
}

export default function LabScreen({ deviceId, refreshSignal, profile, onRefresh }: LabScreenProps) {
  const { records: allRecords, loading, error, refresh } = useRecords()
  const [open, setOpen] = useState<PatientRecord | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)

  useEffect(() => {
    if (refreshSignal > 0) void refresh()
  }, [refreshSignal, refresh])

  const today = todayLocal()
  const waiting = useMemo(() => visitsWaitingOnLabs(allRecords, today), [allRecords, today])
  const resulted = useMemo(() => visitsResultedToday(allRecords, today), [allRecords, today])

  if (error) {
    return (
      <div className="screen">
        <div className="alert alert-bad">
          <strong>Could not read visits from this device.</strong>
          <p>{error}</p>
          <button className="btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen lab-screen">
      <div className="ws-toolbar">
        <div>
          <h2 className="ws-title">Lab</h2>
          <div className="muted small">
            {formatDate(today)} · {waiting.length} waiting on results
          </div>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading today's visits...</div>
      ) : waiting.length === 0 ? (
        <section className="card">
          <h3>No visits are waiting on lab results</h3>
          <p className="muted">
            A visit appears here when a test is marked Ordered on its Labs section and has no
            result yet. Enter the result from this screen and the visit leaves the list.
          </p>
        </section>
      ) : (
        <ul className="ws-list" aria-label="Visits waiting on lab results">
          {waiting.map((rec) => (
            <li key={rec.id} className="ws-row">
              <div className="ws-main">
                <div className="ws-name">{displayName(rec)}</div>
                <div className="ws-meta">
                  No. {rec.mrn}
                  {rec.flow_station ? ` · ${rec.flow_station}` : ''}
                </div>
                <div className="ws-chips">
                  {pendingLabs(rec).map((name) => (
                    <span key={name} className="ws-chip ws-chip-pending">
                      {name}
                    </span>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="btn ws-action"
                aria-label={`Enter results for ${displayName(rec)}`}
                onClick={() => setOpen(rec)}
              >
                Enter results
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && resulted.length > 0 ? (
        <section className="card ws-done">
          <button
            type="button"
            className="btn btn-ghost ws-done-toggle"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((o) => !o)}
          >
            {doneOpen ? 'Hide' : 'Show'} {resulted.length} resulted today
          </button>
          {doneOpen ? (
            <ul className="ws-list">
              {resulted.map((rec) => (
                <li key={rec.id} className="ws-row">
                  <div className="ws-main">
                    <div className="ws-name">{displayName(rec)}</div>
                    <div className="ws-meta">No. {rec.mrn}</div>
                    <div className="ws-chips">
                      {resultedLabs(rec).map((name) => (
                        <span key={name} className="ws-chip">
                          {name}
                        </span>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost ws-action"
                    aria-label={`Open the visit for ${displayName(rec)}`}
                    onClick={() => setOpen(rec)}
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {open && (
        <EncounterForm
          key={open.id}
          editing={open}
          allRecords={allRecords}
          deviceId={deviceId}
          role={profile.role}
          isAdmin={profile.isAdmin}
          onSaved={() => {
            setOpen(null)
            void refresh()
            onRefresh?.()
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
