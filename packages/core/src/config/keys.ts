/**
 * Config keys and typed accessors over the kernel KV.
 *
 * CONFIG_PUSH_KEYS is the CLOSED list of keys that replicate to the org's
 * Supabase config table. The write path deliberately writes only keys on
 * this list: a typo here (or a new list whose key is missing) syncs nothing,
 * silently, and the edit stays device-local forever.
 *
 * All access goes through a KV instance (src/kernel/api.ts) so synced config
 * is honored; this module never touches storage directly.
 */
import type { KV } from '../kernel/api'
import type {
  CustomLabTest,
  FormTemplateLibrary,
  FormularyEntry,
  HiddenPresets,
  RawSection,
  RxPreset,
} from './types'
import { normalizeLibrary } from './sections'
import { DEFAULT_FORMULARY } from './defaults/formulary'
import { DEFAULT_PHYSICIANS, DEFAULT_SITES } from './defaults/lists'

/** Exactly the keys the sync engine pushes. Order and spelling are contract. */
export const CONFIG_PUSH_KEYS = [
  'sites',
  'providers',
  'formulary',
  'rxPresets',
  'procedures',
  'referralTypes',
  'customDxPresets',
  'complaints',
  'customLabTests',
  'hiddenPresets',
  'formSchema',
  'formTemplates',
  // v4: clinic-mode flow board stations. Field-mode devices carry the key
  // harmlessly; older clients ignore unknown config keys by design.
  'flowStations',
] as const

export type ConfigKey = (typeof CONFIG_PUSH_KEYS)[number]

/** The stored value shape behind each config key. */
export interface ConfigValues {
  sites: string[]
  providers: string[]
  formulary: FormularyEntry[]
  rxPresets: RxPreset[]
  procedures: string[]
  referralTypes: string[]
  customDxPresets: string[]
  complaints: string[]
  customLabTests: CustomLabTest[]
  hiddenPresets: HiddenPresets
  /** Legacy mirror of formTemplates.templates[0].schema. */
  formSchema: { sections: RawSection[] }
  formTemplates: FormTemplateLibrary
  /** Clinic-mode flow board stations, in board order. Station names are the
   *  identity records point at (like sites): renaming strands old visits
   *  under the old name, so the editor warns before renames. */
  flowStations: string[]
}

/**
 * Typed read. Returns null for a key the org has never customized, EXCEPT
 * customLabTests, whose never-customized fallback is [] (the one getter the
 * legacy kernel special-cased).
 */
export async function getConfig<K extends ConfigKey>(
  kv: KV,
  key: K,
): Promise<ConfigValues[K] | null> {
  const v = await kv.get<ConfigValues[K]>(key)
  if (v === null && key === 'customLabTests') {
    return [] as CustomLabTest[] as ConfigValues[K]
  }
  return v
}

/** Typed write. Only CONFIG_PUSH_KEYS are writable, so every edit replicates. */
export function setConfig<K extends ConfigKey>(
  kv: KV,
  key: K,
  value: ConfigValues[K],
): Promise<void> {
  return kv.set(key, value)
}

// ------------------------------------------------- clinic-list write path ---

export function setSites(kv: KV, sites: string[]): Promise<void> {
  return setConfig(kv, 'sites', sites)
}
export function setProviders(kv: KV, providers: string[]): Promise<void> {
  return setConfig(kv, 'providers', providers)
}
export function setFormulary(kv: KV, items: FormularyEntry[]): Promise<void> {
  return setConfig(kv, 'formulary', items)
}
/** Lab tests store under `customLabTests`, NOT `labTests`: the wrong key would look like it saved and then never appear on the form. */
export function setLabTests(kv: KV, tests: CustomLabTest[]): Promise<void> {
  return setConfig(kv, 'customLabTests', tests)
}
export function setProcedures(kv: KV, list: string[]): Promise<void> {
  return setConfig(kv, 'procedures', list)
}
export function setReferralTypes(kv: KV, list: string[]): Promise<void> {
  return setConfig(kv, 'referralTypes', list)
}
export function setComplaints(kv: KV, list: string[]): Promise<void> {
  return setConfig(kv, 'complaints', list)
}
export function setDxPresets(kv: KV, list: string[]): Promise<void> {
  return setConfig(kv, 'customDxPresets', list)
}
export function setRxPresets(kv: KV, presets: RxPreset[]): Promise<void> {
  return setConfig(kv, 'rxPresets', presets)
}
/** Preserve unknown categories (legacy 'diagnoses', 'rxPresets') when writing. */
export function setHiddenPresets(kv: KV, hidden: HiddenPresets): Promise<void> {
  return setConfig(kv, 'hiddenPresets', hidden)
}

/**
 * Board columns in order. The last station means "done for the day".
 *
 * One column per station role (boardRole.ts matches a role to a station by
 * name): reception owns the first column, then Triage, Provider, Lab and
 * Pharmacy. Lab sits between Provider and Pharmacy because that is where a
 * visit waits on results: a provider who orders tests advances the visit to
 * Lab, and the lab advances it to Pharmacy once the results are in. Without
 * the column, visits waiting on results sat in the Provider column and the
 * lab role had no station of its own.
 */
export const DEFAULT_FLOW_STATIONS = ['Check-in', 'Triage', 'Provider', 'Lab', 'Pharmacy', 'Done']

export function setFlowStations(kv: KV, stations: string[]): Promise<void> {
  return setConfig(kv, 'flowStations', stations)
}

/**
 * One entry per LINE. Never split on commas.
 *
 * Commas belong inside these values: "Grace N., clinical officer" is one
 * provider, and "Kabale, Kigezi" is one site. Splitting on them turned a
 * single clinician into two, and every record filed by that clinician would
 * then carry a provider name that does not exist. Trims, drops blanks,
 * de-duplicates. An empty result means REFUSE TO SAVE, never write [].
 */
export function parseList(raw: string): string[] {
  return [...new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean))]
}

/**
 * A stable id for a new formulary/lab entry: `${prefix}-${rand}` (dash, not
 * the schema uid's underscore prefixes). Prescriptions store medId, so an id
 * must never be reused or reassigned: doing either would silently repoint
 * every prescription already written against it to a different drug.
 */
export function newConfigId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.abs(Date.now() ^ (Math.random() * 1e9)).toString(36)
  return `${prefix}-${rand}`
}

/** True while this device is still filing records under the built-in placeholders. */
export function isPlaceholderConfig(sites: string[], providers: string[]): boolean {
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i])
  return same(sites, DEFAULT_SITES) || same(providers, DEFAULT_PHYSICIANS)
}

// ------------------------------------------------------------- read rules ---

/** Config lists may be stored as plain strings or as legacy {name} objects. */
export function names(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x : (x as { name?: string })?.name || ''))
    .filter(Boolean)
}

/** Fallback chain for a plain list: org names when any, else the defaults. */
export function resolveStringList(stored: unknown, defaults: readonly string[]): string[] {
  const n = names(stored)
  return n.length ? n : [...defaults]
}

/** Formulary fallback: entries with ids when any, else the built-in formulary. */
export function resolveFormulary(stored: unknown): FormularyEntry[] {
  const list = Array.isArray(stored)
    ? (stored as FormularyEntry[]).filter((f) => f && f.id)
    : []
  return list.length ? list : DEFAULT_FORMULARY
}

/**
 * Filter a list by hiddenPresets. Applies to exactly 'procedures',
 * 'referralTypes' and 'complaints' (labTests filter by name lives in
 * defaults/labTests.ts); sites, providers and formulary are NOT filtered.
 */
export function visiblePresets(
  list: string[],
  hidden: HiddenPresets | null | undefined,
  category: string,
): string[] {
  const h = hidden?.[category] || []
  return list.filter((n) => !h.includes(n))
}

// --------------------------------------------------------- form templates ---

/**
 * Load the template library. `synthesized` is true when the org has NO stored
 * form config yet (nothing synced to this device) - computed from the RAW
 * reads, BEFORE normalizeLibrary fabricates 'General Encounter', because the
 * fabricated output is indistinguishable from a real empty org afterward.
 * Saving a synthesized library would replace the org's real templates with a
 * fabricated empty one, so callers must not write it back until a sync has
 * produced something real.
 */
export async function loadLibraryDetailed(
  kv: KV,
): Promise<{ lib: FormTemplateLibrary; synthesized: boolean }> {
  const [templates, legacy] = await Promise.all([
    kv.get<FormTemplateLibrary>('formTemplates'),
    kv.get<{ sections?: RawSection[] }>('formSchema'),
  ])
  const hasReal =
    !!(templates && Array.isArray(templates.templates) && templates.templates.length) ||
    !!(legacy && Array.isArray(legacy.sections))
  return { lib: normalizeLibrary(templates, legacy), synthesized: !hasReal }
}

/** Load the template library (synced config honored via the KV). */
export async function loadLibrary(kv: KV): Promise<FormTemplateLibrary> {
  const { lib } = await loadLibraryDetailed(kv)
  return lib
}

/**
 * Save the library, mirroring the first ENABLED template's schema back to the
 * legacy `formSchema` key (only when it exists) on EVERY save, so an older
 * client on the same org still renders correctly. Skipping the mirror breaks
 * them. First ENABLED, not templates[0]: a legacy client has no concept of a
 * disabled template, so mirroring a switched-off templates[0] would hand it a
 * form the org deliberately turned off. When every template is disabled
 * (which the builder refuses to produce) templates[0] is the fallback.
 */
export async function saveLibrary(kv: KV, lib: FormTemplateLibrary): Promise<void> {
  await kv.set('formTemplates', lib)
  const first = lib.templates.find((t) => t.enabled !== false) ?? lib.templates[0]
  if (first?.schema) await kv.set('formSchema', first.schema)
}
