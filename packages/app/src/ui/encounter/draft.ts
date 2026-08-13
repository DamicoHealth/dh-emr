/**
 * Survive the tab going away mid-encounter.
 *
 * The form holds its state in React only. iOS discards background tabs
 * aggressively on memory pressure - answering a phone call, opening the camera
 * to check a rash, or the screen simply locking for long enough can all do it -
 * and the whole encounter is gone with no trace. A clinician mid-way through a
 * complicated patient loses everything and has to ask them all of it again.
 *
 * The draft is kept in sessionStorage, deliberately:
 *  - it survives a reload and a tab discard, which is the failure we are fixing
 *  - it does NOT persist across a full app close, so a stale draft cannot
 *    surface days later and get filed against the wrong patient
 *  - it is per-tab, so two tabs cannot fight over one draft
 *
 * It holds real patient data, so clearing on save and on discard is not
 * optional. Everything that ends an encounter calls clearDraft().
 */
import { storageSuffix } from '../../kernel'
import type { EncounterFormState } from './formState'

// The suffix comes from the kernel's single namespace source (the build
// define), so a demo/preview build can never hand its draft to production on
// the same origin. Production (and tests) get the bare key.
const KEY = () => 'dhemr' + storageSuffix() + '_encounter_draft'

export interface Draft {
  state: EncounterFormState
  /** id of the record being edited, or null for a new encounter */
  editingId: string | null
  /**
   * id of the visit a NEW VISIT was seeded from, or null.
   *
   * Matching on editingId alone was not enough: an abandoned new-encounter
   * draft has editingId null, and so does '+ New visit for an existing
   * patient'. Patient A's typed answers would load into a form headed
   * "New visit for B" - and a vitals-only draft with no name in it gives the
   * clinician nothing to notice.
   */
  seedFromId: string | null
  savedAt: string
}

export function saveDraft(
  state: EncounterFormState,
  editingId: string | null,
  seedFromId: string | null = null,
  now = new Date(),
): void {
  try {
    sessionStorage.setItem(
      KEY(),
      JSON.stringify({ state, editingId, seedFromId, savedAt: now.toISOString() } satisfies Draft),
    )
  } catch {
    // Out of quota, or storage disabled. The form still works; only the
    // crash-recovery net is missing, and nothing here is worth an interruption.
  }
}

export function readDraft(): Draft | null {
  try {
    const raw = sessionStorage.getItem(KEY())
    if (!raw) return null
    const d = JSON.parse(raw) as Draft
    if (!d || typeof d !== 'object' || !d.state) return null
    // A draft written before seedFromId existed has no idea which patient it
    // belongs to. Treat it as a plain new encounter rather than guessing.
    if (d.seedFromId === undefined) d.seedFromId = null
    return d
  } catch {
    return null
  }
}

export function clearDraft(): void {
  try {
    sessionStorage.removeItem(KEY())
  } catch {
    /* nothing to do */
  }
}

/** Something worth offering to restore: a name, or any clinical content. */
export function draftHasContent(s: EncounterFormState): boolean {
  return !!(
    s.givenName.trim() ||
    s.familyName.trim() ||
    s.chiefConcern.trim() ||
    s.diagnosis.trim() ||
    s.temp.trim() ||
    s.bp.trim() ||
    s.weight.trim() ||
    s.notes.trim() ||
    s.treatmentNotes.trim() ||
    s.medications.length ||
    s.complaints.length ||
    Object.keys(s.labs).length ||
    Object.keys(s.customFields).length
  )
}

/** A short human description so the prompt says WHOSE encounter it is. */
export function describeDraft(d: Draft): string {
  const name = `${d.state.givenName} ${d.state.familyName}`.trim()
  const when = new Date(d.savedAt)
  const time = Number.isNaN(when.getTime())
    ? ''
    : when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${name || 'an unnamed patient'}${time ? `, last typed at ${time}` : ''}`
}

/**
 * Is this draft the one for the form being opened?
 *
 * Both the target AND the seed must match. Anything else risks putting one
 * patient's answers on another patient's chart, which is worse than losing the
 * draft.
 */
export function draftMatches(
  d: Draft | null,
  editingId: string | null,
  seedFromId: string | null,
): boolean {
  if (!d) return false
  return (
    d.editingId === editingId &&
    (d.seedFromId ?? null) === seedFromId &&
    draftHasContent(d.state)
  )
}
