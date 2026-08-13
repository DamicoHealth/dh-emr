/**
 * The Records screen: header stats, search + filters, the patient list
 * (visits grouped by patient number, newest first), the patient chart panel,
 * and the visit form panel for edit / new-visit-for-existing-patient.
 *
 * The shell passes refreshSignal and NEVER remounts this screen on sync: a
 * remount would destroy a part-typed visit every time another device synced.
 */
import { useEffect, useMemo, useState } from 'react'
import { todayLocal } from '../../domain/today'
import {
  applyFilters,
  calcAge,
  distinct,
  EMPTY_FILTERS,
  formatDate,
  groupByPatient,
  type PatientGroup,
  type RecordFilters,
} from '../../lib/patients'
import type { PatientRecord } from '../../types/record'
// The NAMED export is the full form (edit / seed / save-and-next). It renders
// its own panel chrome and guards close with a discard confirm; the default
// export is only the shell's plain-new-visit host.
import { EncounterForm } from '../encounter/EncounterForm'
import { PatientDetail } from './PatientDetail'
import { deleteRecord, useDebounced, useRecords } from './useRecords'
import './records.css'

export interface RecordsScreenProps {
  deviceId?: string | null
  /** Bumped when the underlying records changed (sync pull, other tab). */
  refreshSignal?: number
}

/**
 * How many patient cards to render before asking the user to narrow the
 * search. Keeps the DOM small and the list smooth at thousands of records.
 */
const RENDER_CAP = 150

/**
 * null = closed. { editing: rec } edits that record in place.
 * { editing: null, seedFrom: rec } is a NEW visit for an existing patient:
 * the identity carries over but the save creates a new encounter.
 */
type FormTarget = { editing: PatientRecord | null; seedFrom?: PatientRecord | null } | null

export default function RecordsScreen({ deviceId = null, refreshSignal = 0 }: RecordsScreenProps) {
  const { records, loading, error, refresh } = useRecords()
  const [notice, setNotice] = useState<string | null>(null)
  const [filters, setFilters] = useState<RecordFilters>(EMPTY_FILTERS)
  const [showFilters, setShowFilters] = useState(false)
  const [openMrn, setOpenMrn] = useState<string | null>(null)
  const [form, setForm] = useState<FormTarget>(null)
  const debouncedSearch = useDebounced(filters.search, 200)

  // Re-read after a remote sync or a restore. Deliberately a data refresh
  // only: any open visit form, search text and filters are left exactly as
  // they are.
  useEffect(() => {
    if (refreshSignal > 0) void refresh()
  }, [refreshSignal, refresh])

  // Recomputed only when the inputs actually change - no work per keystroke.
  const groups = useMemo(() => {
    const filtered = applyFilters(records, { ...filters, search: debouncedSearch })
    return groupByPatient(filtered)
    // Depend on the individual filters, not the object: a new object on every
    // keystroke invalidated this memo and defeated the search debounce.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [records, filters.site, filters.provider, filters.referral, filters.dateFrom, filters.dateTo, debouncedSearch])

  const sites = useMemo(() => distinct(records, 'site'), [records])
  const providers = useMemo(() => distinct(records, 'provider'), [records])
  const referrals = useMemo(
    () => distinct(records, 'referralType').filter((r) => r !== 'None'),
    [records],
  )

  // Header stats are over ALL records on the device, unfiltered.
  const stats = useMemo(() => {
    const today = todayLocal()
    return {
      encounters: records.length,
      patients: new Set(records.map((r) => r.mrn || r.id)).size,
      today: records.filter((r) => r.date === today).length,
      pediatric: records.filter((r) => {
        const a = calcAge(r.dob)
        return a !== null && a < 18
      }).length,
    }
  }, [records])

  const handleDelete = async (rec: PatientRecord) => {
    const when = formatDate(rec.date)
    if (
      !window.confirm(
        `Delete the ${when} visit for ${rec.name || 'this patient'}?\n\n` +
          'The visit is removed from this device and from every device that syncs ' +
          'with it. This cannot be undone from inside the app - only a backup ' +
          'taken before now can bring it back.',
      )
    )
      return
    try {
      await deleteRecord(rec.id)
      await refresh()
      setNotice(`Deleted the ${when} visit for ${rec.name || 'this patient'}.`)
    } catch (e) {
      setNotice(`Could not delete that visit: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Derived per render: deleting a group's last visit auto-closes the panel.
  const openGroup = openMrn ? (groups.find((g) => g.mrn === openMrn) ?? null) : null
  const shown = groups.slice(0, RENDER_CAP)
  // Search is deliberately NOT counted: typing never lights the badge.
  const activeFilterCount =
    (filters.site ? 1 : 0) +
    (filters.provider ? 1 : 0) +
    (filters.referral ? 1 : 0) +
    (filters.dateFrom ? 1 : 0) +
    (filters.dateTo ? 1 : 0)

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
    <div className="screen">
      {notice && (
        <div className="alert alert-info" role="status">
          {notice}
          <button className="btn btn-ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="stat-row">
        <Stat n={stats.encounters} label="Visits" />
        <Stat n={stats.patients} label="Patients" />
        <Stat n={stats.today} label="Today" />
        <Stat n={stats.pediatric} label="Pediatric (<18)" />
      </div>

      <div className="toolbar">
        <input
          className="search"
          type="search"
          placeholder="Search name, patient number, concern, diagnosis..."
          value={filters.search}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
          aria-label="Search records"
        />
        <button
          className={`btn btn-ghost${activeFilterCount ? ' has-badge' : ''}`}
          onClick={() => setShowFilters((s) => !s)}
          aria-expanded={showFilters}
        >
          Filters{activeFilterCount ? ` (${activeFilterCount})` : ''}
        </button>
        <button className="btn" onClick={() => setForm({ editing: null })}>
          + New visit
        </button>
      </div>

      {showFilters && (
        <div className="filters">
          <Select
            label="Site"
            value={filters.site}
            options={sites}
            onChange={(v) => setFilters((f) => ({ ...f, site: v }))}
          />
          <Select
            label="Provider"
            value={filters.provider}
            options={providers}
            onChange={(v) => setFilters((f) => ({ ...f, provider: v }))}
          />
          <Select
            label="Referral"
            value={filters.referral}
            options={referrals}
            onChange={(v) => setFilters((f) => ({ ...f, referral: v }))}
          />
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={filters.dateFrom}
              onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              value={filters.dateTo}
              onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
            />
          </label>
          <button className="btn btn-ghost" onClick={() => setFilters(EMPTY_FILTERS)}>
            Reset
          </button>
        </div>
      )}

      {loading ? (
        <div className="empty">Loading records...</div>
      ) : groups.length === 0 ? (
        <div className="empty">
          {records.length === 0
            ? 'No visits recorded on this device yet.'
            : 'No visits match those filters.'}
        </div>
      ) : (
        <>
          <ul className="patient-list">
            {shown.map((g) => (
              <PatientCard key={g.mrn} group={g} onOpen={() => setOpenMrn(g.mrn)} />
            ))}
          </ul>
          {groups.length > RENDER_CAP && (
            <div className="empty small">
              Showing the first {RENDER_CAP} of {groups.length} patients. Narrow your search to
              see the rest.
            </div>
          )}
        </>
      )}

      {openGroup && (
        <PatientDetail
          group={openGroup}
          onClose={() => setOpenMrn(null)}
          onEdit={(rec) => {
            setOpenMrn(null)
            setForm({ editing: rec })
          }}
          onNewVisit={(rec) => {
            setOpenMrn(null)
            setForm({ editing: null, seedFrom: rec })
          }}
          onDelete={(rec) => {
            void handleDelete(rec)
          }}
        />
      )}

      {form && (
        <EncounterForm
          seedFrom={form.seedFrom ?? null}
          /* Remount when the target changes. The form seeds its state once
             on mount, so switching from editing a record to a new visit
             used to leave the previous patient's data in the fields - and
             it could then be saved under the new patient. */
          key={form.editing?.id ?? (form.seedFrom ? `new-visit-${form.seedFrom.id}` : 'new-encounter')}
          editing={form.editing}
          allRecords={records}
          deviceId={deviceId ?? null}
          onSaved={(_saved, andNext) => {
            void refresh()
            // CRITICAL: always drop the edit target. Leaving `editing` set
            // meant the NEXT patient was serialized with the previous
            // record's id and overwrote it - two patients, one record,
            // first one destroyed. Save & next always starts a clean
            // patient: never keep seedFrom, or the next patient inherits
            // the previous one's identity.
            setForm(andNext ? { editing: null } : null)
          }}
          onClose={() => setForm(null)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="stat">
      <div className="stat-n">{n}</div>
      <div className="stat-l">{label}</div>
    </div>
  )
}

function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

function PatientCard({ group, onOpen }: { group: PatientGroup; onOpen: () => void }) {
  const age = calcAge(group.dob)
  const meta = [
    group.latest.site,
    formatDate(group.latest.date),
    [group.sex, age !== null ? `${age}y` : ''].filter(Boolean).join('/'),
    `No. ${group.mrn}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <li>
      <button className="patient-card" onClick={onOpen}>
        <div className="pc-main">
          <div className="pc-name">{group.name}</div>
          <div className="pc-meta">{meta}</div>
          {group.latest.diagnosis && <div className="pc-dx">{group.latest.diagnosis}</div>}
        </div>
        <div className="pc-badges">
          {group.flags.labPositive && <span className="badge badge-red">Lab+</span>}
          {group.flags.referred && <span className="badge badge-amber">Referred</span>}
          {group.flags.pregnant && <span className="badge badge-blue">Pregnant</span>}
          {group.visitCount > 1 && (
            <span className="badge badge-green">{group.visitCount} visits</span>
          )}
        </div>
      </button>
    </li>
  )
}

