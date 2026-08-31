/**
 * The clinic-mode patient-flow board: one column per station, today's
 * visits only, longest-waiting first. The single most common action - send
 * this patient to the next station - is one large tap; jumps go through a
 * per-card station picker.
 *
 * Data rules (see src/domain/flow.ts for the pure logic):
 *  - Stations come from config key 'flowStations' with the built-in default
 *    as fallback. Station names are identity; a visit pointing at a station
 *    that no longer exists surfaces in the Check in list, never vanishes.
 *  - A move writes flow_station + flow_updated_at through records.update,
 *    so sync_version bumps and the move replicates like any other edit.
 *  - Re-reads ride the shell's refreshSignal prop. The shell (App.tsx)
 *    already forwards records.onExternalWrite AND syncEngine.onRecordsUpdated
 *    into that signal; subscribing to either here as well would double
 *    every read (same rule as useRecords).
 *  - EncounterForm owns its own dialog chrome (backdrop, focus trap,
 *    Escape-through-discard). It is rendered bare, never inside another
 *    dialog wrapper.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  boardGroups,
  formatWait,
  isDone,
  movePatch,
  nextStation,
  resolveStations,
  waitMinutes,
} from '../../domain/flow'
import { todayLocal } from '../../domain/today'
import { getConfig } from '../../config/keys'
import { config, records } from '../../kernel'
import { formatDate } from '../../lib/patients'
import { displayName, type PatientRecord } from '../../types/record'
import type { ActiveProfile } from '../../auth'
import { EncounterForm } from '../encounter/EncounterForm'
import { useRecords } from '../records/useRecords'
import { useBodyScrollLock } from '../lib/scrollLock'
import { useDialog } from '../lib/useDialog'
import { useViewportHeight } from '../lib/useViewportHeight'
import './board.css'

export interface BoardScreenProps {
  /** This device's id (null while unregistered), for record saves. */
  deviceId: string | null
  /** Bumps when records changed underneath (sync pull, other tab). */
  refreshSignal: number
  /** The signed-in, active account (role decides the default station lens). */
  profile: ActiveProfile
  /** Call after this screen changes records, so the shell refreshes others. */
  onRefresh?: () => void
}

export default function BoardScreen({
  deviceId,
  refreshSignal,
  profile,
  onRefresh,
}: BoardScreenProps) {
  const { records: allRecords, loading, error, refresh } = useRecords()
  const [stations, setStations] = useState<string[]>(() => resolveStations(null))
  const [notice, setNotice] = useState<string | null>(null)
  const [checkInOpen, setCheckInOpen] = useState(false)
  const [newVisitOpen, setNewVisitOpen] = useState(false)
  const [doneOpen, setDoneOpen] = useState(false)
  // Re-render pulse so wait times stay honest while nothing else changes.
  const [, setTick] = useState(0)

  // Station list: on mount and again whenever the shell signals data change
  // (a config pull can rename the board out from under an open screen).
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

  // Records re-read on the shell's signal (sync pull, other tab, restore).
  useEffect(() => {
    if (refreshSignal > 0) void refresh()
  }, [refreshSignal, refresh])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const today = todayLocal()
  const groups = useMemo(
    () => boardGroups(allRecords, stations, today),
    [allRecords, stations, today],
  )
  const now = new Date()
  const onBoardCount = groups.columns.reduce((n, c) => n + c.visits.length, 0)

  // The signed-in role's home column gets a subtle highlight when a station
  // carries the same name (e.g. role 'provider', station 'Provider').
  const myStation =
    stations.find((s) => s.toLowerCase() === profile.role.toLowerCase()) ?? null

  const moveTo = useCallback(
    async (rec: PatientRecord, station: string): Promise<void> => {
      const patch = movePatch(station, stations, new Date().toISOString())
      // Unknown station (stale button after a config sync): leave the
      // record untouched rather than filing it under a name no column shows.
      if (!patch) return
      try {
        const ok = await records.update(rec.id, (r) => ({ ...r, ...patch }))
        if (!ok) {
          setNotice('That visit is no longer on this device. The board has been refreshed.')
        }
      } catch (e) {
        setNotice(
          `Could not move that visit: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
      await refresh()
      onRefresh?.()
    },
    [stations, refresh, onRefresh],
  )

  /** Place a visit at station 1 (check-in from the panel or a fresh save). */
  const placeAtStart = useCallback(
    async (rec: PatientRecord): Promise<void> => {
      const first = stations[0]
      if (!first) return // resolveStations guarantees non-empty; belt and braces
      await moveTo(rec, first)
    },
    [stations, moveTo],
  )

  if (error) {
    return (
      <div className="screen">
        <div className="alert alert-bad">
          <strong>Could not read visits from this device.</strong>
          <p>{error}</p>
          <p className="muted">
            Your data has not been changed. Close and reopen the app; if this keeps happening,
            restart the device before entering more visits.
          </p>
          <button className="btn" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="screen board-screen">
      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
          <button className="btn btn-ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="board-toolbar">
        <div>
          <h2 className="board-title">Patient flow</h2>
          <div className="muted small">
            {formatDate(today)} · {onBoardCount} on the board
          </div>
        </div>
        <div className="btn-row">
          <button className="btn btn-ghost" onClick={() => setCheckInOpen(true)}>
            Check in{groups.offBoard.length ? ` (${groups.offBoard.length})` : ''}
          </button>
          <button className="btn" onClick={() => setNewVisitOpen(true)}>
            + New patient
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading the board...</div>
      ) : onBoardCount === 0 && groups.offBoard.length === 0 ? (
        <section className="card">
          <h3>No patients on the board yet</h3>
          <p className="muted">
            The board fills as patients are checked in. Use New patient to register an
            arrival, or Check in to place a visit that was already saved today. Visits from
            previous days stay on the Visits tab.
          </p>
        </section>
      ) : (
        <div className="board" aria-label="Patient flow board">
          {groups.columns.map((col) => {
            const last = isDone(col.station, stations)
            const collapsed = last && !doneOpen
            return (
              <section
                key={col.station}
                className={[
                  'board-col',
                  last ? 'board-col-done' : '',
                  col.station === myStation ? 'board-col-mine' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <header className="board-col-head">
                  <span className="board-col-name">
                    {col.station}
                    {col.station === myStation ? (
                      <span className="board-mine-tag">your station</span>
                    ) : null}
                  </span>
                  <span className="board-count" aria-label={`${col.visits.length} patients`}>
                    {col.visits.length}
                  </span>
                </header>
                {collapsed ? (
                  <button
                    className="btn btn-ghost board-expand"
                    aria-expanded={false}
                    onClick={() => setDoneOpen(true)}
                  >
                    {col.visits.length === 0
                      ? 'No one is done yet'
                      : `Show ${col.visits.length} done`}
                  </button>
                ) : (
                  <>
                    {last ? (
                      <button
                        className="btn btn-ghost board-expand"
                        aria-expanded={true}
                        onClick={() => setDoneOpen(false)}
                      >
                        Collapse
                      </button>
                    ) : null}
                    <div className="board-cards">
                      {col.visits.length === 0 ? (
                        <div className="board-col-empty">Empty</div>
                      ) : (
                        col.visits.map((rec) => (
                          <BoardCard
                            key={rec.id}
                            rec={rec}
                            stations={stations}
                            now={now}
                            onMove={(station) => void moveTo(rec, station)}
                          />
                        ))
                      )}
                    </div>
                  </>
                )}
              </section>
            )
          })}
        </div>
      )}

      {checkInOpen && (
        <CheckInPanel
          visits={groups.offBoard}
          station={stations[0] ?? ''}
          onCheckIn={(rec) => void placeAtStart(rec)}
          onClose={() => setCheckInOpen(false)}
        />
      )}

      {newVisitOpen && (
        <EncounterForm
          editing={null}
          allRecords={allRecords}
          deviceId={deviceId}
          onSaved={(saved, andNext) => {
            // Stamp the fresh visit onto station 1 so registration lands it
            // on the board in one motion. Save & next keeps the form open
            // for the next arrival; plain Save closes it.
            void placeAtStart(saved)
            if (!andNext) setNewVisitOpen(false)
          }}
          onClose={() => setNewVisitOpen(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function BoardCard({
  rec,
  stations,
  now,
  onMove,
}: {
  rec: PatientRecord
  stations: string[]
  now: Date
  onMove: (station: string) => void
}) {
  const name = displayName(rec)
  const wait = waitMinutes(rec, now)
  const next = rec.flow_station ? nextStation(rec.flow_station, stations) : null
  return (
    <article className="board-card">
      <div className="b-top">
        <span className="b-name">{name}</span>
        {wait !== null && (
          <span className="b-wait" title="Time at this station">
            {formatWait(wait)}
          </span>
        )}
      </div>
      <div className="b-meta">No. {rec.mrn}</div>
      <div className="b-actions">
        {next && (
          <button className="btn board-advance" onClick={() => onMove(next)}>
            Next: {next}
          </button>
        )}
        <select
          className="board-pick"
          value={rec.flow_station ?? ''}
          aria-label={`Move ${name} to a station`}
          onChange={(e) => onMove(e.target.value)}
        >
          {stations.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
    </article>
  )
}

/**
 * Today's off-board visits, each one tap from station 1. Stays open after a
 * check-in so a queue of arrivals can be placed in sequence; the list
 * shrinks as each one lands on the board.
 */
function CheckInPanel({
  visits,
  station,
  onCheckIn,
  onClose,
}: {
  visits: PatientRecord[]
  station: string
  onCheckIn: (rec: PatientRecord) => void
  onClose: () => void
}) {
  const panelRef = useDialog<HTMLElement>(onClose)
  useBodyScrollLock(true)
  useViewportHeight()
  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="panel board-checkin"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Check in"
      >
        <header className="panel-head">
          <div>
            <div className="panel-title">Check in</div>
            <div className="panel-sub">Today's saved visits that are not on the board yet.</div>
          </div>
          <button className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="panel-body">
          {visits.length === 0 ? (
            <div className="empty">
              Every visit saved today is already on the board. Use New patient to register a
              new arrival.
            </div>
          ) : (
            <ul className="checkin-list">
              {visits.map((rec) => (
                <li key={rec.id} className="checkin-row">
                  <div>
                    <div className="b-name">{displayName(rec)}</div>
                    <div className="b-meta">No. {rec.mrn}</div>
                  </div>
                  <button className="btn board-advance" onClick={() => onCheckIn(rec)}>
                    Check in to {station}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </div>
  )
}
