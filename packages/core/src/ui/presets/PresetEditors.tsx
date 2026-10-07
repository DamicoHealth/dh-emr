/**
 * Admin editors for the Dx quick-picks and Rx prescription presets - the
 * customization surface the React port dropped (it READ the keys but had no
 * editor and no apply UI).
 *
 * Rules carried over from the spec and shipped bugs:
 *  - Admin-only. Controls are DISABLED with the reason ON the control, never
 *    enabled-but-silently-ignored.
 *  - Edits are STAGED; an explicit Save writes the config keys (the same
 *    staged-then-save pattern as the formulary editor). Each save also writes
 *    its own hiddenPresets category, merging over the STORED object at save
 *    time so unknown categories, and the other card's category, are preserved.
 *  - Removing a BUILT-IN also hides it in hiddenPresets so the removal
 *    survives sync (see presetsModel.ts). Every delete confirm quotes what
 *    happens to saved visits: their diagnoses and prescriptions are KEPT.
 *  - Formulary entry ids are permanent. The drug picker only ever references
 *    them; a preset edit or delete never touches the formulary.
 *  - An empty list is refused at save: an empty stored list would silently
 *    resolve back to the built-in defaults, which is never what "delete
 *    everything" meant. Hiding is the supported way to a bare form.
 *  - Per-line dose checks warn but never block a save.
 */
import { useEffect, useState } from 'react'
import { config } from '../../kernel'
import { getConfig, resolveFormulary, setDxPresets, setHiddenPresets, setRxPresets } from '../../config/keys'
import { defaultHiddenPresets } from '../../config/defaults/lists'
import type { FormularyEntry, HiddenPresets, RxPreset, RxPresetMed } from '../../config/types'
import { DURATIONS, FREQUENCIES } from '../../domain/constants'
import {
  DX_HIDDEN_CATEGORY,
  RX_HIDDEN_CATEGORY,
  addDxPreset,
  checkPresetLine,
  isPresetHidden,
  moveItem,
  removeDxPreset,
  removeRxPreset,
  resolveDxPresets,
  resolveRxPresets,
  rxSummary,
  withHidden,
} from './presetsModel'
import './presets.css'

/** The Field default (device gate). Clinic passes its account-gate copy in. */
const GATE_REASON = 'Only an admin device can change this. This device is set to standard.'

/** Special drug-picker value for a free-typed drug name (not a formulary id). */
const FREE_DRUG = '__free__'

type Message = { tone: 'ok' | 'bad'; text: string } | null

export interface PresetEditorsProps {
  isAdmin: boolean
  /**
   * Why editing is off when !isAdmin (gate notes and control titles). The
   * host screen decides: Field's device-role copy by default, Clinic's
   * account copy when the gate is the signed-in account.
   */
  gateReason?: string
  /** Called after a successful save so the shell can refresh dependent views. */
  onRefresh?: () => void
}

interface EditLine {
  key: string
  /** true when the drug is a free-typed name, not a formulary entry */
  free: boolean
  medId: string
  dose: string
  freq: string
  duration: string
}

interface RxBuffer {
  name: string
  notes: string
  meds: EditLine[]
}

function lineKey(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : String(Math.random())
}

function toEditLines(meds: RxPresetMed[], formulary: FormularyEntry[]): EditLine[] {
  return meds.map((m) => ({
    key: lineKey(),
    free: !!m.medId && !formulary.some((f) => f.id === m.medId),
    medId: m.medId,
    dose: m.dose,
    freq: m.freq,
    duration: m.duration,
  }))
}

export function PresetEditors({
  isAdmin,
  gateReason = GATE_REASON,
  onRefresh,
}: PresetEditorsProps) {
  const [loaded, setLoaded] = useState(false)
  const [formulary, setFormularyList] = useState<FormularyEntry[]>([])
  const [hidden, setHiddenStaged] = useState<HiddenPresets>(defaultHiddenPresets())

  // Dx card state
  const [dxList, setDxList] = useState<string[]>([])
  const [dxNew, setDxNew] = useState('')
  const [dxMessage, setDxMessage] = useState<Message>(null)
  const [dxBusy, setDxBusy] = useState(false)

  // Rx card state
  const [rxList, setRxList] = useState<RxPreset[]>([])
  const [rxMessage, setRxMessage] = useState<Message>(null)
  const [rxBusy, setRxBusy] = useState(false)
  /** Index being edited, -1 for a new preset, null when the editor is closed. */
  const [rxEditing, setRxEditing] = useState<number | null>(null)
  const [rxBuffer, setRxBuffer] = useState<RxBuffer>({ name: '', notes: '', meds: [] })

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [dxStored, rxStored, hiddenStored, formularyStored] = await Promise.all([
          getConfig(config, 'customDxPresets'),
          getConfig(config, 'rxPresets'),
          getConfig(config, 'hiddenPresets'),
          getConfig(config, 'formulary'),
        ])
        if (!alive) return
        setDxList(resolveDxPresets(dxStored))
        setRxList(resolveRxPresets(rxStored))
        setHiddenStaged(hiddenStored ?? defaultHiddenPresets())
        setFormularyList(resolveFormulary(formularyStored))
      } catch {
        if (!alive) return
        setDxList(resolveDxPresets(null))
        setRxList(resolveRxPresets(null))
        setFormularyList(resolveFormulary(null))
      }
      if (alive) setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [])

  // ------------------------------------------------------------- dx actions

  const dxRemove = (name: string): void => {
    const builtin = resolveDxPresets(null).includes(name)
    const ok = window.confirm(
      `Remove "${name}" from the diagnosis quick-picks?\n\n` +
        'Diagnoses already saved on visits keep their text - only the quick-pick button goes away.' +
        (builtin
          ? '\n\nThis is a built-in preset, so once saved it stays removed for your organization after sync.'
          : ''),
    )
    if (!ok) return
    const next = removeDxPreset(dxList, hidden, name)
    setDxList(next.list)
    setHiddenStaged(next.hidden)
  }

  const dxAdd = (): void => {
    const next = addDxPreset(dxList, hidden, dxNew)
    setDxList(next.list)
    setHiddenStaged(next.hidden)
    setDxNew('')
  }

  const dxSave = async (): Promise<void> => {
    const cleaned = [...new Set(dxList.map((n) => n.trim()).filter(Boolean))]
    if (!cleaned.length) {
      setDxMessage({
        tone: 'bad',
        text: 'The diagnosis quick-picks cannot be saved empty. Hide entries instead if you do not want them on the visit form.',
      })
      return
    }
    setDxBusy(true)
    setDxMessage(null)
    try {
      await setDxPresets(config, cleaned)
      // Merge over the STORED hidden object so the other card's category and
      // any categories written by other clients are preserved.
      const stored = (await getConfig(config, 'hiddenPresets')) ?? defaultHiddenPresets()
      await setHiddenPresets(config, { ...stored, [DX_HIDDEN_CATEGORY]: hidden[DX_HIDDEN_CATEGORY] ?? [] })
      setDxList(cleaned)
      setDxMessage({
        tone: 'ok',
        text: `Saved ${cleaned.length} diagnosis quick-pick${cleaned.length === 1 ? '' : 's'}. Reopen the visit form to see them.`,
      })
      onRefresh?.()
    } catch (e) {
      setDxMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setDxBusy(false)
    }
  }

  // ------------------------------------------------------------- rx actions

  const rxRemove = (name: string): void => {
    const builtin = resolveRxPresets(null).some((p) => p.name === name)
    const ok = window.confirm(
      `Remove the prescription preset "${name}"?\n\n` +
        'Prescriptions already saved on visits are kept, and the formulary is not changed - only the one-tap preset goes away.' +
        (builtin
          ? '\n\nThis is a built-in preset, so once saved it stays removed for your organization after sync.'
          : ''),
    )
    if (!ok) return
    const next = removeRxPreset(rxList, hidden, name)
    setRxList(next.presets)
    setHiddenStaged(next.hidden)
    if (rxEditing !== null) setRxEditing(null)
  }

  const rxOpenEditor = (index: number | null): void => {
    if (index === null) {
      setRxBuffer({ name: '', notes: '', meds: [] })
      setRxEditing(-1)
      return
    }
    const p = rxList[index]
    if (!p) return
    setRxBuffer({ name: p.name, notes: p.notes ?? '', meds: toEditLines(p.meds, formulary) })
    setRxEditing(index)
  }

  const rxCommitEditor = (): void => {
    const name = rxBuffer.name.trim()
    if (!name) {
      setRxMessage({ tone: 'bad', text: 'The preset needs a name.' })
      return
    }
    // Lines with no drug are dropped; medIds on kept lines pass through
    // VERBATIM - the editor never re-mints an id, so every prescription ever
    // written from this preset keeps pointing at the same drug.
    const meds: RxPresetMed[] = rxBuffer.meds
      .filter((l) => l.medId.trim())
      .map((l) => ({ medId: l.medId.trim(), dose: l.dose, freq: l.freq, duration: l.duration }))
    const notes = rxBuffer.notes.trim()
    const preset: RxPreset = { name, rx: rxSummary(meds, formulary), meds, ...(notes ? { notes } : {}) }
    setRxList((list) =>
      rxEditing === -1 ? [...list, preset] : list.map((p, i) => (i === rxEditing ? preset : p)),
    )
    setRxEditing(null)
    setRxMessage(null)
  }

  const rxSave = async (): Promise<void> => {
    const cleaned = rxList
      .map((p) => ({ ...p, name: p.name.trim() }))
      .filter((p) => p.name)
    if (!cleaned.length) {
      setRxMessage({
        tone: 'bad',
        text: 'The prescription presets cannot be saved empty. Hide presets instead if you do not want them on the visit form.',
      })
      return
    }
    setRxBusy(true)
    setRxMessage(null)
    try {
      await setRxPresets(config, cleaned)
      const stored = (await getConfig(config, 'hiddenPresets')) ?? defaultHiddenPresets()
      await setHiddenPresets(config, { ...stored, [RX_HIDDEN_CATEGORY]: hidden[RX_HIDDEN_CATEGORY] ?? [] })
      setRxList(cleaned)
      setRxMessage({
        tone: 'ok',
        text: `Saved ${cleaned.length} prescription preset${cleaned.length === 1 ? '' : 's'}. Reopen the visit form to see them.`,
      })
      onRefresh?.()
    } catch (e) {
      setRxMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setRxBusy(false)
    }
  }

  const patchLine = (key: string, patch: Partial<EditLine>): void => {
    setRxBuffer((b) => ({
      ...b,
      meds: b.meds.map((l) => (l.key === key ? { ...l, ...patch } : l)),
    }))
  }

  // ---------------------------------------------------------------- render

  if (!loaded) {
    return (
      <section className="card">
        <h3>Diagnosis quick-picks</h3>
        <div className="muted">Loading…</div>
      </section>
    )
  }

  const gate = !isAdmin ? gateReason : undefined

  return (
    <>
      <section className="card">
        <h3>Diagnosis quick-picks</h3>
        <p className="muted">
          Tap-to-add diagnosis buttons on the visit form; each tap appends to the diagnosis
          text. These belong to your organization - a change reaches everyone on the next sync.
        </p>
        {!isAdmin ? <p className="gate-note">{gateReason}</p> : null}
        {dxMessage ? (
          <div
            className={dxMessage.tone === 'ok' ? 'alert alert-info' : 'alert alert-bad'}
            role={dxMessage.tone === 'ok' ? 'status' : 'alert'}
          >
            {dxMessage.text}
          </div>
        ) : null}
        <div className="preset-rows">
          {dxList.map((name, i) => {
            const rowHidden = isPresetHidden(hidden, DX_HIDDEN_CATEGORY, name)
            return (
              <div className={`preset-row${rowHidden ? ' preset-row-hidden' : ''}`} key={i}>
                <input
                  type="text"
                  className="preset-name"
                  aria-label={`Diagnosis quick-pick ${i + 1}`}
                  value={name}
                  onChange={(e) =>
                    setDxList((list) => list.map((n, j) => (j === i ? e.target.value : n)))
                  }
                  disabled={!isAdmin}
                  title={gate}
                />
                {rowHidden ? <span className="muted small">hidden</span> : null}
                <button type="button" className="btn btn-ghost icon" aria-label={`Move ${name} up`}
                  onClick={() => setDxList((l) => moveItem(l, i, -1))}
                  disabled={!isAdmin || i === 0} title={gate}>↑</button>
                <button type="button" className="btn btn-ghost icon" aria-label={`Move ${name} down`}
                  onClick={() => setDxList((l) => moveItem(l, i, 1))}
                  disabled={!isAdmin || i === dxList.length - 1} title={gate}>↓</button>
                <button type="button" className="btn btn-ghost"
                  onClick={() => setHiddenStaged((h) => withHidden(h, DX_HIDDEN_CATEGORY, name, !rowHidden))}
                  disabled={!isAdmin}
                  title={gate ?? 'Hidden entries stay in the list but do not appear on the visit form.'}>
                  {rowHidden ? 'Show' : 'Hide'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => dxRemove(name)}
                  disabled={!isAdmin} title={gate}>Remove</button>
              </div>
            )
          })}
        </div>
        <div className="btn-row">
          <input
            type="text"
            className="preset-name"
            aria-label="New diagnosis quick-pick"
            placeholder="Add a diagnosis"
            value={dxNew}
            onChange={(e) => setDxNew(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                dxAdd()
              }
            }}
            disabled={!isAdmin}
            title={gate}
          />
          <button type="button" className="btn btn-ghost" onClick={dxAdd}
            disabled={!isAdmin || !dxNew.trim()} title={gate}>
            Add diagnosis
          </button>
          <button type="button" className="btn" onClick={() => void dxSave()}
            disabled={!isAdmin || dxBusy} title={gate}>
            {dxBusy ? 'Saving…' : 'Save diagnosis quick-picks'}
          </button>
        </div>
      </section>

      <section className="card">
        <h3>Prescription presets</h3>
        <p className="muted">
          One-tap prescription bundles on the visit form: applying one adds its medication lines
          to the visit. These belong to your organization - a change reaches everyone on the
          next sync.
        </p>
        {!isAdmin ? <p className="gate-note">{gateReason}</p> : null}
        {rxMessage ? (
          <div
            className={rxMessage.tone === 'ok' ? 'alert alert-info' : 'alert alert-bad'}
            role={rxMessage.tone === 'ok' ? 'status' : 'alert'}
          >
            {rxMessage.text}
          </div>
        ) : null}
        <div className="preset-rows">
          {rxList.map((p, i) => {
            const rowHidden = isPresetHidden(hidden, RX_HIDDEN_CATEGORY, p.name)
            return (
              <div className={`preset-row${rowHidden ? ' preset-row-hidden' : ''}`} key={i}>
                <div className="preset-rx-label">
                  <span className="preset-rx-name">{p.name}</span>
                  <span className="muted small">{p.rx}</span>
                </div>
                {rowHidden ? <span className="muted small">hidden</span> : null}
                <button type="button" className="btn btn-ghost icon" aria-label={`Move ${p.name} up`}
                  onClick={() => setRxList((l) => moveItem(l, i, -1))}
                  disabled={!isAdmin || i === 0 || rxEditing !== null} title={gate}>↑</button>
                <button type="button" className="btn btn-ghost icon" aria-label={`Move ${p.name} down`}
                  onClick={() => setRxList((l) => moveItem(l, i, 1))}
                  disabled={!isAdmin || i === rxList.length - 1 || rxEditing !== null} title={gate}>↓</button>
                <button type="button" className="btn btn-ghost" onClick={() => rxOpenEditor(i)}
                  disabled={!isAdmin || rxEditing !== null} title={gate}>Edit</button>
                <button type="button" className="btn btn-ghost"
                  onClick={() => setHiddenStaged((h) => withHidden(h, RX_HIDDEN_CATEGORY, p.name, !rowHidden))}
                  disabled={!isAdmin}
                  title={gate ?? 'Hidden presets stay in the list but do not appear on the visit form.'}>
                  {rowHidden ? 'Show' : 'Hide'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => rxRemove(p.name)}
                  disabled={!isAdmin || rxEditing !== null} title={gate}>Remove</button>
              </div>
            )
          })}
        </div>

        {rxEditing !== null ? (
          <div className="preset-editor">
            <h4>{rxEditing === -1 ? 'New preset' : 'Edit preset'}</h4>
            <label className="field">
              <span className="field-label">Preset name</span>
              <input
                type="text"
                value={rxBuffer.name}
                onChange={(e) => setRxBuffer((b) => ({ ...b, name: e.target.value }))}
                placeholder='For example "UTI" or "Malaria >35kg"'
                disabled={!isAdmin}
                title={gate}
              />
            </label>
            {rxBuffer.meds.map((line) => {
              const check = checkPresetLine(
                { medId: line.medId, dose: line.dose, freq: line.freq, duration: line.duration },
                formulary,
              )
              return (
                <div key={line.key}>
                  <div className="preset-med-line">
                    <select
                      aria-label="Medication"
                      value={line.free ? FREE_DRUG : line.medId}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === FREE_DRUG) {
                          patchLine(line.key, { free: true, medId: '' })
                          return
                        }
                        // Dose auto-fills from the formulary only when the dose
                        // box is empty, so a deliberate non-standard dose survives.
                        const entry = formulary.find((f) => f.id === v)
                        patchLine(line.key, {
                          free: false,
                          medId: v,
                          ...(!line.dose.trim() && entry?.dose ? { dose: entry.dose } : {}),
                        })
                      }}
                      disabled={!isAdmin}
                      title={gate}
                    >
                      <option value="">Select medication</option>
                      {formulary.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                      <option value={FREE_DRUG}>Other drug (type a name)</option>
                    </select>
                    {line.free ? (
                      <input
                        type="text"
                        aria-label="Drug name"
                        placeholder="Drug name"
                        value={line.medId}
                        onChange={(e) => patchLine(line.key, { medId: e.target.value })}
                        disabled={!isAdmin}
                        title={gate}
                      />
                    ) : null}
                    <input
                      type="text"
                      aria-label="Dose"
                      placeholder="e.g. 500mg or 2 tabs"
                      value={line.dose}
                      onChange={(e) => patchLine(line.key, { dose: e.target.value })}
                      disabled={!isAdmin}
                      title={gate}
                    />
                    <select
                      aria-label="Frequency"
                      value={line.freq}
                      onChange={(e) => patchLine(line.key, { freq: e.target.value })}
                      disabled={!isAdmin}
                      title={gate}
                    >
                      <option value="">Frequency</option>
                      {FREQUENCIES.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Duration"
                      value={line.duration}
                      onChange={(e) => patchLine(line.key, { duration: e.target.value })}
                      disabled={!isAdmin}
                      title={gate}
                    >
                      <option value="">Duration</option>
                      {DURATIONS.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                    <button type="button" className="btn btn-ghost icon" aria-label="Remove medication line"
                      onClick={() =>
                        setRxBuffer((b) => ({ ...b, meds: b.meds.filter((l) => l.key !== line.key) }))
                      }
                      disabled={!isAdmin} title={gate}>×</button>
                  </div>
                  {check ? (
                    <p className={`preset-line-check preset-line-${check.tone}`}>{check.text}</p>
                  ) : null}
                </div>
              )
            })}
            <div className="btn-row">
              <button type="button" className="btn btn-ghost"
                onClick={() =>
                  setRxBuffer((b) => ({
                    ...b,
                    meds: [
                      ...b.meds,
                      { key: lineKey(), free: false, medId: '', dose: '', freq: '', duration: '' },
                    ],
                  }))
                }
                disabled={!isAdmin} title={gate}>
                + Add medication
              </button>
            </div>
            <label className="field">
              <span className="field-label">Treatment notes added with this preset (optional)</span>
              <input
                type="text"
                value={rxBuffer.notes}
                onChange={(e) => setRxBuffer((b) => ({ ...b, notes: e.target.value }))}
                disabled={!isAdmin}
                title={gate}
              />
            </label>
            <div className="btn-row">
              <button type="button" className="btn" onClick={rxCommitEditor}
                disabled={!isAdmin} title={gate}>
                {rxEditing === -1 ? 'Add this preset' : 'Apply changes'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setRxEditing(null)}
                disabled={!isAdmin} title={gate}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div className="btn-row">
          <button type="button" className="btn btn-ghost" onClick={() => rxOpenEditor(null)}
            disabled={!isAdmin || rxEditing !== null} title={gate}>
            Add preset
          </button>
          <button type="button" className="btn" onClick={() => void rxSave()}
            disabled={!isAdmin || rxBusy || rxEditing !== null} title={gate}>
            {rxBusy ? 'Saving…' : 'Save prescription presets'}
          </button>
        </div>
      </section>
    </>
  )
}

export default PresetEditors
