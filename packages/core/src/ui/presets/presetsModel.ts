/**
 * Dx and Rx preset model: resolution, hiding, editing and one-tap apply.
 *
 * Presets are the biggest speed lever for a 60-patient day, and every rule
 * here protects saved clinical data from a preset edit:
 *
 *  - `customDxPresets` and `rxPresets` store the org's FULL lists; a device
 *    that has neither falls back to the vendored defaults (DX_PRESETS /
 *    RX_PRESETS), exactly like the legacy state.js accessors.
 *  - `hiddenPresets` (per-category name lists) is how a REMOVED BUILT-IN stays
 *    removed after sync: a device that still resolves the defaults filters
 *    them through hiddenPresets, so deleting "Scabies" on the admin device
 *    cannot resurrect on a device the org list never reached. That is the
 *    key's whole job. Unknown categories written by other clients are always
 *    preserved on write.
 *  - Formulary entry ids are PERMANENT. Preset med lines point at them
 *    (medId), prescriptions on saved visits point at them too; nothing in this
 *    module ever creates, rewrites or deletes a formulary entry. Deleting a
 *    preset removes only the one-tap button - saved visits keep every
 *    prescription and diagnosis already written from it.
 *  - Per-line dose validation WARNS and never blocks: an unreadable dose is
 *    flagged (calcMedQty marks it `assumed` downstream) so it can be fixed,
 *    but a clinic can still save the preset it needs today.
 */
import { DX_PRESETS } from '../../config/defaults/dxPresets'
import { RX_PRESETS } from '../../config/defaults/rxPresets'
import { defaultHiddenPresets } from '../../config/defaults/lists'
import { names } from '../../config/keys'
import type { FormularyEntry, HiddenPresets, RxPreset, RxPresetMed } from '../../config/types'
import { FREQUENCIES } from '../../domain/constants'
import { calcMedQty } from '../../domain/medQty'
import type { MedLine } from '../encounter/formState'

/** hiddenPresets categories for the two preset kinds (legacy key names). */
export const DX_HIDDEN_CATEGORY = 'diagnoses'
export const RX_HIDDEN_CATEGORY = 'rxPresets'

// -------------------------------------------------------------- resolution ---

/** Org list when any, else the built-in defaults (legacy getCustomDxPresets). */
export function resolveDxPresets(stored: unknown): string[] {
  const list = names(stored)
  return list.length ? list : [...DX_PRESETS]
}

/** Org presets when any, else deep clones of the built-ins (legacy getRxPresetsData). */
export function resolveRxPresets(stored: unknown): RxPreset[] {
  const list = Array.isArray(stored)
    ? (stored as RxPreset[]).filter(
        (p) => p && typeof p.name === 'string' && p.name && Array.isArray(p.meds),
      )
    : []
  const source = list.length ? list : RX_PRESETS
  return source.map((p) => ({ ...p, meds: p.meds.map((m) => ({ ...m })) }))
}

// ----------------------------------------------------------------- hiding ---

export function isPresetHidden(
  hidden: HiddenPresets | null | undefined,
  category: string,
  name: string,
): boolean {
  return !!hidden?.[category]?.includes(name)
}

/**
 * Return a new HiddenPresets with `name` hidden or shown in `category`.
 * Every other category - including ones this app does not know about - is
 * carried through untouched. A null input materializes from
 * defaultHiddenPresets(), NOT {}: the first-ever write must keep the
 * default-off lab tests hidden, or saving a preset edit would surface them.
 */
export function withHidden(
  hidden: HiddenPresets | null | undefined,
  category: string,
  name: string,
  hide: boolean,
): HiddenPresets {
  const base = hidden ?? defaultHiddenPresets()
  const out: HiddenPresets = {}
  for (const key of Object.keys(base)) out[key] = [...(base[key] ?? [])]
  const cur = out[category] ?? []
  out[category] = hide ? [...new Set([...cur, name])] : cur.filter((n) => n !== name)
  return out
}

export function visibleDxPresets(list: string[], hidden: HiddenPresets | null | undefined): string[] {
  return list.filter((n) => !isPresetHidden(hidden, DX_HIDDEN_CATEGORY, n))
}

export function visibleRxPresets(
  list: RxPreset[],
  hidden: HiddenPresets | null | undefined,
): RxPreset[] {
  return list.filter((p) => !isPresetHidden(hidden, RX_HIDDEN_CATEGORY, p.name))
}

// ---------------------------------------------------------------- editing ---

export interface DxEdit {
  list: string[]
  hidden: HiddenPresets
}

/** Add a quick-pick. De-duplicated, and UNHIDDEN: re-adding a removed built-in must bring it back. */
export function addDxPreset(
  list: string[],
  hidden: HiddenPresets | null | undefined,
  rawName: string,
): DxEdit {
  const name = rawName.trim()
  const nextHidden = withHidden(hidden, DX_HIDDEN_CATEGORY, name, false)
  if (!name || list.includes(name)) return { list: [...list], hidden: nextHidden }
  return { list: [...list, name], hidden: nextHidden }
}

/**
 * Remove a quick-pick. A BUILT-IN default is also written to
 * hiddenPresets.diagnoses so it stays removed after sync on devices still
 * resolving the defaults. Saved visits are untouched either way - a diagnosis
 * already written on a record is plain text and keeps saying what it says.
 */
export function removeDxPreset(
  list: string[],
  hidden: HiddenPresets | null | undefined,
  name: string,
): DxEdit {
  const builtin = DX_PRESETS.includes(name)
  return {
    list: list.filter((n) => n !== name),
    hidden: withHidden(hidden, DX_HIDDEN_CATEGORY, name, builtin),
  }
}

export interface RxEdit {
  presets: RxPreset[]
  hidden: HiddenPresets
}

/**
 * Remove a prescription preset. Formulary entries and prescriptions already
 * saved on visits are never touched - the preset is only the one-tap button.
 * Built-in names are also hidden so the removal survives sync.
 */
export function removeRxPreset(
  presets: RxPreset[],
  hidden: HiddenPresets | null | undefined,
  name: string,
): RxEdit {
  const builtin = RX_PRESETS.some((p) => p.name === name)
  return {
    presets: presets.filter((p) => p.name !== name),
    hidden: withHidden(hidden, RX_HIDDEN_CATEGORY, name, builtin),
  }
}

/** Reorder helper for the up/down buttons. Out-of-range moves return the list unchanged. */
export function moveItem<T>(list: T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(index, 1)
  next.splice(to, 0, item as T)
  return next
}

// ------------------------------------------------------------- validation ---

export interface LineCheck {
  tone: 'ok' | 'warn' | 'muted'
  text: string
}

/**
 * Per-line dispensing check for the preset editor, run through the SAME
 * calcMedQty that snapshots quantities at save time. Warn, never block: an
 * `assumed` parse still records a number, it just rests on a guess of 1 per
 * dose, and the editor is where that gets caught before a 60-patient day.
 */
export function checkPresetLine(line: RxPresetMed, formulary: FormularyEntry[]): LineCheck | null {
  if (!line.medId) return null
  const med = formulary.find((f) => f.id === line.medId)
  if (!med) {
    return {
      tone: 'muted',
      text: 'Not in the formulary - prescriptions from this line record no dispensing quantity.',
    }
  }
  const q = calcMedQty(line.medId, line.dose, line.freq, line.duration, formulary)
  if (q && !q.assumed) return { tone: 'ok', text: `${q.qty} ${q.unit}` }
  if (q) {
    return {
      tone: 'warn',
      text: `The dose "${line.dose}" could not be read, so the quantity assumes 1 per dose (${q.qty} ${q.unit}). Write it as a number of tabs or in mg.`,
    }
  }
  if (line.duration === 'Ongoing') return { tone: 'muted', text: 'Ongoing - no quantity is recorded.' }
  return { tone: 'muted', text: 'No dispensing quantity will be recorded for this line.' }
}

/**
 * The human-readable summary stored as `rx` (legacy generateRxSummary):
 * "Name dose freqLabel duration" joined with " + ". A free-typed drug name
 * (a medId with no formulary match) appears as typed.
 */
export function rxSummary(meds: RxPresetMed[], formulary: FormularyEntry[]): string {
  const lines = meds
    .filter((m) => m.medId)
    .map((m) => {
      const med = formulary.find((f) => f.id === m.medId)
      const freqLabel = FREQUENCIES.find((f) => f.value === m.freq)?.label || m.freq
      return [med ? med.name : m.medId, m.dose, freqLabel, m.duration].filter(Boolean).join(' ')
    })
  return lines.length ? lines.join(' + ') : 'See treatment notes'
}

// ------------------------------------------------------------------ apply ---

/**
 * One-tap apply: preset med lines -> form med rows. Ids are minted fresh, the
 * same way the "+ Add medication" button mints them, so applying only ever
 * APPENDS - it can never overwrite or collide with a row already on the form.
 * The dispensing quantity is not computed here: the rows flow through the same
 * calcMedQty preview and save-time snapshot as manually entered rows.
 */
export function buildMedLines(preset: RxPreset, newId: () => string): MedLine[] {
  return preset.meds.map((m) => ({
    id: newId(),
    medId: m.medId,
    dose: m.dose,
    freq: m.freq,
    duration: m.duration,
  }))
}

/** Preset notes APPEND to the treatment notes (legacy behavior), never replace them. */
export function appendPresetNotes(existing: string, notes?: string): string {
  if (!notes) return existing
  return existing ? existing + '\n' + notes : notes
}

/** The diagnosis text as quick-pick parts (the complaints-pill convention). */
export function dxPartsOf(text: string): string[] {
  return text
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * Toggle a quick-pick in the diagnosis free text. APPENDS to whatever is
 * typed, never replaces it; toggling off removes only the exact matching
 * part, so hand-typed diagnoses survive any amount of pill tapping.
 */
export function toggleDxInText(text: string, name: string): string {
  const parts = dxPartsOf(text)
  const next = parts.includes(name) ? parts.filter((p) => p !== name) : [...parts, name]
  return next.join('; ')
}
