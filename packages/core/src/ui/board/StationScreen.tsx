/**
 * A station workspace (Clinic product): the visits waiting at the signed-in
 * role's own column of the patient-flow board, longest-waiting first, each
 * one tap from that role's view of the visit. Triage and the provider land
 * here ("the people waiting to be seen"); the full Board stays one tab away
 * for pulling a patient forward or moving someone elsewhere.
 *
 * Reuses the board's pure logic (src/domain/flow.ts, boardRole.ts) and the
 * lab/pharmacy list styling. Records re-read on the shell's refreshSignal
 * (never a second subscription here); EncounterForm renders bare, it owns
 * its own dialog chrome.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveProfile } from '../../auth'
import { config, records } from '../../kernel'
import { getConfig } from '../../config/keys'
import { ROLE_LABELS, normalizeRole } from '../../config/roles'
import {
  boardGroups,
  formatWait,
  movePatch,
  nextStation,
  resolveStations,
  waitMinutes,
} from '../../domain/flow'
import { todayLocal } from '../../domain/today'
import { formatDate } from '../../lib/patients'
import { displayName, type PatientRecord } from '../../types/record'
import { EncounterForm } from '../encounter/EncounterForm'
import { useRecords } from '../records/useRecords'
import { homeStationFor } from './boardRole'
import '../lab/lab.css'
import './station.css'

export interface StationScreenProps {
  /** This device's id (null while unregistered), for record saves. */
  deviceId: string | null
  /** Bumps when records changed underneath (sync pull, other tab). */
  refreshSignal: number
  /** The signed-in, active account; its role picks the station and shapes the form. */
  profile: ActiveProfile
  /** Call after this screen changes records, so the shell refreshes others. */
  onRefresh?: () => void
  /** Switch the shell to the Board (offered from the toolbar and the empty state). */
  onOpenBoard?: () => void
}

const CONCERN_MAX = 80

export default function StationScreen({
  deviceId,
  refreshSignal,
  profile,
  onRefresh,
  onOpenBoard,
}: StationScreenProps) {
  const { records: allRecords, loading, error, refresh } = useRecords()
  const [stations, setStations] = useState<string[]>(() => resolveStations(null))
  const [open, setOpen] = useState<PatientRecord | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Re-render pulse so wait times stay honest while nothing else changes.
  const [, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    void getConfig(config, 'flowStations')
      .then((stored) => {
        if (alive) setStations(resolveStations(stored))
      })
      .catch(() => {
        /* keep the current list; the default fallback is already in state */
      })
    return () => {
      alive = false
    }
  }, [refreshSignal])

  useEffect(() => {
    if (refreshSignal > 0) void refresh()
  }, [refreshSignal, refresh])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const today = todayLocal()
  const roleLabel = ROLE_LABELS[normalizeRole(profile.role)]
  const home = homeStationFor(profile.role, stations)
  const groups = useMemo(() => boardGroups(allRecords, stations, today), [allRecords, stations, today])
  const waiting = useMemo(
    () => (home ? (groups.columns.find((c) => c.station === home)?.visits ?? []) : []),
    [groups, home],
  )
  const prev = home ? (stations[stations.indexOf(home) - 1] ?? null) : null
  const upstream = prev ? (groups.columns.find((c) => c.station === prev)?.visits.length ?? 0) : 0
  const next = home ? nextStation(home, stations) : null
  const now = new Date()

  const moveTo = useCallback(
    async (rec: PatientRecord, station: string): Promise<void> => {
      const patch = movePatch(station, stations, new Date().toISOString())
      if (!patch) return
      try {
        const ok = await records.update(rec.id, (r) => ({ ...r, ...patch }))
        if (!ok) setNotice('That visit is no longer on this device. The list has been refreshed.')
      } catch (e) {
        setNotice(`Could not move that visit: ${e instanceof Error ? e.message : String(e)}`)
      }
      await refresh()
      onRefresh?.()
    },
    [stations, refresh, onRefresh],
  )

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
    <div className="screen station-screen">
      <div className="ws-toolbar">
        <div>
          <h2 className="ws-title">{home ?? roleLabel}</h2>
          <div className="muted small">
            {formatDate(today)} · {waiting.length} waiting
            {prev ? ` · ${upstream} at ${prev}` : ''}
          </div>
        </div>
        {onOpenBoard ? (
          <button type="button" className="btn btn-ghost" onClick={onOpenBoard}>
            Open the Board
          </button>
        ) : null}
      </div>

      {notice ? (
        <div className="alert alert-info" role="status">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <div className="empty">Loading today's visits...</div>
      ) : !home ? (
        <section className="card">
          <h3>No {roleLabel} station on the board</h3>
          <p className="muted">
            The board's station list has no station named {roleLabel}, so there is no queue to
            show. An admin can add one under Settings. Use the Board to find patients meanwhile.
          </p>
        </section>
      ) : waiting.length === 0 ? (
        <section className="card">
          <h3>No one is waiting at {home}</h3>
          <p className="muted">
            A patient appears here when they are moved to {home} on the board.
            {prev ? ` ${upstream === 1 ? 'One is' : `${upstream} are`} at ${prev} right now.` : ''}{' '}
            Open the Board to pull someone forward.
          </p>
        </section>
      ) : (
        <ul className="ws-list" aria-label={`Visits waiting at ${home}`}>
          {waiting.map((rec) => {
            const name = displayName(rec)
            const wait = waitMinutes(rec, now)
            const concern = (rec.chiefConcern || '').trim()
            return (
              <li key={rec.id} className="ws-row">
                <div className="ws-main">
                  <div className="ws-name">
                    {name}
                    {wait !== null ? (
                      <span className="ws-wait" title="Time at this station">
                        {formatWait(wait)}
                      </span>
                    ) : null}
                  </div>
                  <div className="ws-meta">
                    No. {rec.mrn}
                    {concern
                      ? ` · ${concern.length > CONCERN_MAX ? `${concern.slice(0, CONCERN_MAX)}...` : concern}`
                      : ''}
                  </div>
                </div>
                <div className="ws-actions">
                  <button
                    type="button"
                    className="btn ws-action"
                    aria-label={`Open the visit for ${name}`}
                    onClick={() => setOpen(rec)}
                  >
                    Open
                  </button>
                  {next ? (
                    <button
                      type="button"
                      className="btn btn-ghost ws-action"
                      aria-label={`Move ${name} to ${next}`}
                      onClick={() => void moveTo(rec, next)}
                    >
                      Next: {next}
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}

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
