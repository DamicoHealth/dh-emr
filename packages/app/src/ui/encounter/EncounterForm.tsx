/**
 * The visit entry form - the most defect-scarred surface of the product.
 * Every rule in here corresponds to a shipped bug; the contract lives in the
 * project's UI contracts and in tests/encounter.test.ts + tests/draft.test.ts.
 *
 * Two-writer discipline: EVERY user-driven state change goes through `set` or
 * `edit`, which mark dirtyRef synchronously. Raw setState is reserved for
 * seeding (the lastSite restore) and the post-save reset in doSave(true).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PatientRecord } from '../../types/record'
import { config as kernelConfig, getCurrentDeviceId, getSetting, records, setSetting } from '../../kernel'
import { getDeviceId } from '../../sync'
import { calcMedQty, type FormularyEntry } from '../../domain/medQty'
import { DURATIONS, FREQUENCIES } from '../../domain/constants'
import { UA_OPTIONS, UA_PARAMS } from '../../config/defaults/lists'
import { interpretLab } from '../../config/labInterpret'
import { loadLibrary } from '../../config/keys'
import { activeCustomFieldIds, getEffectiveSchema } from '../../config/sections'
import { isCollapsibleSection } from '../../config/validate'
import type { EffectiveSection, FormTemplate } from '../../config/types'
import { calcAge } from '../../lib/patients'
import { FieldControl, missingRequired } from '../lib/FieldControl'
import { useBodyScrollLock } from '../lib/scrollLock'
import { useDialog } from '../lib/useDialog'
import { useViewportHeight } from '../lib/useViewportHeight'
import {
  type EncounterFormState,
  type LabInput,
  dobFromAgeEstimate,
  emptyFormState,
  isoToDOBString,
  parseDOBString,
} from './formState'
import { buildRecord, newVisitFormState, returnPatientInfo, toFormState } from './serialize'
import { clearDraft, describeDraft, draftHasContent, draftMatches, readDraft, saveDraft } from './draft'
import { validateEncounter, type ValidationProblem } from './validate'
import { useEncounterConfig } from './useEncounterConfig'
import './encounter.css'

export interface EncounterFormOwnProps {
  /** the record being edited, or null for a new encounter */
  editing: PatientRecord | null
  /**
   * A previous encounter to carry IDENTITY forward from, for a new visit by an
   * existing patient. Never becomes the save target - the encounter saved is a
   * new one - so it cannot overwrite the visit it was seeded from.
   */
  seedFrom?: PatientRecord | null
  /** all records, used for MRN de-duplication and return-patient detection */
  allRecords: PatientRecord[]
  deviceId: string | null
  onSaved: (saved: PatientRecord, andNext: boolean) => void
  onClose: () => void
}

export function EncounterForm({
  editing,
  seedFrom = null,
  allRecords,
  deviceId,
  onSaved,
  onClose,
}: EncounterFormOwnProps) {
  const cfg = useEncounterConfig()
  // A draft only applies to the exact form it was typed in - same edit target
  // AND same seed patient - or one patient's answers land on another's chart.
  const [recoveredDraft] = useState(() => {
    const d = readDraft()
    return draftMatches(d, editing?.id ?? null, seedFrom?.id ?? null) ? d : null
  })
  const [state, setState] = useState<EncounterFormState>(() => {
    if (recoveredDraft) return recoveredDraft.state
    if (editing) return toFormState(editing)
    if (seedFrom) return newVisitFormState(seedFrom)
    return emptyFormState()
  })
  const [problems, setProblems] = useState<ValidationProblem[]>([])
  /** Bumped on every rejected save so a repeat tap re-scrolls to the problem. */
  const [problemNonce, setProblemNonce] = useState(0)
  /** Custom fields the last save attempt found missing, so they can be marked. */
  const missingCustomIds = useMemo(
    () => new Set(problems.filter((p) => p.fieldId).map((p) => p.fieldId as string)),
    [problems],
  )
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [schema, setSchema] = useState<{ sections: EffectiveSection[] }>({ sections: [] })
  /** Enabled templates, for the selector shown on new visits. */
  const [templates, setTemplates] = useState<FormTemplate[]>([])
  /**
   * The record currently being edited. Tracked locally so "Save & next patient"
   * can clear it immediately: if this still pointed at the previous record, the
   * next patient would be written over that record instead of creating one.
   */
  const [target, setTarget] = useState<PatientRecord | null>(editing)
  useEffect(() => {
    setTarget(editing)
  }, [editing])
  /** savedAt of the visit as it was when this form opened it. */
  const openedAtRef = useRef<string | null>(editing?.savedAt ?? null)
  useEffect(() => {
    openedAtRef.current = editing?.savedAt ?? null
  }, [editing])
  /** Has anything been typed? Guards accidental discard. */
  const dirtyRef = useRef(false)
  const [template, setTemplate] = useState<{ id: string | null; name: string }>({ id: null, name: '' })
  /**
   * Duplicate-save guard. This MUST be a ref, not the `saving` state: two taps
   * in the same tick both read the pre-render state value and both get through,
   * creating two records for one patient. A ref updates synchronously.
   */
  const savingRef = useRef(false)
  /**
   * A recovered draft is unsaved work the clinician never got to save, so the
   * form starts DIRTY. Without this, dirtyRef was false on recovery: the very
   * first Cancel tap or Escape press skipped the discard confirmation and then
   * ran clearDraft(), permanently deleting the encounter the app had just
   * handed back.
   */
  const dirtyOnMount = useRef(false)
  useBodyScrollLock(true) // the records list must not scroll behind the form
  useViewportHeight() // keep the footer above the iOS keyboard

  const set = useCallback(
    <K extends keyof EncounterFormState>(k: K, v: EncounterFormState[K]) => {
      dirtyRef.current = true
      setState((s) => ({ ...s, [k]: v }))
    },
    [],
  )

  /**
   * EVERY user-driven state change must go through `set` or `edit`. The discard
   * guard reads dirtyRef, and when writers called setState directly the guard
   * missed labs, medications, urinalysis, DOB, procedures and custom fields -
   * so a nearly complete encounter could be discarded with no prompt at all.
   * Raw setState is reserved for seeding and the post-save reset below.
   */
  const edit = useCallback((fn: (s: EncounterFormState) => EncounterFormState) => {
    dirtyRef.current = true
    setState(fn)
  }, [])

  /** Close, but never silently throw away typed work. Escape routes here too. */
  const requestClose = useCallback(() => {
    if (dirtyRef.current && !window.confirm('Discard this visit? Anything you have entered will be lost.')) return
    clearDraft() // an explicit discard must not come back
    onClose()
  }, [onClose])

  // Focus in on open, trap Tab inside the panel, Escape closes through the
  // discard guard, and focus returns to whatever opened it.
  const panelRef = useDialog<HTMLElement>(requestClose)

  // --- MRN: derived, never hand-typed -------------------------------------
  // Same patient (same base MRN AND same name) reuses their number; a different
  // patient sharing initials+DOB gets a B/C/D suffix (resolveMrnSuffix owns
  // the letter rule).
  const returnPatient = useMemo(
    () =>
      returnPatientInfo(state.givenName, state.familyName, state.dobIso, allRecords, editing?.id ?? null),
    [state.givenName, state.familyName, state.dobIso, allRecords, editing?.id],
  )

  useEffect(() => {
    // For an EXISTING record keep the stored MRN unless the clinician actually
    // changed a name or the DOB. Recomputing on mount could hand the record a
    // new suffixed number and detach it from the patient's other visits.
    if (target) {
      const unchanged =
        state.givenName === (target.givenName || '') &&
        state.familyName === (target.familyName || '') &&
        state.dobIso === (target.dob || '')
      if (unchanged) {
        if (state.mrn !== (target.mrn || '')) set('mrn', target.mrn || '')
        return
      }
    }
    if (returnPatient.mrn && returnPatient.mrn !== state.mrn) set('mrn', returnPatient.mrn)
  }, [returnPatient.mrn, state.mrn, state.givenName, state.familyName, state.dobIso, target, set])

  const lastVisit = returnPatient.prior.length
    ? [...returnPatient.prior].sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] ?? null
    : null

  /** Carry history forward from the patient's last visit - always explicit. */
  const carryForward = () => {
    if (!lastVisit) return
    edit((s) => ({
      ...s,
      allergies: s.allergies || lastVisit.allergies || '',
      pmh: s.pmh || lastVisit.pmh || '',
      currentMeds: s.currentMeds || lastVisit.currentMeds || '',
      phone: s.phone || lastVisit.phone || '',
    }))
  }

  // Remember the site between patients, as the legacy form did - otherwise the
  // required Site has to be re-picked for every single encounter.
  useEffect(() => {
    if (editing) return
    let alive = true
    void getSetting<string>('lastSite').then((last) => {
      if (alive && last) setState((s) => (s.site ? s : { ...s, site: last }))
    })
    return () => {
      alive = false
    }
  }, [editing])

  // Load the org's form schema for this record's template. Custom sections and
  // any hide/rename/reorder the admin configured are applied from here.
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const lib = await loadLibrary(kernelConfig)
        const matched = editing?.templateId
          ? lib.templates.find((t) => t.id === editing.templateId)
          : undefined
        const tpl = matched ?? lib.templates.find((t) => t.enabled !== false) ?? lib.templates[0]
        if (!alive || !tpl) return
        setTemplates(lib.templates.filter((t) => t.enabled !== false))
        setSchema(getEffectiveSchema(tpl.schema))
        // If the record's own template is gone, render the fallback's layout but
        // KEEP the record's stored id/name - relabelling it with an unrelated
        // template would misfile the encounter.
        setTemplate(
          matched || !editing
            ? { id: tpl.id, name: tpl.name }
            : { id: editing.templateId, name: editing.templateName || '' },
        )
      } catch (e) {
        console.warn('[form] could not load the form schema; using built-ins', e)
        setSchema(getEffectiveSchema(null))
      }
    })()
    return () => {
      alive = false
    }
  }, [editing?.templateId])

  /**
   * Sex = M hides the pregnancy fields, but ONLY a user action clears them.
   * Doing it in an effect also ran on mount, so simply opening a male patient's
   * record silently erased any pregnancy/breastfeeding value already stored.
   */
  const setSex = useCallback(
    (v: string) => {
      // Through edit(), like every other user-driven write. Setting dirtyRef by
      // hand here is what the rest of the form used to do, and forgetting it in
      // twelve other places is exactly how a full encounter got discarded with
      // no prompt.
      edit((s) => (v === 'M' ? { ...s, sex: v, pregnant: '', breastfeeding: '' } : { ...s, sex: v }))
    },
    [edit],
  )

  useEffect(() => {
    if (!problems.length) return
    const body = bodyRef.current
    const first =
      body?.querySelector<HTMLElement>('[data-invalid="true"]') ??
      body?.querySelector<HTMLElement>('.alert-bad')
    // Instant, not smooth: on a long form the jump can be ~3000px, which takes
    // over a second to animate. For a second or more after tapping Save the
    // clinician sees nothing happen, which is the problem this is fixing.
    first?.scrollIntoView({ block: 'center', behavior: 'auto' })
    // Announce to a screen reader as well as moving the view.
    first?.focus?.({ preventScroll: true })
  }, [problems, problemNonce])

  useEffect(() => {
    if (!savedNote) return
    const t = setTimeout(() => setSavedNote(null), 4000)
    return () => clearTimeout(t)
  }, [savedNote])

  useEffect(() => {
    if (recoveredDraft && !dirtyOnMount.current) {
      dirtyOnMount.current = true
      dirtyRef.current = true // recovered work must be guarded like typed work
    }
  }, [recoveredDraft])

  // Persist to sessionStorage as the clinician types. iOS discards background
  // tabs on memory pressure and the whole encounter went with it.
  useEffect(() => {
    if (!dirtyRef.current || !draftHasContent(state)) return
    saveDraft(state, target?.id ?? null, seedFrom?.id ?? null)
  }, [state, target, seedFrom])

  const age = state.dobIso ? calcAge(state.dobIso) : null
  const problemFor = (f: keyof EncounterFormState) => problems.find((p) => p.field === f)

  async function doSave(andNext: boolean) {
    if (savingRef.current) return // synchronous: a double-tap cannot duplicate
    const found = validateEncounter(state)
    // Required admin-defined fields are enforced as well; the legacy builder
    // could set `required` in a starter template but nothing ever checked it.
    for (const sec of schema.sections) {
      if (sec.builtin || sec.hidden) continue
      for (const f of missingRequired(sec.fields, state.customFields)) {
        found.push({ field: 'customFields', message: `${sec.title}: ${f.label} is required.`, fieldId: f.id })
      }
    }
    setProblems(found)
    if (found.length) {
      // Do NOT scroll here. React batches, so data-invalid is not in the DOM
      // yet and this found nothing - on a long form scrolled to the bottom the
      // first tap of Save produced no visible change whatsoever. The effect
      // above runs after the commit, when the invalid fields actually exist.
      setProblemNonce((n) => n + 1)
      return
    }
    savingRef.current = true
    setSaving(true)
    setSaveError(null)
    try {
      // Did this visit change underneath us while the form was open?
      //
      // The cloud push is an unconditional upsert, so two devices editing the
      // same visit is last-writer-wins and the other clinician's work vanishes
      // with nothing said. We cannot change that in the sync engine from here,
      // but we CAN refuse to be the one that silently discards it: if the
      // stored savedAt has moved since this form opened, ask first.
      if (target) {
        // Including tombstones: the active-records getter filters deleted
        // records out, so a visit deleted on another device resolved to
        // undefined, the guard no-opped, and saving resurrected the deletion
        // across the fleet.
        const all = await records.getAll()
        const current = all.find((r) => r.id === target.id)
        if (current?.deleted) {
          const ok = window.confirm(
            'This visit was DELETED on another device while you had it open.\n\n' +
              'Saving now brings it back for everyone. Cancel instead if the deletion was correct.',
          )
          if (!ok) {
            savingRef.current = false
            setSaving(false)
            return
          }
        } else if (current && current.savedAt && openedAtRef.current && current.savedAt !== openedAtRef.current) {
          const who = current.deviceId && current.deviceId !== deviceId ? 'another device' : 'this device'
          const ok = window.confirm(
            'This visit was changed on ' + who + ' while you had it open.\n\n' +
              'Saving now replaces those changes with what is on your screen. ' +
              'Cancel instead to close without saving and reopen the visit to see them first.',
          )
          if (!ok) {
            savingRef.current = false
            setSaving(false)
            return
          }
        }
      }
      const rec = buildRecord(state, {
        prev: target,
        deviceId,
        templateId: target?.templateId ?? template.id,
        // Keep the record's stored name if its template was deleted.
        templateName: template.name || target?.templateName || '',
        activeCustomFieldIds: activeCustomFieldIds(schema.sections),
        formulary: cfg.formulary,
        frequencies: FREQUENCIES.map((f) => ({ value: f.value, label: f.label })),
        now: new Date().toISOString(),
        newId: () => crypto.randomUUID(),
      })
      await records.save(rec)
      openedAtRef.current = rec.savedAt // this save is now the baseline
      if (rec.site) void setSetting('lastSite', rec.site)
      clearDraft() // the encounter is filed; the draft is now stale
      dirtyRef.current = false
      onSaved(rec, andNext)
      if (andNext) {
        // Detach from the saved record BEFORE the next patient is typed.
        setTarget(null)
        dirtyRef.current = false
        // Keep site + date for the next patient, exactly like Save & Next.
        const next = emptyFormState()
        next.site = rec.site
        next.date = rec.date
        next.provider = rec.provider
        setState(next)
        setProblems([])
        setSavedNote(`Saved ${rec.name || 'the visit'}${rec.mrn ? ` (${rec.mrn})` : ''}. Ready for the next patient.`)
        bodyRef.current?.scrollTo({ top: 0 })
      }
    } catch (e) {
      // A storage failure must be visible - never a silent "saved".
      setSaveError(e instanceof Error ? e.message : String(e))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // Content for each built-in section, keyed by its schema id. Rendering is
  // driven by the schema below, so an admin can hide, rename or REORDER these
  // and custom sections interleave by `order` during entry - the legacy form
  // always rendered custom sections last regardless of their order.
  const builtinBody: Record<string, ReactNode> = {
    encounter: (
      <Row>
        <Field label="Site" required problem={problemFor('site')}>
          <select value={state.site} onChange={(e) => set('site', e.target.value)}>
            <option value="">Select a site</option>
            {cfg.sites.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </Field>
        <Field label="Date" required problem={problemFor('date')}>
          <input type="date" value={state.date} onChange={(e) => set('date', e.target.value)} />
        </Field>
        <Field label="Provider">
          <select value={state.provider} onChange={(e) => set('provider', e.target.value)}>
            <option value="">Select</option>
            {cfg.providers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </Field>
      </Row>
    ),
    patient: (
      <>
        <Row>
          <Field label="Given name" required problem={problemFor('givenName')}>
            <input value={state.givenName} onChange={(e) => set('givenName', e.target.value)}
              autoCapitalize="words" autoComplete="off" />
          </Field>
          <Field label="Family name" required problem={problemFor('familyName')}>
            <input value={state.familyName} onChange={(e) => set('familyName', e.target.value)}
              autoCapitalize="words" autoComplete="off" />
          </Field>
          <Field label="Sex" required control="group" problem={problemFor('sex')}>
            <ToggleGroup value={state.sex} options={['M', 'F']} onChange={setSex} />
          </Field>
        </Row>
        <Row>
          {!state.dobUnknown ? (
            <Field label="Date of birth" required problem={problemFor('dobText')} hint="DD/MM/YYYY">
              <input inputMode="numeric" placeholder="DD/MM/YYYY" value={state.dobText}
                onChange={(e) => {
                  const text = e.target.value
                  edit((st) => ({ ...st, dobText: text, dobIso: parseDOBString(text) }))
                }} />
            </Field>
          ) : (
            <Field label="Estimated age" required problem={problemFor('ageEstimate')} hint="years">
              <input inputMode="numeric" value={state.ageEstimate}
                onChange={(e) => {
                  const v = e.target.value
                  const iso = dobFromAgeEstimate(v)
                  edit((st) => ({ ...st, ageEstimate: v, dobIso: iso, dobText: isoToDOBString(iso) }))
                }} />
            </Field>
          )}
          <Field label="Date of birth unknown" control="group">
            <label className="check">
              <input type="checkbox" checked={state.dobUnknown}
                onChange={(e) =>
                  edit((st) => ({
                    ...st,
                    dobUnknown: e.target.checked,
                    ageEstimate: '',
                    dobIso: '',
                    dobText: '',
                  }))
                } />
              <span>Estimate from age</span>
            </label>
          </Field>
          <Field label="Phone">
            <input inputMode="tel" value={state.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
        </Row>
        <Row>
          <Field label="Patient number" hint="generated automatically">
            <input value={state.mrn} readOnly className="readonly" />
          </Field>
        </Row>
      </>
    ),
    vitals: (
      <>
        <Row>
          <Field label="Temperature" hint="°C" problem={problemFor('temp')}>
            <input inputMode="decimal" value={state.temp} onChange={(e) => set('temp', e.target.value)} />
          </Field>
          <Field label="Blood pressure" hint="e.g. 120/80">
            <input value={state.bp} onChange={(e) => set('bp', e.target.value)} />
          </Field>
          <Field label="Weight" hint="kg">
            <input inputMode="decimal" value={state.weight} onChange={(e) => set('weight', e.target.value)} />
          </Field>
        </Row>
        {state.sex !== 'M' && (
          <Row>
            <Field label="Pregnant" control="group">
              <ToggleGroup value={state.pregnant} options={['Yes', 'No']} onChange={(v) => set('pregnant', v)} />
            </Field>
            <Field label="Breastfeeding" control="group">
              <ToggleGroup value={state.breastfeeding} options={['Yes', 'No']} onChange={(v) => set('breastfeeding', v)} />
            </Field>
          </Row>
        )}
      </>
    ),
    history: (
      <>
        <Field label="Allergies">
          <input value={state.allergies} onChange={(e) => set('allergies', e.target.value)} />
        </Field>
        <Field label="Current medications">
          <input value={state.currentMeds} onChange={(e) => set('currentMeds', e.target.value)} />
        </Field>
        <Field label="Past medical history">
          <textarea rows={2} value={state.pmh} onChange={(e) => set('pmh', e.target.value)} />
        </Field>
      </>
    ),
    chiefConcern: (
      <>
        <Field label="Chief concern">
          <textarea rows={2} value={state.chiefConcern} onChange={(e) => set('chiefConcern', e.target.value)} />
        </Field>
        {cfg.complaints.length > 0 && (
          <PillGroup options={cfg.complaints} selected={state.complaints}
            onToggle={(v) =>
              edit((st) => {
                // APPEND to the narrative, never replace it. Replacing destroyed
                // whatever the clinician had typed on the first pill tap.
                const on = st.complaints.includes(v)
                const complaints = on ? st.complaints.filter((x) => x !== v) : [...st.complaints, v]
                const parts = st.chiefConcern.split(';').map((x) => x.trim()).filter(Boolean)
                const next = on ? parts.filter((x) => x !== v) : parts.includes(v) ? parts : [...parts, v]
                return { ...st, complaints, chiefConcern: next.join('; ') }
              })
            } />
        )}
      </>
    ),
    labs: (
      <>
        <div className="lab-grid">
          {cfg.labTests.map((t) => {
            const cur = state.labs[t.name]
            const ordered = !!cur?.ordered
            return (
              <div className={`lab${ordered ? ' on' : ''}`} key={t.id}>
                <div className="lab-name">{t.name}</div>
                {t.type === 'toggle' ? (
                  <ToggleGroup
                    value={cur?.kind === 'toggle' && ordered ? cur.result : ''}
                    options={['POS', 'NEG']}
                    onChange={(v) =>
                      edit((st) => {
                        const labs = { ...st.labs }
                        if (!v) delete labs[t.name]
                        else labs[t.name] = { kind: 'toggle', ordered: true, result: v } as LabInput
                        return { ...st, labs }
                      })
                    }
                  />
                ) : (
                  <input inputMode="decimal" placeholder={t.unit || ''}
                    value={cur?.kind === 'numeric' && ordered ? cur.value : ''}
                    onChange={(e) =>
                      edit((st) => {
                        const labs = { ...st.labs }
                        const v = e.target.value
                        if (!v) delete labs[t.name]
                        else
                          labs[t.name] = {
                            kind: 'numeric',
                            ordered: true,
                            value: v,
                            unit: t.unit || '',
                            interpretation: interpretLab(v, t.ranges),
                          } as LabInput
                        return { ...st, labs }
                      })
                    } />
                )}
              </div>
            )
          })}
        </div>
        <Field label="Lab comments">
          <input value={state.labComments} onChange={(e) => set('labComments', e.target.value)} />
        </Field>
        <div className="subhead">Urinalysis</div>
        <div className="ua-grid">
          {UA_PARAMS.map((pp) => (
            <Field key={pp} label={pp} control="group">
              <ToggleGroup value={state.urinalysis[pp] || ''} options={UA_OPTIONS[pp] || []} small
                onChange={(v) => edit((st) => ({ ...st, urinalysis: { ...st.urinalysis, [pp]: v } }))} />
            </Field>
          ))}
        </div>
      </>
    ),
    diagnosis: (
      <Field label="Diagnosis">
        <textarea rows={2} value={state.diagnosis} onChange={(e) => set('diagnosis', e.target.value)} />
      </Field>
    ),
    medications: (
      <>
        {state.medications.map((m, i) => (
          <div className="med-line" key={m.id}>
            <select value={m.medId} onChange={(e) => {
              // Prefill the dose from the formulary, as the legacy form did.
              // Without it the Dose box stayed empty, calcMedQty had nothing
              // to parse, and the dispensing quantity came out null - a
              // silently wrong pharmacy count. Only when empty, so a
              // deliberate non-standard dose survives.
              const medId = e.target.value
              const entry = cfg.formulary.find((x) => x.id === medId)
              updateMed(edit, i, {
                medId,
                ...(!m.dose.trim() && entry?.dose ? { dose: entry.dose } : {}),
              })
            }}>
              <option value="">Select medication</option>
              {cfg.formulary.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <input placeholder="e.g. 500mg or 2 tabs" value={m.dose}
              onChange={(e) => updateMed(edit, i, { dose: e.target.value })} />
            <select value={m.freq} onChange={(e) => updateMed(edit, i, { freq: e.target.value })}>
              <option value="">Frequency</option>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
            <select value={m.duration} onChange={(e) => updateMed(edit, i, { duration: e.target.value })}>
              <option value="">Duration</option>
              {DURATIONS.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <MedQtyPreview med={m} formulary={cfg.formulary} />
            <button className="btn btn-ghost icon" aria-label="Remove medication"
              onClick={() => edit((st) => ({ ...st, medications: st.medications.filter((_, j) => j !== i) }))}>×</button>
          </div>
        ))}
        <button className="btn btn-ghost" onClick={() =>
          edit((st) => ({
            ...st,
            medications: [...st.medications, { id: crypto.randomUUID(), medId: '', dose: '', freq: '', duration: '' }],
          }))
        }>+ Add medication</button>
        <Field label="Treatment notes">
          <textarea rows={2} value={state.treatmentNotes} onChange={(e) => set('treatmentNotes', e.target.value)} />
        </Field>
      </>
    ),
    procedures:
      cfg.procedures.length > 0 ? (
        <PillGroup options={cfg.procedures} selected={state.procedures}
          onToggle={(v) =>
            edit((st) => ({
              ...st,
              procedures: st.procedures.includes(v) ? st.procedures.filter((x) => x !== v) : [...st.procedures, v],
            }))
          } />
      ) : null,
    referral: (
      <Row>
        <Field label="Referral type">
          <select value={state.referralType} onChange={(e) => set('referralType', e.target.value)}>
            <option value="None">None</option>
            {cfg.referralTypes.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </Field>
        {state.referralType !== 'None' && (
          <Field label="Scheduled date">
            <input type="date" value={state.referralDate} onChange={(e) => set('referralDate', e.target.value)} />
          </Field>
        )}
      </Row>
    ),
    imaging: (
      <Row>
        <Field label="Ultrasound type">
          <input value={state.imagingType} onChange={(e) => set('imagingType', e.target.value)} />
        </Field>
        <Field label="Findings">
          <input value={state.imagingFindings} onChange={(e) => set('imagingFindings', e.target.value)} />
        </Field>
      </Row>
    ),
    surgery: (
      <>
        <Field label="Surgery performed" control="group">
          <label className="check">
            <input type="checkbox" checked={state.surgeryPerformed}
              onChange={(e) => set('surgeryPerformed', e.target.checked)} />
            <span>Yes</span>
          </label>
        </Field>
        {state.surgeryPerformed && (
          <Row>
            <Field label="Type">
              <input value={state.surgeryType} onChange={(e) => set('surgeryType', e.target.value)} />
            </Field>
            <Field label="Notes">
              <input value={state.surgeryNotes} onChange={(e) => set('surgeryNotes', e.target.value)} />
            </Field>
          </Row>
        )}
      </>
    ),
    notes: <textarea rows={3} value={state.notes} onChange={(e) => set('notes', e.target.value)} />,
  }

  return (
    /* No onClick here: on a landscape iPad the panel leaves an 84px strip of
       bare backdrop, and brushing it with a gloved hand threw the encounter
       away. Closing a form with typed work in it takes an explicit Cancel. */
    <div className="panel-backdrop">
      <aside ref={panelRef} tabIndex={-1} className="panel panel-wide" role="dialog" aria-modal="true"
        aria-label={target ? 'Edit visit' : 'New visit'}>
        <header className="panel-head">
          <div>
            <div className="panel-title">
              {target ? 'Edit visit' : seedFrom ? `New visit for ${seedFrom.name || 'this patient'}` : 'New visit'}
            </div>
            <div className="panel-sub">
              {state.mrn ? `Patient number ${state.mrn}` : 'Patient number generates from name + date of birth'}
              {age !== null ? ` · ${age}y` : ''}
            </div>
          </div>
          <button className="btn btn-ghost" onClick={requestClose}>Cancel</button>
        </header>

        <div className="panel-body" ref={bodyRef}>
          {recoveredDraft && (
            <div className="alert alert-info" role="status">
              <strong>Recovered from where you left off.</strong>
              <p>
                This device closed the app before this visit was saved. Recovered for{' '}
                <strong>{describeDraft(recoveredDraft)}</strong>. Check every field before
                saving, then save as usual.
              </p>
            </div>
          )}
          {savedNote && (
            <div className="alert alert-ok" role="status">{savedNote}</div>
          )}
          {saveError && (
            <div className="alert alert-bad">
              <strong>Not saved</strong>
              <p>{saveError}</p>
            </div>
          )}
          {problems.length > 0 && (
            <div className="alert alert-bad" role="alert" tabIndex={-1}>
              <strong>Check {problems.length} field{problems.length === 1 ? '' : 's'}</strong>
              <ul className="problem-list">
                {problems.map((p) => (
                  <li key={String(p.field) + p.message}>{p.message}</li>
                ))}
              </ul>
            </div>
          )}

          {lastVisit && !target && (
            <div className="alert alert-info">
              <strong>Returning patient</strong>
              <p>
                {returnPatient.prior.length} previous visit{returnPatient.prior.length === 1 ? '' : 's'}
                {lastVisit.date ? ` · last seen ${lastVisit.date}` : ''}
                {lastVisit.diagnosis ? ` · ${lastVisit.diagnosis}` : ''}
              </p>
              <button className="btn btn-ghost" onClick={carryForward}>
                Copy allergies, history and medications forward
              </button>
            </div>
          )}

          {!target && templates.length > 1 && (
            <Field label="Form template">
              <select
                value={template.id ?? ''}
                onChange={(e) => {
                  const t = templates.find((x) => x.id === e.target.value)
                  if (!t) return
                  // Answers already typed under another template are kept in
                  // state and preserved on save by mergeCustomFields, which
                  // only clears fields the ACTIVE template renders.
                  setTemplate({ id: t.id, name: t.name })
                  setSchema(getEffectiveSchema(t.schema))
                }}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </Field>
          )}

          {schema.sections.filter((sec) => !sec.hidden).map((sec) => {
            if (!sec.builtin) {
              // Admin-defined section, rendered from its stored field list.
              if (!sec.fields.length) return null
              // A collapsed section hides its inputs, so a required answer would
              // be unreachable while Save silently refused.
              return (
                <Section key={sec.id} title={sec.title} collapsible={isCollapsibleSection(sec)}>
                  {sec.fields.map((f) => (
                    <FieldControl key={f.id} field={f}
                      invalid={missingCustomIds.has(f.id)}
                      value={state.customFields[f.id] ?? null}
                      onChange={(v) => edit((st) => ({ ...st, customFields: { ...st.customFields, [f.id]: v } }))} />
                  ))}
                </Section>
              )
            }
            const body = builtinBody[sec.id]
            if (!body) return null // built-in with no rendered body
            return (
              <Section key={sec.id} title={sec.title} collapsible={isCollapsibleSection(sec)}>
                {body}
              </Section>
            )
          })}
        </div>

        <footer className="panel-foot">
          <button className="btn btn-ghost" onClick={requestClose} disabled={saving}>Cancel</button>
          {!target && (
            <button className="btn btn-ghost" onClick={() => void doSave(true)} disabled={saving}>
              {saving ? 'Saving…' : 'Save & next patient'}
            </button>
          )}
          <button className="btn" onClick={() => void doSave(false)} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </footer>
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------- helpers ---

function updateMed(
  setState: (fn: (s: EncounterFormState) => EncounterFormState) => void,
  index: number,
  patch: Partial<EncounterFormState['medications'][number]>,
) {
  setState((s) => ({
    ...s,
    medications: s.medications.map((m, i) => (i === index ? { ...m, ...patch } : m)),
  }))
}

function Section({ title, children, collapsible }: { title: string; children: ReactNode; collapsible?: boolean }) {
  const [open, setOpen] = useState(!collapsible)
  return (
    <section className="card form-section">
      <button className="section-head" onClick={() => collapsible && setOpen((o) => !o)}
        aria-expanded={open} disabled={!collapsible}>
        <h4>{title}</h4>
        {collapsible && <span className="chev">{open ? '−' : '+'}</span>}
      </button>
      {open && <div className="section-body">{children}</div>}
    </section>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="form-row">{children}</div>
}

function Field({ label, children, required, hint, problem, control = 'input' }: {
  label: string
  children: ReactNode
  required?: boolean
  hint?: string
  problem?: ValidationProblem
  /** 'group' for toggle/checkbox groups: a <label> would forward a tap on the
   *  caption to the FIRST button, silently setting a clinical value (tapping
   *  "Date of birth unknown" cleared the DOB; tapping "Sex" selected M). */
  control?: 'input' | 'group'
}) {
  const inner = (
    <>
      <span className="form-label">
        {label}
        {required && <span className="req" aria-hidden="true"> *</span>}
        {hint && <span className="hint"> {hint}</span>}
      </span>
      {children}
      {problem && <span className="err">{problem.message}</span>}
    </>
  )
  // 'field' rides along so the shell's input/label styling and its
  // data-invalid hooks apply without duplicating base.css here.
  const cls = `field form-field${problem ? ' invalid' : ''}`
  const invalid = problem ? 'true' : undefined
  return control === 'group' ? (
    <div className={cls} data-invalid={invalid} role="group" aria-label={label}>{inner}</div>
  ) : (
    <label className={cls} data-invalid={invalid}>{inner}</label>
  )
}

function ToggleGroup({ value, options, onChange, small }: {
  value: string
  options: readonly string[]
  onChange: (v: string) => void
  small?: boolean
}) {
  return (
    <div className={`toggle-group${small ? ' small' : ''}`} role="group">
      {options.map((o) => (
        <button key={o} type="button"
          className={`toggle${value === o ? ' active' : ''}`}
          aria-pressed={value === o}
          onClick={() => onChange(value === o ? '' : o)}>{o}</button>
      ))}
    </div>
  )
}

function PillGroup({ options, selected, onToggle }: {
  options: string[]
  selected: string[]
  onToggle: (v: string) => void
}) {
  return (
    <div className="pill-group">
      {options.map((o) => (
        <button key={o} type="button"
          className={`pill${selected.includes(o) ? ' active' : ''}`}
          aria-pressed={selected.includes(o)}
          onClick={() => onToggle(o)}>{o}</button>
      ))}
    </div>
  )
}

/**
 * Show the dispensing quantity the moment it can be worked out.
 *
 * The quantity is parsed out of the free-text Dose box at serialization time
 * and written onto the record, but nothing on screen ever showed it. A dose
 * string calcMedQty cannot read - "one tablet", "5ml", a blank box - yields no
 * quantity at all, and the pharmacy count was silently wrong with nothing to
 * notice. Showing it inline makes the parse visible while it can still be
 * corrected.
 */
function MedQtyPreview({ med, formulary }: {
  med: EncounterFormState['medications'][number]
  formulary: FormularyEntry[]
}) {
  if (!med.medId) return null
  const q = calcMedQty(med.medId, med.dose, med.freq, med.duration, formulary)
  if (q && !q.assumed) return <span className="med-qty" title="Quantity to dispense">{q.qty} {q.unit}</span>
  if (q) {
    // The number is still recorded, but it rests on a guess of 1 per dose.
    return (
      <span className="med-qty med-qty-bad"
        title={`The dose "${med.dose}" could not be read, so this assumes 1 ${q.unit.replace(/s$/, '')} per dose. Write it as a number of tabs or in mg.`}>
        {q.qty} {q.unit}?
      </span>
    )
  }
  // Only complain once the prescription is otherwise complete - a half-filled
  // row is not an error, it is a row being filled in.
  const complete = med.dose.trim() && med.freq && med.duration
  if (!complete) return null
  if (med.duration === 'Ongoing') return <span className="med-qty muted">ongoing</span>
  return (
    <span className="med-qty med-qty-bad" title="The dose could not be read, so no quantity will be recorded">
      no qty
    </span>
  )
}

// ------------------------------------------------------------- shell shim ---

/**
 * Default export for the current shell (src/App.tsx), which renders the visit
 * panel with only { onClose, onSaved } and no edit target. It loads the
 * records snapshot and device id the full form needs, then mounts it for a
 * plain new visit. The shell should eventually render <EncounterForm> itself
 * with real props (edit/new-visit-for flows live in the records screen).
 */
export interface EncounterFormProps {
  /** Close the panel. The real form intercepts this with a discard confirm. */
  onClose: () => void
  /**
   * Notify the shell that a visit was saved so lists refresh. andNext is
   * false for a plain Save (the shell should close the panel) and true for
   * Save & next patient (the form has already reset for the next entry and
   * must stay open).
   */
  onSaved?: (saved: PatientRecord, andNext: boolean) => void
}

export default function EncounterFormHost({ onClose, onSaved }: EncounterFormProps) {
  const [loaded, setLoaded] = useState<{ all: PatientRecord[]; deviceId: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      let all: PatientRecord[] = []
      try {
        all = await records.getAll()
      } catch {
        // An unreadable store surfaces through the shell's health banner; the
        // form still opens (the kernel's wipe guard protects the save path).
      }
      let deviceId: string | null = getCurrentDeviceId()
      if (!deviceId) {
        try {
          deviceId = await getDeviceId()
        } catch {
          deviceId = null
        }
      }
      if (alive) setLoaded({ all, deviceId })
    })()
    return () => {
      alive = false
    }
  }, [])
  if (!loaded) return null
  return (
    <EncounterForm
      editing={null}
      seedFrom={null}
      allRecords={loaded.all}
      deviceId={loaded.deviceId}
      onSaved={(saved, andNext) => onSaved?.(saved, andNext)}
      onClose={onClose}
    />
  )
}
