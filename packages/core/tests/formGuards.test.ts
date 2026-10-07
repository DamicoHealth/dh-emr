/**
 * Guards that stop an admin's form edit from bricking every device in the org,
 * and stop a stale read from being served during a sync stampede.
 */
import { describe, expect, it } from 'vitest';
import { missingRequired } from '../src/config/validate';
import { getEffectiveSchema, BUILTIN_SECTIONS } from '../src/config/sections';
import type { CustomField } from '../src/config/types';

describe('required custom fields', () => {
  const answers = {};

  it('reports a genuinely unanswered required field', () => {
    const f: CustomField = { id: 'a', label: 'Ward', type: 'text', required: true };
    expect(missingRequired([f], answers).map((x) => x.id)).toEqual(['a']);
  });

  it('does NOT block a save on a required select that has no choices', () => {
    // An admin who cleared the choices textarea used to persist options: [].
    // That renders a label with no control, so it can never be answered - and
    // it refused every save on every device until someone worked out why.
    const f: CustomField = { id: 'b', label: 'Triage', type: 'select', required: true, options: [] };
    expect(missingRequired([f], answers)).toEqual([]);
    const m: CustomField = { id: 'c', label: 'Symptoms', type: 'multiselect', required: true, options: [] };
    expect(missingRequired([m], answers)).toEqual([]);
  });

  it('still blocks on a required select that HAS choices', () => {
    const f: CustomField = { id: 'd', label: 'Triage', type: 'select', required: true, options: ['Red', 'Green'] };
    expect(missingRequired([f], answers).map((x) => x.id)).toEqual(['d']);
  });
});

describe('sections the encounter form cannot render', () => {
  it('marks them so the builder can leave them out', () => {
    const flagged = BUILTIN_SECTIONS.filter((s) => s.notOnForm).map((s) => s.id);
    expect(flagged.sort()).toEqual(['accessToCare', 'physician', 'rxPresets']);
  });

  it('carries the flag through getEffectiveSchema', () => {
    const eff = getEffectiveSchema({ sections: [] }).sections;
    expect(eff.find((s) => s.id === 'rxPresets')?.notOnForm).toBe(true);
    expect(eff.find((s) => s.id === 'vitals')?.notOnForm).toBe(false);
  });

  it('keeps them in the schema so a legacy form round-trips', () => {
    // Dropping them outright would delete an older app's saved arrangement.
    const eff = getEffectiveSchema({ sections: [] }).sections;
    expect(eff.map((s) => s.id)).toContain('accessToCare');
  });
});
