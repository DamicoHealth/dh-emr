/**
 * Lab reference-range editor (REBUILD-HANDOFF 6.2) - the surface the React
 * port lost. Edits the ordered range list of ONE numeric lab test.
 *
 * Rules:
 *  - The snapshot rule is stated prominently: changing ranges affects NEW
 *    results only; visits already saved keep the interpretation recorded at
 *    the time. The save messages repeat it.
 *  - Overlapping or gapped ranges get a VISIBLE warning and never block the
 *    save - field reality is messy.
 *  - Admin-device-only editing. For a standard device the editor opens
 *    read-only with the reason shown, never enabled-but-silently-ignored.
 *  - Reordering is up/down buttons (keyboard included), not drag.
 *  - The preview runs the REAL entry-time code path (snapshotNumericLab), so
 *    the admin sees exactly what a value would record.
 *  - Persistence is the parent's job (through setLabTests with whole rows);
 *    this component only hands over the cleaned ranges.
 */
import { useMemo, useState } from 'react'
import { snapshotNumericLab } from '../../config/labInterpret'
import type { CustomLabTest, LabRange } from '../../config/types'
import { useBodyScrollLock } from '../lib/scrollLock'
import { useDialog } from '../lib/useDialog'
import {
  MATCHING_RULE_NOTE,
  RANGES_SNAPSHOT_NOTE,
  RANGE_COLORS,
  addRange,
  cleanRanges,
  draftWarnings,
  moveRange,
  rangeWarnings,
  removeRange,
  swatchColor,
  toDrafts,
  updateRange,
  withRanges,
  type RangeDraft,
  type SaveRangesResult,
} from './rangesModel'
import './labs.css'

/** Same copy as the rest of Settings; the admin gate is per DEVICE. */
const GATE_REASON = 'Only an admin device can change this. This device is set to standard.'

const DISCARD_CONFIRM = 'Discard the range changes?\n\nNothing has been saved yet.'

export interface RangeEditorProps {
  /** The lab row being edited (name, unit and current ranges are read from it). */
  test: CustomLabTest
  /** Admin DEVICE gate; standard devices get the editor read-only. */
  isAdmin: boolean
  onClose: () => void
  /** Persist the cleaned ranges; the parent owns the setLabTests write. */
  onSave: (ranges: LabRange[]) => Promise<SaveRangesResult>
}

export function RangeEditor({ test, isAdmin, onClose, onSave }: RangeEditorProps) {
  const [drafts, setDrafts] = useState<RangeDraft[]>(() => toDrafts(test.ranges))
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [previewValue, setPreviewValue] = useState('')

  const requestClose = (): void => {
    if (dirty && !saving && !window.confirm(DISCARD_CONFIRM)) return
    onClose()
  }
  const panelRef = useDialog<HTMLElement>(requestClose)
  useBodyScrollLock(true)

  const canEdit = isAdmin
  const lock = canEdit ? undefined : GATE_REASON

  const edit = (next: RangeDraft[] | null): void => {
    if (!canEdit || next === null) return
    setDrafts(next)
    setDirty(true)
  }

  const cleaned = useMemo(() => cleanRanges(drafts), [drafts])
  const warnings = useMemo(
    () => [...draftWarnings(drafts), ...rangeWarnings(cleaned)],
    [drafts, cleaned],
  )

  // The exact entry the visit form would store for the previewed value,
  // through the same code path (snapshot semantics included).
  const preview = previewValue.trim()
    ? snapshotNumericLab(withRanges(test, cleaned), previewValue.trim())
    : null
  const previewColor = preview?.interpretation
    ? swatchColor(cleaned.find((r) => r.label === preview.interpretation)?.color)
    : null

  const doSave = async (): Promise<void> => {
    if (!canEdit || saving) return
    setSaving(true)
    setNotice(null)
    try {
      const r = await onSave(cleaned)
      if (r.ok) {
        onClose()
      } else {
        setNotice(r.message)
      }
    } catch (e) {
      setNotice(
        `The ranges were not saved: ${e instanceof Error ? e.message : String(e)}. Nothing changed.`,
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="panel-backdrop" onClick={requestClose}>
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Reference ranges for ${test.name}`}
        className="panel lab-range-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="panel-head">
          <div>
            <h2>Reference ranges</h2>
            <p className="muted small lab-range-headnote">
              {test.name}
              {test.unit ? `, in ${test.unit}` : ''}. These belong to your organization; a change
              reaches everyone on the next sync.
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={requestClose}>
            Close
          </button>
        </header>

        <div className="panel-body">
          {!canEdit ? (
            <div className="alert alert-info">
              <strong>Read only</strong>
              <p>{GATE_REASON}</p>
            </div>
          ) : null}

          <div className="alert alert-info lab-snapshot-note">
            <strong>Changing ranges affects new results only.</strong>
            <p>{RANGES_SNAPSHOT_NOTE}</p>
          </div>

          {notice ? (
            <div className="alert alert-bad" role="alert">
              {notice}
            </div>
          ) : null}

          <p className="muted small">{MATCHING_RULE_NOTE}</p>

          <div className="lab-range-scroll">
            <table className="lab-range-table">
              <thead>
                <tr>
                  <th>
                    <span className="sr-only-lab">Reorder</span>
                  </th>
                  <th>Label</th>
                  <th>From (at least)</th>
                  <th>Up to (below)</th>
                  <th>Color</th>
                  <th>
                    <span className="sr-only-lab">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d, i) => {
                  const knownColor = !d.color || RANGE_COLORS.some((c) => c.value === d.color)
                  const dot = swatchColor(d.color)
                  return (
                    <tr key={d.key}>
                      <td className="lab-range-updown">
                        <button
                          type="button"
                          className="btn btn-ghost lab-range-small"
                          aria-label={`Move range ${i + 1} up`}
                          disabled={!canEdit || i === 0}
                          title={lock}
                          onClick={() => edit(moveRange(drafts, d.key, -1))}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost lab-range-small"
                          aria-label={`Move range ${i + 1} down`}
                          disabled={!canEdit || i === drafts.length - 1}
                          title={lock}
                          onClick={() => edit(moveRange(drafts, d.key, 1))}
                        >
                          ↓
                        </button>
                      </td>
                      <td>
                        <input
                          type="text"
                          aria-label={`Range ${i + 1} label`}
                          value={d.label}
                          placeholder="For example Normal"
                          disabled={!canEdit}
                          title={lock}
                          onChange={(e) => edit(updateRange(drafts, d.key, { label: e.target.value }))}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`Range ${i + 1} from`}
                          value={d.min}
                          placeholder="Open"
                          disabled={!canEdit}
                          title={lock}
                          onChange={(e) => edit(updateRange(drafts, d.key, { min: e.target.value }))}
                        />
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode="decimal"
                          aria-label={`Range ${i + 1} up to`}
                          value={d.max}
                          placeholder="Open"
                          disabled={!canEdit}
                          title={lock}
                          onChange={(e) => edit(updateRange(drafts, d.key, { max: e.target.value }))}
                        />
                      </td>
                      <td className="lab-range-colorcell">
                        {dot ? (
                          <span className="lab-swatch" style={{ backgroundColor: dot }} aria-hidden="true" />
                        ) : null}
                        <select
                          aria-label={`Range ${i + 1} color`}
                          value={d.color}
                          disabled={!canEdit}
                          title={lock}
                          onChange={(e) => edit(updateRange(drafts, d.key, { color: e.target.value }))}
                        >
                          <option value="">None</option>
                          {RANGE_COLORS.map((c) => (
                            <option key={c.value} value={c.value}>
                              {c.label}
                            </option>
                          ))}
                          {!knownColor ? <option value={d.color}>Custom ({d.color})</option> : null}
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-ghost lab-range-small"
                          aria-label={`Remove range ${i + 1}`}
                          disabled={!canEdit}
                          title={lock}
                          onClick={() => edit(removeRange(drafts, d.key))}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-ghost"
              disabled={!canEdit}
              title={lock}
              onClick={() => edit(addRange(drafts))}
            >
              Add range
            </button>
          </div>

          {warnings.length ? (
            <div className="lab-warn" role="status">
              <strong>Check these before saving (saving is still allowed):</strong>
              <ul>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="lab-preview">
            <label className="lab-preview-field">
              <span className="lab-preview-label">Try a value</span>
              <input
                type="text"
                inputMode="decimal"
                value={previewValue}
                placeholder={test.unit || 'Value'}
                onChange={(e) => setPreviewValue(e.target.value)}
              />
            </label>
            <div className="lab-preview-result" aria-live="polite">
              {preview ? (
                preview.interpretation ? (
                  <>
                    Would record {preview.value} {preview.unit} with interpretation{' '}
                    <strong style={previewColor ? { color: previewColor } : undefined}>
                      {preview.interpretation}
                    </strong>
                  </>
                ) : (
                  <>
                    Would record {preview.value} {preview.unit} with no interpretation
                  </>
                )
              ) : (
                <span className="muted">Type a value to see exactly what a new result would record.</span>
              )}
            </div>
          </div>
        </div>

        <footer className="panel-foot">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void doSave()
            }}
            disabled={!canEdit || saving}
            title={lock}
          >
            {saving ? 'Saving…' : 'Save ranges'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
        </footer>
      </aside>
    </div>
  )
}

export default RangeEditor
