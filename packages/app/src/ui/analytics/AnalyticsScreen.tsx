/**
 * The Analytics screen: filter row, KPI tiles, and inline-SVG charts over the
 * device's visits. No chart library - every mark is hand-drawn SVG, like the
 * records sparkline.
 *
 * Contract with the shell: accepts refreshSignal and is NEVER remounted on
 * sync (same convention as RecordsScreen). Aggregation is memoized and
 * recomputes only when the records or the filters actually change - the
 * single-pass computeAnalytics replaced a legacy ~50-pass implementation and
 * must stay behind useMemo so opening the tab is instant at thousands of
 * records.
 *
 * Accessibility rules baked in (do not relax):
 *  - Chart SVGs are aria-hidden; every value they draw is ALSO in plain text
 *    (bar-list values, meter labels, the "View data" tables). Tooltips
 *    enhance, they never gate.
 *  - Series colors are the two validated hues in analytics.css; text never
 *    wears them, and nothing encodes meaning by red/green.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { getConfig, resolveFormulary } from '../../config/keys'
import { config } from '../../kernel'
import {
  applyAnalyticsFilters,
  computeAnalytics,
  EMPTY_ANALYTICS_FILTERS,
  firstSeenByPatient,
  type AgeBand,
  type AnalyticsFilters,
  type Counted,
  type TrendPoint,
} from '../../lib/analytics'
import { distinct, formatDate } from '../../lib/patients'
import { useRecords } from '../records/useRecords'
import './analytics.css'

export interface AnalyticsScreenProps {
  /** Bumped when the underlying records changed (sync pull, other tab). */
  refreshSignal?: number
}

export default function AnalyticsScreen({ refreshSignal = 0 }: AnalyticsScreenProps) {
  const { records, loading, error, refresh } = useRecords()
  const [filters, setFilters] = useState<AnalyticsFilters>(EMPTY_ANALYTICS_FILTERS)
  const medName = useMedNames()

  // Re-read after a remote sync or a restore; filters stay exactly as set.
  useEffect(() => {
    if (refreshSignal > 0) void refresh()
  }, [refreshSignal, refresh])

  // setFilters only ever produces a new object on an actual change, so the
  // object identity is a sound memo key here (no per-keystroke churn: these
  // are date/select inputs, not a search box).
  const filtered = useMemo(() => applyAnalyticsFilters(records, filters), [records, filters])
  // New-vs-return baseline is the WHOLE dataset, not the filtered slice.
  const firstSeen = useMemo(() => firstSeenByPatient(records), [records])
  const a = useMemo(() => computeAnalytics(filtered, firstSeen), [filtered, firstSeen])
  const sites = useMemo(() => distinct(records, 'site'), [records])
  const providers = useMemo(() => distinct(records, 'provider'), [records])

  const topMedsNamed = useMemo(
    () => a.topMedications.map((m) => ({ name: medName(m.name), value: m.value })),
    [a.topMedications, medName],
  )

  if (error) {
    return (
      <div className="screen an-screen">
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

  if (loading) {
    return (
      <div className="screen an-screen">
        <div className="an-empty">Loading visits...</div>
      </div>
    )
  }

  return (
    <div className="screen an-screen">
      <div className="an-filters" role="group" aria-label="Analytics filters">
        <label className="field">
          <span>From</span>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </label>
        <label className="field">
          <span>To</span>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </label>
        <label className="field">
          <span>Site</span>
          <select
            value={filters.site}
            onChange={(e) => setFilters((f) => ({ ...f, site: e.target.value }))}
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Provider</span>
          <select
            value={filters.provider}
            onChange={(e) => setFilters((f) => ({ ...f, provider: e.target.value }))}
          >
            <option value="">All providers</option>
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <button className="btn btn-ghost" onClick={() => setFilters(EMPTY_ANALYTICS_FILTERS)}>
          Reset
        </button>
      </div>

      {filtered.length === 0 ? (
        /* Blaming the filters on a brand-new device with zero records sent
           people hunting for a filter they never set. */
        <div className="an-empty">
          {records.length === 0
            ? 'No visits recorded on this device yet. Charts appear here once visits are saved.'
            : 'No visits match these filters. Tap Reset to see everything.'}
        </div>
      ) : (
        <>
          <div className="an-kpi-row">
            <Kpi n={a.encounters} label="Visits" />
            <Kpi n={a.patients} label="Patients" />
            <Kpi n={a.newPatients} label="New patients" sub={`${a.returnVisits} return`} />
            <Kpi n={a.referrals} label="Referrals" />
            <Kpi n={a.labPositive} label="Lab positive" sub="visits with a positive test" />
            {/* A dash, not 0: "0" under "Median age" reads as a real median. */}
            <Kpi
              n={a.medianAge}
              label="Median age"
              sub={a.medianAge === null ? 'no dates of birth' : 'years'}
            />
          </div>

          <Panel title="Visits over time" sub="Daily visits and unique patients seen">
            <TrendChart points={a.trend} />
          </Panel>

          <div className="an-grid">
            <Panel title="Age and sex">
              <AgeSexChart bands={a.ageBands} />
            </Panel>

            <Panel title="Lab positivity" sub="Share of ordered tests returning positive">
              {a.labStats.length === 0 ? (
                <div className="an-empty small">No labs ordered on these visits.</div>
              ) : (
                <ul className="an-meters">
                  {a.labStats.map((l) => (
                    <li key={l.name}>
                      <div className="an-meter-head">
                        <span>{l.name}</span>
                        <span className="an-meter-val">
                          {Math.round(l.rate * 100)}%{' '}
                          <span className="muted">
                            ({l.positive} of {l.tested} tested)
                          </span>
                        </span>
                      </div>
                      <div className="an-meter" aria-hidden="true">
                        <div className="an-meter-fill" style={{ width: `${l.rate * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <Panel title="Top diagnoses">
              <BarList items={a.topDiagnoses} empty="No diagnoses recorded." />
            </Panel>

            <Panel title="Top medications">
              <BarList items={topMedsNamed} empty="No medications dispensed." />
            </Panel>

            <Panel title="Visits by site">
              <BarList items={a.bySite} empty="No sites recorded." />
            </Panel>

            <Panel title="Visits by provider">
              <BarList items={a.byProvider} empty="No providers recorded." />
            </Panel>
          </div>

          <Panel title="Data quality" sub="Visits missing information, useful before a donor report">
            <div className="an-dq-row">
              <Dq n={a.dataQuality.missingDiagnosis} total={a.encounters} label="No diagnosis recorded" />
              <Dq n={a.dataQuality.missingVitals} total={a.encounters} label="No vitals recorded" />
              <Dq n={a.dataQuality.missingProvider} total={a.encounters} label="No provider recorded" />
            </div>
          </Panel>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Data plumbing
// ---------------------------------------------------------------------------

/** medId -> display name via the org formulary (falls back to the raw id). */
function useMedNames(): (medId: string) => string {
  const [map, setMap] = useState<Map<string, string>>(() => new Map())
  useEffect(() => {
    let alive = true
    void getConfig(config, 'formulary')
      .then((stored) => {
        if (!alive) return
        const m = new Map<string, string>()
        for (const f of resolveFormulary(stored)) m.set(f.id, f.name)
        setMap(m)
      })
      .catch(() => {
        /* names fall back to raw medIds */
      })
    return () => {
      alive = false
    }
  }, [])
  return useMemo(() => (medId: string) => map.get(medId) || medId, [map])
}

/**
 * Live width of a block container, for the SVG charts. Falls back to a fixed
 * width where ResizeObserver is missing (jsdom).
 */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w && w > 80) setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, width }
}

// ---------------------------------------------------------------------------
// Chart scaffolding
// ---------------------------------------------------------------------------

/** Round y ticks: integer steps of 1/2/5 x 10^k, about four of them. */
function yTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / 4
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)))
  const step = Math.max(
    1,
    [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10,
  )
  const out: number[] = []
  for (let v = 0; v <= Math.ceil(max / step) * step; v += step) out.push(v)
  return out
}

/** Up to n roughly evenly spaced indices into a list, always first and last. */
function tickIndices(length: number, n: number): number[] {
  if (length <= n) return Array.from({ length }, (_, i) => i)
  const out = new Set<number>()
  for (let k = 0; k < n; k++) out.add(Math.round((k * (length - 1)) / (n - 1)))
  return [...out].sort((x, y) => x - y)
}

/** DD/MM axis label ('' for records without a date). */
function shortDate(iso: string): string {
  return formatDate(iso).slice(0, 5)
}

/** Path for a column with a rounded top (data end) and square baseline. */
function roundedTopRect(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, h / 2, w / 2)
  return (
    `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y}` +
    ` L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`
  )
}

const S1 = 'var(--an-s1)'
const S2 = 'var(--an-s2)'

// ---------------------------------------------------------------------------
// Visits-over-time line chart (2 series: visits, unique patients)
// ---------------------------------------------------------------------------

function TrendChart({ points }: { points: TrendPoint[] }) {
  const { ref, width } = useWidth()
  const [hover, setHover] = useState<number | null>(null)

  const H = 240
  const L = 38
  const R = 14
  const T = 12
  const B = 26
  const plotW = Math.max(width - L - R, 40)
  const plotH = H - T - B

  const yMax = points.reduce((m, p) => Math.max(m, p.encounters), 0)
  const ticks = yTicks(yMax)
  const top = ticks[ticks.length - 1]!
  const x = (i: number) =>
    points.length > 1 ? L + (i / (points.length - 1)) * plotW : L + plotW / 2
  const y = (v: number) => T + plotH - (v / top) * plotH

  const encPts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.encounters).toFixed(1)}`)
  const patPts = points.map((p, i) => `${x(i).toFixed(1)},${y(p.patients).toFixed(1)}`)
  const area =
    `M${encPts.join(' L')} L${x(points.length - 1).toFixed(1)},${(T + plotH).toFixed(1)}` +
    ` L${x(0).toFixed(1)},${(T + plotH).toFixed(1)} Z`

  const last = points[points.length - 1]!
  const hovered = hover !== null ? points[hover] : undefined

  return (
    <div className="an-chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} aria-hidden="true" focusable="false">
        {/* recessive solid hairline grid */}
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + plotW} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text className="an-axis" x={L - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {tickIndices(points.length, 6).map((i) => (
          // The last label anchors end-ward or its overhang clips at the edge.
          <text
            key={i}
            className="an-axis"
            x={x(i)}
            y={H - 8}
            textAnchor={i === points.length - 1 ? 'end' : 'middle'}
          >
            {shortDate(points[i]!.date)}
          </text>
        ))}

        <path d={area} fill={S1} opacity={0.1} />
        <polyline
          points={encPts.join(' ')}
          fill="none"
          stroke={S1}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={patPts.join(' ')}
          fill="none"
          stroke={S2}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* end markers with a surface ring so they read over the lines */}
        <circle cx={x(points.length - 1)} cy={y(last.encounters)} r={4.5} fill={S1} stroke="var(--surface)" strokeWidth={2} />
        <circle cx={x(points.length - 1)} cy={y(last.patients)} r={4.5} fill={S2} stroke="var(--surface)" strokeWidth={2} />

        {/* hover: a hairline finds the date; one tooltip carries both series */}
        {hover !== null && hovered && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={T} y2={T + plotH} stroke="var(--ink-soft)" strokeWidth={1} />
            <circle cx={x(hover)} cy={y(hovered.encounters)} r={4.5} fill={S1} stroke="var(--surface)" strokeWidth={2} />
            <circle cx={x(hover)} cy={y(hovered.patients)} r={4.5} fill={S2} stroke="var(--surface)" strokeWidth={2} />
          </g>
        )}
        {points.map((_, i) => {
          const lo = i === 0 ? L : (x(i - 1) + x(i)) / 2
          const hi = i === points.length - 1 ? L + plotW : (x(i) + x(i + 1)) / 2
          return (
            <rect
              key={i}
              x={lo}
              y={T}
              width={Math.max(hi - lo, 1)}
              height={plotH}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
            />
          )
        })}
      </svg>

      {hover !== null && hovered && (
        <div
          className="an-tip"
          style={{ left: Math.max(0, Math.min(x(hover) + 12, width - 170)), top: T }}
        >
          <div className="an-tip-title">{formatDate(hovered.date) || 'No date'}</div>
          <div className="an-tip-row">
            <i style={{ background: 'var(--an-s1)' }} />
            <strong>{hovered.encounters}</strong>&nbsp;visits
          </div>
          <div className="an-tip-row">
            <i style={{ background: 'var(--an-s2)' }} />
            <strong>{hovered.patients}</strong>&nbsp;patients
          </div>
        </div>
      )}

      <div className="an-legend">
        <span>
          <i className="line" style={{ background: 'var(--an-s1)' }} />
          Visits
        </span>
        <span>
          <i className="line" style={{ background: 'var(--an-s2)' }} />
          Unique patients
        </span>
      </div>

      <details className="an-table">
        <summary>View data</summary>
        <div className="an-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th className="num">Visits</th>
                <th className="num">Patients</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.date || 'none'}>
                  <td>{formatDate(p.date) || 'No date'}</td>
                  <td className="num">{p.encounters}</td>
                  <td className="num">{p.patients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Age-and-sex stacked columns
// ---------------------------------------------------------------------------

function AgeSexChart({ bands }: { bands: AgeBand[] }) {
  const { ref, width } = useWidth()
  const [hover, setHover] = useState<number | null>(null)

  const H = 230
  const L = 38
  const R = 8
  const T = 12
  const B = 26
  const plotW = Math.max(width - L - R, 40)
  const plotH = H - T - B

  const yMax = bands.reduce((m, b) => Math.max(m, b.female + b.male), 0)
  const ticks = yTicks(yMax)
  const top = ticks[ticks.length - 1]!
  const slot = plotW / bands.length
  const barW = Math.min(24, Math.max(slot * 0.55, 8))
  const hPx = (v: number) => (v / top) * plotH
  const base = T + plotH
  const GAP = 2 // surface gap between stacked segments

  const hovered = hover !== null ? bands[hover] : undefined

  return (
    <div className="an-chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <svg width={width} height={H} aria-hidden="true" focusable="false">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + plotW} y1={base - hPx(t)} y2={base - hPx(t)} stroke="var(--line)" strokeWidth={1} />
            <text className="an-axis" x={L - 6} y={base - hPx(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {bands.map((b, i) => {
          const cx = L + slot * i + slot / 2
          const xLeft = cx - barW / 2
          const fH = hPx(b.female)
          const mH = hPx(b.male)
          return (
            <g key={b.band}>
              {/* female sits on the baseline; male stacks above a 2px gap */}
              {b.female > 0 &&
                (b.male > 0 ? (
                  <rect x={xLeft} y={base - fH} width={barW} height={fH} fill={S1} />
                ) : (
                  <path d={roundedTopRect(xLeft, base - fH, barW, fH)} fill={S1} />
                ))}
              {b.male > 0 && (
                <path
                  d={roundedTopRect(xLeft, base - fH - (b.female > 0 ? GAP : 0) - mH, barW, mH)}
                  fill={S2}
                />
              )}
              <text className="an-axis" x={cx} y={H - 8} textAnchor="middle">
                {b.band}
              </text>
              <rect
                x={L + slot * i}
                y={T}
                width={slot}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
              />
            </g>
          )
        })}
      </svg>

      {hover !== null && hovered && (
        <div
          className="an-tip"
          style={{
            left: Math.max(0, Math.min(L + slot * hover + slot / 2 + 10, width - 170)),
            top: T,
          }}
        >
          <div className="an-tip-title">Age {hovered.band}</div>
          <div className="an-tip-row">
            <i style={{ background: 'var(--an-s1)' }} />
            <strong>{hovered.female}</strong>&nbsp;female
          </div>
          <div className="an-tip-row">
            <i style={{ background: 'var(--an-s2)' }} />
            <strong>{hovered.male}</strong>&nbsp;male
          </div>
        </div>
      )}

      <div className="an-legend">
        <span>
          <i style={{ background: 'var(--an-s1)' }} />
          Female
        </span>
        <span>
          <i style={{ background: 'var(--an-s2)' }} />
          Male
        </span>
      </div>

      <details className="an-table">
        <summary>View data</summary>
        <div className="an-table-scroll">
          <table>
            <thead>
              <tr>
                <th>Age band</th>
                <th className="num">Female</th>
                <th className="num">Male</th>
              </tr>
            </thead>
            <tbody>
              {bands.map((b) => (
                <tr key={b.band}>
                  <td>{b.band}</td>
                  <td className="num">{b.female}</td>
                  <td className="num">{b.male}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Single-series bar list (nominal categories all wear slot 1; the value is
// printed beside every bar, so nothing depends on hover or color)
// ---------------------------------------------------------------------------

function BarList({ items, empty }: { items: Counted[]; empty: string }) {
  if (items.length === 0) return <div className="an-empty small">{empty}</div>
  const max = items.reduce((m, i) => Math.max(m, i.value), 0) || 1
  return (
    <ul className="an-bars">
      {items.map((it) => (
        <li key={it.name} className="an-bar-row">
          <span className="an-bar-name" title={it.name}>
            {it.name}
          </span>
          <svg height={14} width="100%" aria-hidden="true" focusable="false">
            <svg width={`${((it.value / max) * 100).toFixed(2)}%`} height={14}>
              {/* rounded data end, squared baseline end */}
              <rect width="100%" height={14} rx={4} fill={S1} />
              <rect width={4} height={14} fill={S1} />
            </svg>
          </svg>
          <span className="an-bar-val">{it.value}</span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function Kpi({ n, label, sub }: { n: number | null; label: string; sub?: string }) {
  return (
    <div className="an-kpi">
      <div className="an-kpi-n">{n === null ? '-' : n}</div>
      <div className="an-kpi-l">{label}</div>
      {sub && <div className="an-kpi-s">{sub}</div>}
    </div>
  )
}

function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="card an-panel">
      <div className="an-panel-head">
        <h4>{title}</h4>
        {sub && <p className="an-panel-sub">{sub}</p>}
      </div>
      {children}
    </section>
  )
}

function Dq({ n, total, label }: { n: number; total: number; label: string }) {
  const pct = total ? Math.round((n / total) * 100) : 0
  return (
    <div className="an-dq">
      <div className={`an-dq-n${pct > 25 ? ' warn' : ''}`}>{pct}%</div>
      <div className="an-dq-l">{label}</div>
      <div className="an-dq-s">
        {n} of {total} visits
      </div>
    </div>
  )
}
