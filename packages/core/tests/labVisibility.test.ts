/**
 * The lab table's "On by default" checkbox must mean something on the visit
 * form. Before this test it was a dead control for org-defined tests: the
 * stored flag was only read for the built-in panel's initial hidden list,
 * so an admin could untick a test and watch it stay on every form.
 *
 * Rule: the checkbox is THE visibility control. Explicit true shows the
 * test even if its name is in the hide-by-name list (so the three
 * built-ins that ship hidden can be brought back by ticking the box);
 * explicit false hides it; legacy rows with no flag follow the hide-by-name
 * list.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_LAB_TESTS, visibleLabTests } from '../src/config/defaults/labTests'
import type { CustomLabTest } from '../src/config/types'

const tests: CustomLabTest[] = [
  { id: 'lab-a', name: 'Dengue NS1', type: 'toggle', enabledByDefault: true },
  { id: 'lab-b', name: 'Lead level', type: 'numeric', unit: 'ug/dL', enabledByDefault: false },
  { id: 'lab-c', name: 'Stool O&P', type: 'toggle' },
]

describe('lab test visibility on the visit form', () => {
  it('hides a test whose On by default box is unticked', () => {
    const names = visibleLabTests(tests, null).map((t) => t.name)
    expect(names).toEqual(['Dengue NS1', 'Stool O&P'])
  })

  it('treats a missing flag as shown (legacy rows never carried it)', () => {
    const names = visibleLabTests(tests, null).map((t) => t.name)
    expect(names).toContain('Stool O&P')
  })

  it('hide-by-name still applies to rows that carry no flag', () => {
    const names = visibleLabTests(tests, { labTests: ['Stool O&P'] }).map((t) => t.name)
    expect(names).toEqual(['Dengue NS1'])
  })

  it('a ticked box wins over hide-by-name, so ticking brings a test back', () => {
    const names = visibleLabTests(tests, { labTests: ['Dengue NS1'] }).map((t) => t.name)
    expect(names).toContain('Dengue NS1')
  })

  it('the built-ins that ship hidden come back once an org row ticks them', () => {
    const hepC = DEFAULT_LAB_TESTS.find((t) => t.id === 'hep_c')
    expect(hepC?.enabledByDefault).toBe(false)
    const org = DEFAULT_LAB_TESTS.map((t) => (t.id === 'hep_c' ? { ...t, enabledByDefault: true } : t))
    const hiddenByDefault = { labTests: ['Hepatitis C (Anti-HCV)', 'COVID-19 Rapid'] }
    const names = visibleLabTests(org, hiddenByDefault).map((t) => t.name)
    expect(names).toContain('Hepatitis C (Anti-HCV)')
    expect(names).not.toContain('COVID-19 Rapid')
  })
})
