/**
 * The Pharmacy workspace (Clinic product): today's visits with a
 * prescription still to hand over, longest-waiting first. Each line is
 * marked dispensed with the quantity, by whom and when; the mark is stored
 * ON the medication line through records.update (pharmacyModel.ts), so it
 * bumps sync_version and reaches every device like any other edit. No
 * schema change. An honest mistake is undone from the "dispensed today"
 * list.
 *
 * A visit can also be opened in the PHARMACY role's view of the form
 * (Medications editable, Patient and Diagnosis read-only) for a
 * substitution; that save preserves every other section.
 *
 * Data rules match the board: records re-read on the shell's refreshSignal,
 * the formulary read through the kernel config KV, EncounterForm bare.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveProfile } from '../../auth'
import { getConfig, resolveFormulary } from '../../config/keys'
import type { FormularyEntry } from '../../config/types'
import { FREQUENCIES } from '../../domain/constants'
import { todayLocal } from '../../domain/today'
import { config, records } from '../../kernel'
import { formatDate } from '../../lib/patients'
import { displayName, type Medication, type PatientRecord } from '../../types/record'
import { EncounterForm } from '../encounter/EncounterForm'
import { useRecords } from '../records/useRecords'
import {
  dispensePatch,
  dispensedLines,
  medName,
  parseQty,
  suggestedQty,
  undispensePatch,
  undispensedLines,
  visitsAwaitingDispense,
  visitsDispensedToday,
} from './pharmacyModel'
import '../lab/lab.css'
import './pharmacy.css'

export interface PharmacyScreenProps {
  /** This device's id (null while unregistered), for record saves. */
  deviceId: string | null
  /** Bumps when records changed underneath (sync pull, other tab). */
  refreshSignal: number
  /** The signed-in, active account: its display name stamps each dispense. */
  profile: ActiveProfile
  /** Call after this screen changes records, so the shell refreshes others. */
  onRefresh?: () => void
}

function freqLabel(value: string): string {
  const f = FREQUENCIES.find((x) => x.value === value)
  return f ? f.label : value
}

function timeOf(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export default function PharmacyScreen({
  deviceId,
  refreshSignal,
  profile,
  onRefresh,
}: PharmacyScreenProps) {
  const { records: allRecords, loading, error, refresh } = useRecords()
  const [formulary, setFormulary] = useState<FormularyEntry[]>(() => resolveFormulary(null))
  /** Typed quantities per line id; absent = the suggested quantity. */
  const [qtyText, setQtyText] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState<PatientRecord | null>(null)
  const [doneOpen, setDoneOpen] = useState(false)

  useEffect(() => {
    if (refreshSignal > 0) void refresh()
  }, [refreshSignal, refresh])

  // Formulary names: on mount and again on the shell's signal (a config
  // pull can rename a drug while the screen is open).
  useEffect(() => {
    let alive = true
    void getConfig(config, 'formulary')
      .then((stored) => {
        if (alive) setFormulary(resolveFormulary(stored))
      })
      .catch(() => {
        /* keep the current list; the defaults are already in state */
      })
    return () => {
      alive = false
    }
  }, [refreshSignal])

  const today = todayLocal()
  const awaiting = useMemo(() => visitsAwaitingDispense(allRecords, today), [allRecords, today])
  const done = useMemo(() => visitsDispensedToday(allRecords, today), [allRecords, today])

  const after = useCallback(async (): Promise<void> => {
    await refresh()
    onRefresh?.()
  }, [refresh, onRefresh])

  const markDispensed = useCallback(
    async (rec: PatientRecord, line: Medication): Promise<void> => {
      const typed = qtyText[line.id]
      const qty = typed === undefined ? suggestedQty(line) : parseQty(typed)
      setBusy(line.id)
      setNotice(null)
      try {
        const ok = await records.update(rec.id, (r) =>
          dispensePatch(r, line.id, {
            qty,
            by: profile.displayName,
            at: new Date().toISOString(),
          }),
        )
        if (!ok) setNotice('That visit is no longer on this device. The list has been refreshed.')
      } catch (e) {
        setNotice(`Could not mark that line dispensed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(null)
      }
      await after()
    },
    [qtyText, profile.displayName, after],
  )

  const undo = useCallback(
    async (rec: PatientRecord, line: Medication): Promise<void> => {
      setBusy(line.id)
      setNotice(null)
      try {
        const ok = await records.update(rec.id, (r) => undispensePatch(r, line.id))
        if (!ok) setNotice('That visit is no longer on this device. The list has been refreshed.')
      } catch (e) {
        setNotice(`Could not undo that: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        setBusy(null)
      }
      await after()
    },
    [after],
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

  const linesToDo = awaiting.reduce((n, r) => n + undispensedLines(r).length, 0)

  return (
    <div className="screen pharmacy-screen">
      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
          <button className="btn btn-ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="ws-toolbar">
        <div>
          <h2 className="ws-title">Pharmacy</h2>
          <div className="muted small">
            {formatDate(today)} · {awaiting.length} waiting · {linesToDo} line
            {linesToDo === 1 ? '' : 's'} to dispense
          </div>
        </div>
      </div>

      {loading ? (
        <div className="empty">Loading today's visits...</div>
      ) : awaiting.length === 0 ? (
        <section className="card">
          <h3>Nothing is waiting to be dispensed</h3>
          <p className="muted">
            A visit appears here when a prescription on it has not been marked dispensed yet.
            Each line is marked with the quantity handed over, by whom and when.
          </p>
        </section>
      ) : (
        <ul className="ws-list" aria-label="Visits waiting on dispensing">
          {awaiting.map((rec) => {
            const name = displayName(rec)
            return (
              <li key={rec.id} className="ws-row rx-visit">
                <div className="ws-main">
                  <div className="ws-name">{name}</div>
                  <div className="ws-meta">
                    No. {rec.mrn}
                    {rec.diagnosis ? ` · ${rec.diagnosis}` : ''}
                    {rec.allergies ? ` · Allergies: ${rec.allergies}` : ''}
                  </div>
                  <ul className="rx-lines" aria-label={`Prescriptions for ${name}`}>
                    {undispensedLines(rec).map((m) => {
                      const suggested = suggestedQty(m)
                      const value = qtyText[m.id] ?? (suggested === null ? '' : String(suggested))
                      const label = medName(m, formulary)
                      return (
                        <li key={m.id} className="rx-line">
                          <div className="rx-line-main">
                            <div className="rx-line-name">{label}</div>
                            <div className="rx-line-sig">
                              {[m.dose, freqLabel(m.freq), m.duration].filter(Boolean).join(' · ')}
                              {suggested !== null
                                ? ` · ${suggested} ${m.qtyUnit || ''}`.trimEnd()
                                : ' · no quantity worked out, count by hand'}
                            </div>
                          </div>
                          <label className="rx-qty">
                            <span className="small muted">Qty</span>
                            <input
                              inputMode="numeric"
                              aria-label={`Quantity dispensed: ${label}`}
                              value={value}
                              onChange={(e) =>
                                setQtyText((q) => ({ ...q, [m.id]: e.target.value }))
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="btn rx-dispense"
                            aria-label={`Mark ${label} dispensed for ${name}`}
                            disabled={busy !== null}
                            onClick={() => void markDispensed(rec, m)}
                          >
                            {busy === m.id ? 'Saving…' : 'Dispensed'}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </div>
                <button
                  type="button"
                  className="btn btn-ghost ws-action"
                  aria-label={`Open the visit for ${name}`}
                  onClick={() => setOpen(rec)}
                >
                  Open visit
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {!loading && done.length > 0 ? (
        <section className="card ws-done">
          <button
            type="button"
            className="btn btn-ghost ws-done-toggle"
            aria-expanded={doneOpen}
            onClick={() => setDoneOpen((o) => !o)}
          >
            {doneOpen ? 'Hide' : 'Show'} dispensed today ({done.length})
          </button>
          {doneOpen ? (
            <ul className="ws-list">
              {done.map((rec) => {
                const name = displayName(rec)
                return (
                  <li key={rec.id} className="ws-row rx-visit">
                    <div className="ws-main">
                      <div className="ws-name">{name}</div>
                      <div className="ws-meta">No. {rec.mrn}</div>
                      <ul className="rx-lines">
                        {dispensedLines(rec).map((m) => {
                          const label = medName(m, formulary)
                          const d = m.dispensed
                          return (
                            <li key={m.id} className="rx-line">
                              <div className="rx-line-main">
                                <div className="rx-line-name">{label}</div>
                                <div className="rx-line-sig">
                                  {d
                                    ? `${d.qty === null ? 'Qty not recorded' : `${d.qty} ${m.qtyUnit || ''}`.trimEnd()} · ${d.by || 'unknown'}${timeOf(d.at) ? ` · ${timeOf(d.at)}` : ''}`
                                    : ''}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="btn btn-ghost rx-undo"
                                aria-label={`Undo dispensing ${label} for ${name}`}
                                disabled={busy !== null}
                                onClick={() => void undo(rec, m)}
                              >
                                {busy === m.id ? 'Saving…' : 'Undo'}
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  </li>
                )
              })}
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
            void after()
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
