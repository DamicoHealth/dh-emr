/**
 * Form-schema engine tests.
 *
 * The critical guarantee: FIELD IDS ARE STABLE. Records store custom answers
 * keyed by field id, so any builder operation that changes an id silently
 * orphans real clinical data. The legacy builder had exactly that flaw (no
 * in-place edit, so changing a label meant delete + re-add).
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SECTIONS, activeCustomFieldIds, addCustomSection, addField, deleteSection,
  getEffectiveSchema, normalizeLibrary, removeField, reorderFields, reorderSections,
  setSectionHidden, setSectionTitle, updateField, type RawSection,
} from '../src/config/sections';

const custom = (over: Partial<RawSection> = {}): RawSection => ({
  id: 's_dental', title: 'Dental', order: 50,
  fields: [
    { id: 'f_caries', label: 'Caries present', type: 'yesno' },
    { id: 'f_teeth', label: 'Teeth extracted', type: 'number' },
  ],
  ...over,
});

describe('effective schema', () => {
  it('returns all 16 built-in sections when nothing is customized', () => {
    const s = getEffectiveSchema(null).sections;
    expect(s).toHaveLength(BUILTIN_SECTIONS.length);
    expect(s.every((x) => x.builtin)).toBe(true);
    expect(s[0]!.id).toBe('encounter');
  });

  it('applies hide and rename overrides to built-ins', () => {
    const raw = { sections: [{ id: 'vitals', title: 'Observations', hidden: true }] };
    const vitals = getEffectiveSchema(raw).sections.find((s) => s.id === 'vitals')!;
    expect(vitals.title).toBe('Observations');
    expect(vitals.hidden).toBe(true);
  });

  it('never hides the required sections, even if a schema says so', () => {
    const raw = { sections: [{ id: 'encounter', hidden: true }, { id: 'patient', hidden: true }] };
    const s = getEffectiveSchema(raw).sections;
    expect(s.find((x) => x.id === 'encounter')!.hidden).toBe(false);
    expect(s.find((x) => x.id === 'patient')!.hidden).toBe(false);
  });

  it('INTERLEAVES a custom section by order instead of pinning it last', () => {
    // The legacy live form always rendered custom sections after every built-in,
    // ignoring `order`, so entry order disagreed with the chart.
    const raw = { sections: [custom({ order: 3 })] };
    const ids = getEffectiveSchema(raw).sections.map((s) => s.id);
    expect(ids.indexOf('s_dental')).toBeLessThan(ids.indexOf('notes'));
    expect(ids.indexOf('s_dental')).toBeGreaterThan(ids.indexOf('encounter'));
  });

  it('lists only the custom fields that are actually rendered', () => {
    const visible = getEffectiveSchema({ sections: [custom()] }).sections;
    expect(activeCustomFieldIds(visible).sort()).toEqual(['f_caries', 'f_teeth']);
    const hidden = getEffectiveSchema({ sections: [custom({ hidden: true })] }).sections;
    expect(activeCustomFieldIds(hidden)).toEqual([]);   // hidden -> answers preserved on save
  });
});

describe('field ids are stable (answers never orphan)', () => {
  it('keeps the id when a label, type, options or required flag is edited', () => {
    let raw: { sections: RawSection[] } = { sections: [custom()] };
    raw = updateField(raw, 's_dental', 'f_caries', { label: 'Dental caries', required: true, type: 'select', options: ['Yes', 'No', 'Unsure'] });
    const f = raw.sections[0]!.fields!.find((x) => x.id === 'f_caries')!;
    expect(f.id).toBe('f_caries');                 // <- the whole point
    expect(f.label).toBe('Dental caries');
    expect(f.required).toBe(true);
    expect(f.type).toBe('select');
    expect(f.options).toEqual(['Yes', 'No', 'Unsure']);
  });

  it('refuses to let an id be overwritten through a patch', () => {
    const raw = updateField({ sections: [custom()] }, 's_dental', 'f_caries',
      { id: 'f_hacked' } as never);
    expect(raw.sections[0]!.fields!.map((f) => f.id)).toContain('f_caries');
    expect(raw.sections[0]!.fields!.map((f) => f.id)).not.toContain('f_hacked');
  });

  it('preserves ids when fields are reordered', () => {
    const raw = reorderFields({ sections: [custom()] }, 's_dental', ['f_teeth', 'f_caries']);
    expect(raw.sections[0]!.fields!.map((f) => f.id)).toEqual(['f_teeth', 'f_caries']);
  });

  it('mints a new prefixed id only for a genuinely new field', () => {
    const raw = addField({ sections: [custom()] }, 's_dental', { label: 'Pain score', type: 'range', min: 0, max: 10 });
    const ids = raw.sections[0]!.fields!.map((f) => f.id);
    expect(ids).toHaveLength(3);
    expect(ids.filter((i) => i.startsWith('f_'))).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('reordering', () => {
  it('writes an explicit order onto every section so nothing falls back to defaults', () => {
    const ids = getEffectiveSchema(null).sections.map((s) => s.id);
    const moved = [ids[5]!, ...ids.filter((_, i) => i !== 5)];
    const raw = reorderSections({ sections: [] }, moved);
    expect(raw.sections.every((s) => typeof s.order === 'number')).toBe(true);
    expect(getEffectiveSchema(raw).sections.map((s) => s.id)).toEqual(moved);
  });

  it('keeps a built-in override intact while moving it', () => {
    const start = { sections: [{ id: 'vitals', title: 'Obs', hidden: true }] };
    const raw = reorderSections(start, ['vitals', 'encounter', 'patient']);
    const v = raw.sections.find((s) => s.id === 'vitals')!;
    expect(v.title).toBe('Obs');
    expect(v.hidden).toBe(true);
    expect(v.order).toBe(0);
  });

  it('can move a custom section above built-ins', () => {
    const raw = reorderSections({ sections: [custom()] }, ['s_dental', 'encounter', 'patient']);
    expect(getEffectiveSchema(raw).sections[0]!.id).toBe('s_dental');
  });
});

describe('section operations', () => {
  it('adds a custom section AFTER every section already shown', () => {
    // Built-ins occupy orders 0..15 even with no stored override, so a new
    // section must clear those too or it lands in the middle of the form.
    const raw = addCustomSection({ sections: [custom({ order: 7 })] }, 'Physio');
    const added = raw.sections.find((s) => s.title === 'Physio')!;
    expect(added.id.startsWith('s_')).toBe(true);
    expect(added.order).toBe(BUILTIN_SECTIONS.length);
    expect(added.fields).toEqual([]);
    expect(getEffectiveSchema(raw).sections.at(-1)!.title).toBe('Physio');
  });

  it('keeps appending below a previously added custom section', () => {
    let raw = addCustomSection({ sections: [] }, 'First');
    raw = addCustomSection(raw, 'Second');
    const ids = getEffectiveSchema(raw).sections.map((s) => s.title);
    expect(ids.at(-2)).toBe('First');
    expect(ids.at(-1)).toBe('Second');
  });

  it('hides and renames built-ins by materializing an override', () => {
    let raw = setSectionHidden({ sections: [] }, 'labs', true);
    raw = setSectionTitle(raw, 'labs', 'Point of care tests');
    const labs = getEffectiveSchema(raw).sections.find((s) => s.id === 'labs')!;
    expect(labs.hidden).toBe(true);
    expect(labs.title).toBe('Point of care tests');
  });

  it('removes a section or a field without touching the others', () => {
    const two = { sections: [custom(), custom({ id: 's_physio', title: 'Physio', fields: [] })] };
    expect(deleteSection(two, 's_physio').sections.map((s) => s.id)).toEqual(['s_dental']);
    const fewer = removeField(two, 's_dental', 'f_caries');
    expect(fewer.sections[0]!.fields!.map((f) => f.id)).toEqual(['f_teeth']);
  });
});

describe('library normalization (back-compat)', () => {
  it('wraps a lone legacy formSchema as one General Visit template', () => {
    const lib = normalizeLibrary(null, { sections: [custom()] });
    expect(lib.templates).toHaveLength(1);
    expect(lib.templates[0]!.id).toBe('general');
    expect(lib.templates[0]!.schema.sections[0]!.id).toBe('s_dental');
  });

  it('gives a brand-new org an empty General Visit rather than nothing', () => {
    const lib = normalizeLibrary(null, null);
    expect(lib.templates[0]!.name).toBe('General Visit');
    expect(getEffectiveSchema(lib.templates[0]!.schema).sections).toHaveLength(BUILTIN_SECTIONS.length);
  });

  it('prefers an existing template library over the legacy key', () => {
    const lib = normalizeLibrary(
      { version: 1, templates: [{ id: 'surg', name: 'Surgery', enabled: true, schema: { sections: [] } }] },
      { sections: [custom()] },
    );
    expect(lib.templates).toHaveLength(1);
    expect(lib.templates[0]!.id).toBe('surg');
  });
});
