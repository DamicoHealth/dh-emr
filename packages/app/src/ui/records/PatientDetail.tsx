/**
 * Read-only patient chart: demographics, a vitals trend across visits, then
 * each encounter in full.
 *
 * Rendered PURELY from the saved records. The legacy view rebuilt this by
 * scraping the live edit form, which could bleed a previous patient's custom
 * sections into another patient's chart.
 *
 * Lab interpretations shown here are the SNAPSHOTTED strings saved on the
 * record at entry time - never recomputed from current reference ranges.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { config } from '../../kernel'
import { getConfig, loadLibrary, resolveFormulary } from '../../config/keys'
import { getEffectiveSchema } from '../../config/sections'
import type { FormularyEntry } from '../../config/types'
import { FREQUENCIES } from '../../domain/constants'
import { calcAge, formatDate, type PatientGroup } from '../../lib/patients'
import type { PatientRecord } from '../../types/record'
import { useBodyScrollLock } from '../lib/scrollLock'
import { useDialog } from '../lib/useDialog'
import { useViewportHeight } from '../lib/useViewportHeight'

/**
 * field id -> the admin's label, across EVERY template so answers from a
 * deleted or different template still read properly.
 */
function useCustomFieldLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({})
  useEffect(() => {
    let alive = true
    void loadLibrary(config)
      .then((lib) => {
        const map: Record<string, string> = {}
        for (const tpl of lib.templates) {
          for (const sec of getEffectiveSchema(tpl.schema).sections) {
            for (const f of sec.fields) if (f?.id) map[f.id] = f.label || f.id
          }
        }
        if (alive) setLabels(map)
      })
      .catch(() => {
        /* labels fall back to raw field ids */
      })
    return () => {
      alive = false
    }
  }, [])
  return labels
}

/** The org formulary (or the built-in default), for medId -> name lookups. */
function useFormulary(): FormularyEntry[] {
  const [formulary, setFormulary] = useState<FormularyEntry[]>([])
  useEffect(() => {
    let alive = true
    void getConfig(config, 'formulary')
      .then((stored) => {
        if (alive) setFormulary(resolveFormulary(stored))
      })
      .catch(() => {
        /* drug names fall back to raw medIds */
      })
    return () => {
      alive = false
    }
  }, [])
  return formulary
}

export function PatientDetail({
  group,
  onClose,
  onEdit,
  onNewVisit,
  onDelete,
}: {
  group: PatientGroup
  onClose: () => void
  onEdit: (rec: PatientRecord) => void
  onNewVisit: (rec: PatientRecord) => void
  onDelete: (rec: PatientRecord) => void
}) {
  const customLabels = useCustomFieldLabels()
  const formulary = useFormulary()
  useBodyScrollLock(true)
  useViewportHeight() // keep the footer above the iOS keyboard
  // Focus moves into the chart, Tab is trapped inside it, Escape closes,
  // and focus returns to the patient card that opened it.
  const panelRef = useDialog<HTMLElement>(onClose)

  const age = calcAge(group.dob)
  const chronological = [...group.encounters].reverse() // OLDEST first

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Chart for ${group.name}`}
      >
        <header className="panel-head">
          <div>
            <div className="panel-title">{group.name}</div>
            <div className="panel-sub">
              Patient number {group.mrn} ·{' '}
              {[group.sex, age !== null ? `${age}y` : ''].filter(Boolean).join('/')}
              {group.dob ? ` · DOB ${formatDate(group.dob)}` : ''}
              {group.latest.ageEstimated ? ' (est.)' : ''}
            </div>
          </div>
          <div className="btn-row">
            {/* Edit OVERWRITES the visit being viewed. Without this button the
                only way to record a return visit was to overwrite the last one
                or re-type the identity exactly right. */}
            <button className="btn" onClick={() => onNewVisit(group.latest)}>
              + New visit
            </button>
            <button className="btn btn-ghost" onClick={onClose} aria-label="Close chart">
              Close
            </button>
          </div>
        </header>

        <div className="panel-body">
          <div className="visit-count">
            {group.visitCount} visit{group.visitCount === 1 ? '' : 's'}
          </div>

          {chronological.length >= 2 && <VitalsTrend encounters={chronological} />}

          {group.encounters.map((enc, i) => (
            <EncounterBlock
              key={enc.id}
              rec={enc}
              visitNum={group.visitCount - i}
              onEdit={onEdit}
              onDelete={onDelete}
              customLabels={customLabels}
              formulary={formulary}
            />
          ))}
        </div>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Vitals trend: sparklines + the per-visit table, columns OLDEST to NEWEST
// (V1 = first visit; EncounterBlock numbering agrees via visitCount - i).
// ---------------------------------------------------------------------------

/** Tiny inline SVG line, no chart dependency. Decorative: the table below
 *  carries the actual values, so the whole strip is aria-hidden. */
function Sparkline({ values }: { values: number[] }) {
  const w = 120
  const h = 28
  const pad = 3
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0
  const x = (i: number) => pad + i * step
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2)
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const last = values[values.length - 1] as number
  return (
    <svg
      className="spark"
      viewBox={`0 0 ${w} ${h}`}
      width={w}
      height={h}
      aria-hidden="true"
      focusable="false"
    >
      <polyline
        points={points}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* --brand-bright is decorative-fill only; a dot qualifies. */}
      <circle cx={x(values.length - 1)} cy={y(last)} r="3" fill="var(--brand-bright)" />
    </svg>
  )
}

function VitalsTrend({ encounters }: { encounters: PatientRecord[] }) {
  const tempTone = (t: string) => {
    const v = parseFloat(t)
    if (Number.isNaN(v)) return ''
    return v >= 38.5 ? 'bad' : v >= 37.5 ? 'warn' : ''
  }
  const bpTone = (bp: string) => {
    const sys = parseInt((bp || '').split('/')[0] as string, 10)
    if (Number.isNaN(sys)) return ''
    return sys >= 140 ? 'bad' : sys >= 130 ? 'warn' : ''
  }
  const temps = encounters.map((e) => parseFloat(e.temp)).filter((v) => Number.isFinite(v))
  const weights = encounters.map((e) => parseFloat(e.weight)).filter((v) => Number.isFinite(v))
  return (
    <section className="card">
      <h4>Vitals trend</h4>
      {(temps.length >= 2 || weights.length >= 2) && (
        <div className="spark-rows" aria-hidden="true">
          {temps.length >= 2 && (
            <div className="spark-row">
              <span className="spark-k">Temp</span>
              <Sparkline values={temps} />
            </div>
          )}
          {weights.length >= 2 && (
            <div className="spark-row">
              <span className="spark-k">Weight</span>
              <Sparkline values={weights} />
            </div>
          )}
        </div>
      )}
      <div className="table-scroll">
        <table className="trend">
          <thead>
            <tr>
              <th>Visit</th>
              {encounters.map((e, i) => (
                <th key={e.id}>
                  V{i + 1}
                  <br />
                  <span className="th-date">{formatDate(e.date)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Temp</td>
              {encounters.map((e) => (
                <td key={e.id} className={tempTone(e.temp)}>
                  {e.temp ? `${e.temp} °C` : '-'}
                </td>
              ))}
            </tr>
            <tr>
              <td>BP</td>
              {encounters.map((e) => (
                <td key={e.id} className={bpTone(e.bp)}>
                  {e.bp || '-'}
                </td>
              ))}
            </tr>
            <tr>
              <td>Weight</td>
              {encounters.map((e) => (
                <td key={e.id}>{e.weight ? `${e.weight} kg` : '-'}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// One encounter, in full
// ---------------------------------------------------------------------------

/** Formulary id -> drug name, falling back to the raw value for legacy rows. */
function drugName(medId: string, formulary: FormularyEntry[]): string {
  return formulary.find((f) => f.id === medId)?.name || medId
}

function freqText(freq: string): string {
  return FREQUENCIES.find((f) => f.value === freq)?.label || freq
}

function EncounterBlock({
  rec,
  visitNum,
  onEdit,
  onDelete,
  customLabels,
  formulary,
}: {
  rec: PatientRecord
  visitNum: number
  onEdit: (rec: PatientRecord) => void
  onDelete: (rec: PatientRecord) => void
  customLabels: Record<string, string>
  formulary: FormularyEntry[]
}) {
  // Truthy `ordered` here ON PURPOSE (display filter), unlike hasLabPositive's
  // strict === true. Preserve each as-is.
  const labs = Object.entries(rec.labs || {}).filter(([, l]) => !!l && !!l.ordered)
  const ua = rec.urinalysis ? Object.entries(rec.urinalysis).filter(([, v]) => !!v) : []

  return (
    <section className="card visit">
      <header className="visit-head">
        <span className="visit-num">Visit {visitNum}</span>
        <span className="visit-meta">
          {formatDate(rec.date)}
          {rec.site ? ` · ${rec.site}` : ''}
          {rec.provider ? ` · ${rec.provider}` : ''}
        </span>
        {rec.templateName && <span className="chip">{rec.templateName}</span>}
        {/* Editing opens THIS visit, carrying its own template - the legacy
            timeline edit button kept the previously opened record's template. */}
        <div className="visit-actions">
          <button className="btn btn-ghost visit-edit" onClick={() => onEdit(rec)}>
            Edit
          </button>
          {/* Soft delete: the record is tombstoned and the tombstone syncs, so
              the visit also disappears from the other devices. A wrong-patient
              encounter previously had no way out of the chart at all. */}
          <button
            className="btn btn-ghost btn-danger"
            onClick={() => onDelete(rec)}
            aria-label={`Delete visit ${visitNum}`}
          >
            Delete
          </button>
        </div>
      </header>

      <div className="grid-2">
        <Block title="Vitals">
          <Row k="Temp" v={rec.temp ? `${rec.temp} °C` : ''} />
          <Row k="BP" v={rec.bp} />
          <Row k="Weight" v={rec.weight ? `${rec.weight} kg` : ''} />
          <Row k="Pregnant" v={rec.pregnant} />
          <Row k="Breastfeeding" v={rec.breastfeeding} />
        </Block>
        <Block title="History">
          <Row k="Allergies" v={rec.allergies} />
          <Row k="Current meds" v={rec.currentMeds} />
          <Row k="PMH" v={rec.pmh} />
          <Row k="Chief concern" v={rec.chiefConcern} />
        </Block>
      </div>

      {labs.length > 0 && (
        <Block title="Labs">
          {labs.map(([name, l]) => (
            <Row
              key={name}
              k={name}
              v={
                l.type === 'numeric'
                  ? [l.value, l.unit].filter(Boolean).join(' ') +
                    (l.interpretation ? ` (${l.interpretation})` : '')
                  : l.result || ''
              }
              tone={String(l.result || '').toUpperCase() === 'POS' ? 'bad' : ''}
            />
          ))}
          <Row k="Comments" v={rec.labComments} />
        </Block>
      )}

      {ua.length > 0 && (
        <Block title="Urinalysis">
          {ua.map(([k, v]) => (
            <Row key={k} k={k} v={String(v)} />
          ))}
        </Block>
      )}

      <Block title="Clinical">
        <Row k="Diagnosis" v={rec.diagnosis} />
        {(rec.diagnosisCodes || []).length > 0 && (
          <Row
            k="Coded"
            v={(rec.diagnosisCodes || [])
              .map((c) => [c.term, c.code && `(${c.code})`].filter(Boolean).join(' '))
              .join('; ')}
          />
        )}
        {(rec.medications || []).length > 0 && (
          <div className="meds">
            {(rec.medications || []).map((m) => (
              <div className="med" key={m.id}>
                {/* Resolve ids and frequency codes to names: a chart showing
                    "abx-amox500 · q8h" is not readable at the point of care. */}
                <strong>{drugName(m.medId, formulary)}</strong> {m.dose} · {freqText(m.freq)} ·{' '}
                {m.duration}
                {m.qty ? (
                  <span className="muted">
                    {' '}
                    · {m.qty} {m.qtyUnit || ''}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
        <Row k="Treatment notes" v={rec.treatmentNotes} />
        <Row k="Procedures" v={(rec.procedures || []).join(', ')} />
        {rec.imaging && (
          <Row
            k="Imaging"
            v={`${rec.imaging.modality} - ${rec.imaging.type}${
              rec.imaging.findings ? `: ${rec.imaging.findings}` : ''
            }`}
          />
        )}
        {rec.surgery && (
          <Row
            k="Surgery"
            v={`${rec.surgery.type}${rec.surgery.notes ? `: ${rec.surgery.notes}` : ''}`}
          />
        )}
        <Row
          k="Referral"
          v={
            rec.referralType && rec.referralType !== 'None'
              ? `${rec.referralType}${
                  rec.referralDate ? ` · ${formatDate(rec.referralDate)}` : ''
                }${rec.referralStatus ? ` · ${rec.referralStatus}` : ''}`
              : ''
          }
        />
        <Row k="Notes" v={rec.notes} />
      </Block>

      <CustomFieldsBlock rec={rec} labels={customLabels} />
    </section>
  )
}

/**
 * Custom (admin-defined) answers. Shown from the SAVED record so they are
 * never invisible after entry - previously they were write-only outside edit
 * mode.
 */
function CustomFieldsBlock({
  rec,
  labels,
}: {
  rec: PatientRecord
  labels: Record<string, string>
}) {
  const entries = Object.entries(rec.customFields || {}).filter(([, v]) => {
    if (v === null || v === undefined || v === '') return false
    if (Array.isArray(v)) return v.length > 0
    return true
  })
  if (entries.length === 0) return null
  return (
    <Block title="Additional">
      {entries.map(([k, v]) => (
        <Row key={k} k={labels[k] || k} v={Array.isArray(v) ? v.join(', ') : String(v)} />
      ))}
    </Block>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="block">
      <h4>{title}</h4>
      {children}
    </div>
  )
}

function Row({ k, v, tone }: { k: string; v?: string; tone?: string }) {
  if (!v) return null
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <span className={`row-v${tone ? ` ${tone}` : ''}`}>{v}</span>
    </div>
  )
}
