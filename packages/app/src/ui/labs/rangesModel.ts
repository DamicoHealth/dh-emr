/**
 * Pure logic behind the lab reference-range editor (REBUILD-HANDOFF 6.2).
 *
 * Rules carried over from the spec:
 *  - Ranges drive the interpretation SNAPSHOTTED onto the record at entry
 *    time. Editing ranges later never rewrites recorded results - the record
 *    keeps its own copy - so every save message and the editor itself say so.
 *  - Matching is first-wins, min INCLUSIVE, max EXCLUSIVE, missing bounds
 *    open (src/config/labInterpret.ts). The warnings here describe exactly
 *    that behavior.
 *  - Overlapping or gapped ranges WARN, never block: field reality is messy
 *    and an admin sometimes wants exactly that shape.
 *  - Persistence goes through setLabTests with the WHOLE CustomLabTest rows.
 *    The stored list is re-read fresh at save time so a config pull that
 *    landed while the editor was open is never reverted, and staged (unsaved)
 *    edits in the lab-tests table are never committed as a side effect.
 *  - Colors come from a fixed accessible palette. Stored values keep the
 *    legacy tokens ('var(--green)' etc.) so configs stay compatible with the
 *    previous implementation; an unknown stored color is preserved, never
 *    clobbered by an edit to other properties.
 */
import type { KV } from '../../kernel'
import { getConfig, setLabTests } from '../../config/keys'
import { resolveLabTests } from '../../config/defaults/labTests'
import type { CustomLabTest, LabRange } from '../../config/types'

// ------------------------------------------------------------------- copy ---

/** Shown prominently in the editor; tests pin it. */
export const RANGES_SNAPSHOT_NOTE =
  'Visits already saved keep the interpretation that was recorded at the time; ' +
  'editing ranges never rewrites a recorded result. Only new results entered ' +
  'after this change use the new ranges.'

/** On the Ranges control for a lab row that has not been persisted yet. */
export const UNSAVED_TEST_REASON =
  'Save lab tests first, then set the reference ranges for this test.'

export const MATCHING_RULE_NOTE =
  'Ranges are checked top to bottom and the first match wins. A value equal to ' +
  '"from" is inside the range; a value equal to "up to" is not - it belongs to ' +
  'the next range up.'

// ---------------------------------------------------------------- palette ---

/**
 * Fixed accessible palette. `value` is what is STORED (legacy token spelling,
 * so lists written here render in the previous implementation too); `css` is
 * what this build actually paints, each 4.5:1+ on white.
 */
export const RANGE_COLORS: ReadonlyArray<{ value: string; label: string; css: string }> = [
  { value: 'var(--green)', label: 'Green (normal)', css: '#1e7d34' },
  { value: 'var(--amber)', label: 'Amber (caution)', css: '#8a5a00' },
  { value: 'var(--red)', label: 'Red (critical)', css: '#b3261e' },
  { value: 'var(--gray-500)', label: 'Gray (neutral)', css: '#4a5568' },
]

/**
 * The paint color for a stored range color. Palette tokens map to their
 * accessible css; a foreign var() (this build does not define the legacy
 * variables) falls back to neutral instead of rendering as nothing; any plain
 * CSS color from another client passes through.
 */
export function swatchColor(stored: string | undefined): string | null {
  if (!stored) return null
  const hit = RANGE_COLORS.find((c) => c.value === stored)
  if (hit) return hit.css
  return stored.startsWith('var(') ? '#4a5568' : stored
}

// ----------------------------------------------------------------- drafts ---

/**
 * One range as EDITED: bounds are text buffers (they come from DOM inputs),
 * cleaned into numbers only at persist time. `key` is UI identity only and is
 * never stored.
 */
export interface RangeDraft {
  key: string
  label: string
  min: string
  max: string
  color: string
}

function draftKey(): string {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `k${Math.random().toString(36).slice(2)}`
}

export function toDrafts(ranges: LabRange[] | undefined): RangeDraft[] {
  return (ranges ?? []).map((r) => ({
    key: draftKey(),
    label: r.label ?? '',
    min: r.min === undefined ? '' : String(r.min),
    max: r.max === undefined ? '' : String(r.max),
    color: r.color ?? '',
  }))
}

export function addRange(drafts: RangeDraft[]): RangeDraft[] {
  return [...drafts, { key: draftKey(), label: '', min: '', max: '', color: '' }]
}

export function updateRange(
  drafts: RangeDraft[],
  key: string,
  patch: Partial<Omit<RangeDraft, 'key'>>,
): RangeDraft[] {
  return drafts.map((d) => (d.key === key ? { ...d, ...patch } : d))
}

export function removeRange(drafts: RangeDraft[], key: string): RangeDraft[] {
  return drafts.filter((d) => d.key !== key)
}

/** Swap with the neighbour; null at the ends (callers disable the button too). */
export function moveRange(drafts: RangeDraft[], key: string, dir: -1 | 1): RangeDraft[] | null {
  const i = drafts.findIndex((d) => d.key === key)
  if (i < 0) return null
  const j = i + dir
  if (j < 0 || j >= drafts.length) return null
  const next = [...drafts]
  const a = next[i] as RangeDraft
  const b = next[j] as RangeDraft
  next[i] = b
  next[j] = a
  return next
}

// ---------------------------------------------------------- persist shape ---

interface Bound {
  value: number | undefined
  /** true when the text was non-empty but not a number (treated as open). */
  bad: boolean
}

function parseBound(text: string): Bound {
  const t = text.trim()
  if (!t) return { value: undefined, bad: false }
  const n = Number(t)
  if (!Number.isFinite(n)) return { value: undefined, bad: true }
  return { value: n, bad: false }
}

/**
 * The persist shape: labels trimmed, bounds numeric, undefined bounds OMITTED
 * (an open bound is an absent key, exactly the stored shape labInterpret
 * matches on), color kept only when set, order preserved. A row that is
 * entirely empty (no label, no bounds) is dropped - it is just a blank line.
 */
export function cleanRanges(drafts: RangeDraft[]): LabRange[] {
  const out: LabRange[] = []
  for (const d of drafts) {
    const label = d.label.trim()
    const min = parseBound(d.min).value
    const max = parseBound(d.max).value
    if (!label && min === undefined && max === undefined) continue
    const r: LabRange = { label }
    if (min !== undefined) r.min = min
    if (max !== undefined) r.max = max
    if (d.color) r.color = d.color
    out.push(r)
  }
  return out
}

// --------------------------------------------------------------- warnings ---

function rangeName(r: LabRange, index: number): string {
  return r.label ? `"${r.label}"` : `Range ${index + 1}`
}

/** A bound that failed to parse silently becoming "open" would be a trap. */
export function draftWarnings(drafts: RangeDraft[]): string[] {
  const warnings: string[] = []
  drafts.forEach((d, i) => {
    const name = d.label.trim() ? `"${d.label.trim()}"` : `Range ${i + 1}`
    if (parseBound(d.min).bad) {
      warnings.push(`${name}: "${d.min.trim()}" is not a number, so the "from" bound is treated as open.`)
    }
    if (parseBound(d.max).bad) {
      warnings.push(`${name}: "${d.max.trim()}" is not a number, so the "up to" bound is treated as open.`)
    }
  })
  return warnings
}

/**
 * Advisory warnings over the CLEANED ranges. These warn and never block:
 * overlaps and gaps are sometimes deliberate in the field. Wording mirrors
 * the real matching rule (first match wins, min inclusive, max exclusive).
 */
export function rangeWarnings(ranges: LabRange[]): string[] {
  const warnings: string[] = []

  ranges.forEach((r, i) => {
    if (!r.label) {
      warnings.push(`Range ${i + 1} has no label; a matching value records an empty interpretation.`)
    }
  })

  interface Interval {
    lo: number
    hi: number
    index: number
  }
  const intervals: Interval[] = ranges.map((r, index) => ({
    lo: r.min === undefined ? -Infinity : r.min,
    hi: r.max === undefined ? Infinity : r.max,
    index,
  }))

  for (const iv of intervals) {
    const r = ranges[iv.index] as LabRange
    if (iv.lo >= iv.hi) {
      warnings.push(
        `${rangeName(r, iv.index)} can never match: its "from" value must be below its "up to" value.`,
      )
    }
  }

  const valid = intervals.filter((iv) => iv.lo < iv.hi)

  // Overlaps, pairwise. First-listed wins, so say which one a value records.
  for (let a = 0; a < valid.length; a++) {
    for (let b = a + 1; b < valid.length; b++) {
      const first = valid[a] as Interval
      const second = valid[b] as Interval
      if (Math.max(first.lo, second.lo) < Math.min(first.hi, second.hi)) {
        const winner = ranges[first.index] as LabRange
        const loser = ranges[second.index] as LabRange
        warnings.push(
          `${rangeName(winner, first.index)} and ${rangeName(loser, second.index)} overlap; ` +
            `a value in the overlap records ${rangeName(winner, first.index)} because the first matching range wins.`,
        )
      }
    }
  }

  // Interior gaps: values between covered stretches record no interpretation.
  const sorted = [...valid].sort((x, y) => x.lo - y.lo || x.hi - y.hi)
  let coveredTo: number | null = null
  for (const iv of sorted) {
    if (coveredTo !== null && iv.lo > coveredTo) {
      warnings.push(
        `No range covers values from ${coveredTo} up to ${iv.lo}; a result there records no interpretation.`,
      )
    }
    coveredTo = coveredTo === null ? iv.hi : Math.max(coveredTo, iv.hi)
  }

  return warnings
}

// ---------------------------------------------------------------- persist ---

/**
 * A copy of the test with the new ranges; an empty list REMOVES the key so
 * the stored row goes back to the plain no-ranges shape.
 */
export function withRanges(test: CustomLabTest, ranges: LabRange[]): CustomLabTest {
  if (!ranges.length) {
    const { ranges: _dropped, ...rest } = test
    return rest
  }
  return { ...test, ranges }
}

export interface SaveRangesResult {
  ok: boolean
  message: string
}

/**
 * Persist one test's ranges through setLabTests (whole rows carry ranges).
 *
 * The base is a FRESH read of the stored list resolved through the same
 * fallback the form uses (org list when any, else the built-in panel), so:
 *  - a config pull that landed while the editor was open is honored,
 *  - staged-but-unsaved edits in the lab-tests table are NOT committed,
 *  - on a never-customized org this writes the whole built-in panel with the
 *    patch applied - the documented replace semantics, and the same thing
 *    "Save lab tests" would write.
 * A test id not in the stored base is REFUSED (the row exists only as a
 * staged draft): writing ranges for it would fabricate a half-typed test row.
 */
export async function saveTestRanges(
  kv: KV,
  test: Pick<CustomLabTest, 'id' | 'name'>,
  ranges: LabRange[],
): Promise<SaveRangesResult> {
  const stored = await getConfig(kv, 'customLabTests')
  const base = resolveLabTests(stored)
  if (!base.some((t) => t.id === test.id)) {
    return { ok: false, message: UNSAVED_TEST_REASON }
  }
  const next = base.map((t) => (t.id === test.id ? withRanges(t, ranges) : t))
  await setLabTests(kv, next)
  const n = ranges.length
  return {
    ok: true,
    message: n
      ? `Saved ${n} range${n === 1 ? '' : 's'} for "${test.name}". New results use them from now on; ` +
        'visits already saved keep the interpretation recorded at the time.'
      : `Removed the ranges for "${test.name}". New results record no interpretation; ` +
        'visits already saved keep the interpretation recorded at the time.',
  }
}
