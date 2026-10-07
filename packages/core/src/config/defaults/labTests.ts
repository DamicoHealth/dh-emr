/**
 * The built-in lab panel, ported from packages/pwa/state.js (DEFAULT_LAB_TESTS)
 * in the previous implementation. Values must stay byte-identical to the
 * legacy list: lab hiding is by NAME, and stored records reference these
 * names and units.
 */
import type { CustomLabTest, HiddenPresets } from '../types'

export const DEFAULT_LAB_TESTS: CustomLabTest[] = [
  // Infectious Disease
  { id: 'malaria_rdt', name: 'Malaria RDT', type: 'toggle', enabledByDefault: true },
  { id: 'hiv_rapid', name: 'HIV Rapid Test', type: 'toggle', enabledByDefault: true },
  { id: 'typhoid', name: 'Typhoid (Widal/RDT)', type: 'toggle', enabledByDefault: true },
  { id: 'hep_b', name: 'Hepatitis B (HBsAg)', type: 'toggle', enabledByDefault: true },
  { id: 'hep_c', name: 'Hepatitis C (Anti-HCV)', type: 'toggle', enabledByDefault: false },
  { id: 'rpr_syphilis', name: 'RPR/Syphilis', type: 'toggle', enabledByDefault: true },
  { id: 'h_pylori', name: 'H. pylori', type: 'toggle', enabledByDefault: true },
  { id: 'covid19_rapid', name: 'COVID-19 Rapid', type: 'toggle', enabledByDefault: false },
  { id: 'tb_afb', name: 'TB (AFB Smear)', type: 'toggle', enabledByDefault: false },
  // Women's Health
  { id: 'hcg_pregnancy', name: 'HCG/Pregnancy', type: 'toggle', enabledByDefault: true },
  // Blood Chemistry
  {
    id: 'blood_glucose',
    name: 'Blood Glucose',
    type: 'numeric',
    unit: 'mg/dL',
    enabledByDefault: true,
    ranges: [
      { label: 'Low', max: 70, color: 'var(--amber)' },
      { label: 'Normal', min: 70, max: 140, color: 'var(--green)' },
      { label: 'Elevated', min: 140, max: 200, color: 'var(--amber)' },
      { label: 'High', min: 200, color: 'var(--red)' },
    ],
  },
  {
    id: 'hemoglobin',
    name: 'Hemoglobin',
    type: 'numeric',
    unit: 'g/dL',
    enabledByDefault: true,
    ranges: [
      { label: 'Severe Anemia', max: 7, color: 'var(--red)' },
      { label: 'Moderate Anemia', min: 7, max: 10, color: 'var(--amber)' },
      { label: 'Mild Anemia', min: 10, max: 12, color: 'var(--amber)' },
      { label: 'Normal', min: 12, color: 'var(--green)' },
    ],
  },
]

/**
 * Resolve the org's lab panel from its `customLabTests` config value.
 *
 * FALLBACK RULE: an empty (or never-customized) org list means the built-in
 * panel; ANY org entry means the org list replaces the built-ins ENTIRELY.
 *
 * Note: the reference implementation instead APPENDED custom tests to the
 * built-ins while its own editor copy claimed replace semantics, and its save
 * path re-wrote the whole merged list into customLabTests, duplicating the
 * built-in ids in storage. The rebuild keeps the documented replace semantics
 * instead of the bug.
 */
export function resolveLabTests(
  orgTests: readonly CustomLabTest[] | null | undefined,
): CustomLabTest[] {
  return orgTests && orgTests.length ? [...orgTests] : [...DEFAULT_LAB_TESTS]
}

/**
 * Filter the resolved panel by hiddenPresets. Lab hiding is by NAME through
 * the `labTests` category.
 */
export function visibleLabTests(
  tests: CustomLabTest[],
  hidden: HiddenPresets | null | undefined,
): CustomLabTest[] {
  const hiddenNames = hidden?.['labTests'] || []
  // The lab table's "On by default" box is THE visibility control:
  //   explicit true  -> shown, even if the name sits in hiddenPresets
  //                     (otherwise the three built-ins that ship hidden,
  //                     Hepatitis C, COVID-19 and TB, could never be
  //                     brought back by ticking the box)
  //   explicit false -> hidden
  //   absent (legacy rows) -> the hide-by-name list decides
  return tests.filter((t) => {
    if (t.enabledByDefault === true) return true
    if (t.enabledByDefault === false) return false
    return !hiddenNames.includes(t.name)
  })
}
