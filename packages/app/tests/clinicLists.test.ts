/**
 * The clinic's own lists.
 *
 * The legacy app let an admin edit the medications, lab tests, procedures,
 * referral destinations and complaints; the rewrite shipped without that screen
 * entirely, so an organization could not tell the app which drugs it stocks.
 * These pin the write path and the rules that protect existing records.
 *
 * Adapted from the reference suite: the write path here goes through the
 * kernel KV interface instead of raw localStorage, so the exact KEY STRINGS
 * (which are what CONFIG_PUSH_KEYS replicates) are asserted against an
 * in-memory KV rather than `dhemr_`-prefixed localStorage rows.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_PUSH_KEYS, newConfigId, parseList, setComplaints, setFormulary, setLabTests,
  setProcedures, setReferralTypes,
} from '../src/config/keys';
import type { CustomLabTest, FormularyEntry } from '../src/config/types';
import type { KV } from '../src/kernel/api';

let store: Map<string, unknown>;
const kv: KV = {
  async get<T>(key: string): Promise<T | null> {
    return store.has(key) ? (store.get(key) as T) : null;
  },
  async set(key: string, value: unknown): Promise<void> {
    // Round-trip through JSON like real storage, so non-JSON values cannot hide.
    store.set(key, JSON.parse(JSON.stringify(value)));
  },
  async remove(key: string): Promise<void> {
    store.delete(key);
  },
};

beforeEach(() => { store = new Map(); });

const read = (key: string) => (store.has(key) ? store.get(key) : null);

describe('writing the clinic lists', () => {
  it('writes each list where the kernel and the sync engine read it', async () => {
    // These exact keys are in CONFIG_PUSH_KEYS, which is how an admin's edit
    // reaches the rest of the team. A typo here syncs nothing, silently.
    await setProcedures(kv, ['Wound dressing', 'Suturing']);
    await setReferralTypes(kv, ['District hospital']);
    await setComplaints(kv, ['Fever', 'Cough']);
    expect(read('procedures')).toEqual(['Wound dressing', 'Suturing']);
    expect(read('referralTypes')).toEqual(['District hospital']);
    expect(read('complaints')).toEqual(['Fever', 'Cough']);
  });

  it('stores the formulary in the shape the prescription form reads', async () => {
    const meds: FormularyEntry[] = [
      { id: 'med-a', name: 'Paracetamol', dose: '500mg', unit: 'tabs', category: 'Analgesics' },
    ];
    await setFormulary(kv, meds);
    expect(read('formulary')).toEqual(meds);
  });

  it('stores lab tests under customLabTests, not labTests', async () => {
    // getCustomLabTests is what the kernel exposes; the wrong key would look
    // like it saved and then never appear on the form.
    const tests: CustomLabTest[] = [{ id: 'lab-a', name: 'Malaria RDT', type: 'toggle' }];
    await setLabTests(kv, tests);
    expect(read('customLabTests')).toEqual(tests);
    expect(read('labTests')).toBeNull();
  });

  it('only ever writes keys the sync engine pushes', () => {
    // The closed replication list, verbatim. Any drift here means an admin's
    // edit stays device-local forever.
    expect([...CONFIG_PUSH_KEYS]).toEqual([
      'sites', 'providers', 'formulary', 'rxPresets', 'procedures', 'referralTypes',
      'customDxPresets', 'complaints', 'customLabTests', 'hiddenPresets', 'formSchema', 'formTemplates',
    ]);
  });
});

describe('ids for new entries', () => {
  it('are unique, so one drug cannot overwrite another', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newConfigId('med')));
    expect(ids.size).toBe(500);
  });

  it('are prefixed, so a lab id can never collide with a medication id', () => {
    expect(newConfigId('med').startsWith('med-')).toBe(true);
    expect(newConfigId('lab').startsWith('lab-')).toBe(true);
  });
});

describe('list parsing', () => {
  it('keeps commas inside an entry', () => {
    // "Health Centre IV, Rukungiri" is ONE destination.
    expect(parseList('District hospital\nHealth Centre IV, Rukungiri'))
      .toEqual(['District hospital', 'Health Centre IV, Rukungiri']);
  });

  it('trims, drops blanks and de-duplicates', () => {
    expect(parseList('  Fever \n\n Cough \nFever ')).toEqual(['Fever', 'Cough']);
  });

  it('returns nothing for an empty box, which the editor treats as refuse-to-save', () => {
    // Saving an empty list would remove the control from the encounter form for
    // the whole organization, so the editor keeps the previous entries instead.
    expect(parseList('   \n  ')).toEqual([]);
  });
});
