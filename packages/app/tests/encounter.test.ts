/**
 * GOLDEN RECORD PARITY - the gate for Phase 3.
 *
 * The encounter form must produce a record byte-compatible with the one
 * collectFormData() produced in the legacy app, and must never lose a field
 * it does not itself edit. These tests are the reason the form can be trusted
 * near real patient data.
 *
 * Ported from the reference suite; import paths adapted to the rebuilt core
 * (src/types/record, src/domain/mrn, src/ui/encounter/*).
 */
import { describe, expect, it } from 'vitest';
import './setup';
import type { PatientRecord } from '../src/types/record';
import { generateBaseMRN } from '../src/domain/mrn';
import { emptyFormState, dobFromAgeEstimate, parseDOBString } from '../src/ui/encounter/formState';
import { buildRecord, toFormState, mergeCustomFields, type BuildContext } from '../src/ui/encounter/serialize';
import { validateEncounter } from '../src/ui/encounter/validate';

const FORMULARY = [{ id: 'f-al', name: 'Artemether-Lumefantrine' }, { id: 'f-para', name: 'Paracetamol' }];
const FREQS = [{ value: 'BID', label: 'twice daily' }, { value: 'TID', label: 'three times daily' }];

const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({
  prev: null, deviceId: 'dev-1', templateId: 'general', templateName: 'General Encounter',
  activeCustomFieldIds: [], formulary: FORMULARY, frequencies: FREQS,
  now: '2026-08-08T09:00:00.000Z', newId: () => 'new-id-1',
  ...over,
});

function filledState() {
  const s = emptyFormState('2026-08-01');
  s.site = 'Kabale Community Clinic'; s.provider = 'Dr. A. Mensah';
  s.givenName = 'Amara'; s.familyName = 'Nakato'; s.sex = 'F';
  s.dobIso = '1989-04-12'; s.dobText = '12/04/1989'; s.phone = '0700';
  s.mrn = 'AMNA12041989';
  s.temp = '38.9'; s.bp = ' 118/76 '; s.weight = '58'; s.pregnant = 'Yes';
  s.allergies = 'NKDA'; s.currentMeds = 'Folic acid'; s.pmh = 'None'; s.chiefConcern = 'Fever';
  s.labs = {
    'Malaria RDT': { kind: 'toggle', ordered: true, result: 'POS' },
    'HIV Rapid Test': { kind: 'toggle', ordered: false, result: '' },
    'Blood Glucose': { kind: 'numeric', ordered: true, value: '104', unit: 'mg/dL', interpretation: 'Normal' },
  };
  s.labComments = 'repeat in 3d';
  s.urinalysis = { protein: 'Trace', nitrite: 'POS' };
  s.diagnosis = 'Uncomplicated malaria';
  s.diagnosisCodes = [{ code: 'B54', term: 'Malaria' }];
  s.medications = [{ id: 'med-1', medId: 'f-al', dose: '80/480 mg', freq: 'BID', duration: '3 days' }];
  s.treatmentNotes = 'hydrate';
  s.procedures = ['Wound suturing'];
  s.imagingType = 'Abdominal'; s.imagingFindings = 'normal';
  s.surgeryPerformed = false;
  s.referralType = 'Antenatal care'; s.referralDate = '2026-08-20';
  s.notes = 'review in 1 week';
  return s;
}

describe('record shape parity with collectFormData', () => {
  const rec = buildRecord(filledState(), ctx());

  it('composes name, trims BP and carries scalars through unchanged', () => {
    expect(rec.name).toBe('Amara Nakato');
    expect(rec.bp).toBe('118/76');          // legacy trims
    expect(rec.temp).toBe('38.9');
    expect(rec.weight).toBe('58');
    expect(rec.sex).toBe('F');
    expect(rec.dob).toBe('1989-04-12');
    expect(rec.ageEstimated).toBe(false);
    expect(rec.savedAt).toBe('2026-08-08T09:00:00.000Z');
    expect(rec.deviceId).toBe('dev-1');
  });

  it('builds the human-readable treatment line exactly like legacy', () => {
    // `${name} ${dose} ${freqLabel} x ${duration}` joined with '; ', notes last
    expect(rec.treatment).toBe('Artemether-Lumefantrine 80/480 mg twice daily x 3 days; Notes: hydrate');
  });

  it('mirrors blood glucose to the legacy top-level field', () => {
    expect(rec.bloodGlucose).toBe('104');
    expect(rec.labs['Blood Glucose']?.value).toBe('104');
  });

  it('stores urinalysis as an object, or null when nothing was recorded', () => {
    expect(rec.urinalysis).toEqual({ protein: 'Trace', nitrite: 'POS' });
    const blank = { ...filledState(), urinalysis: {} };
    expect(buildRecord(blank, ctx()).urinalysis).toBeNull();
  });

  it('emits imaging/surgery objects only when actually recorded', () => {
    expect(rec.imaging).toEqual({ modality: 'Ultrasound', type: 'Abdominal', findings: 'normal' });
    expect(rec.surgery).toBeNull();
    const withSurgery = { ...filledState(), surgeryPerformed: true, surgeryType: ' I&D ', surgeryNotes: ' drained ' };
    expect(buildRecord(withSurgery, ctx()).surgery).toEqual({ type: 'I&D', notes: 'drained' });
    const noImaging = { ...filledState(), imagingType: '' };
    expect(buildRecord(noImaging, ctx()).imaging).toBeNull();
  });

  it('clears the referral date when the referral is None', () => {
    const none = { ...filledState(), referralType: 'None', referralDate: '2026-08-20' };
    expect(buildRecord(none, ctx()).referralDate).toBe('');
    expect(rec.referralDate).toBe('2026-08-20');
  });

  it('IMPROVEMENT: stores only ordered labs (unordered ones are implied)', () => {
    // Legacy wrote {ordered:false,result:'N/A'} for every configured test. CSV,
    // analytics and the lab-positive badge all treat a missing key identically,
    // so output is unchanged while each record gets materially smaller.
    expect(Object.keys(rec.labs).sort()).toEqual(['Blood Glucose', 'Malaria RDT']);
    expect(rec.labs['HIV Rapid Test']).toBeUndefined();
  });
});

describe('round trip (save -> edit -> resave)', () => {
  it('does not change any field when a record is reopened and saved untouched', () => {
    const first = buildRecord(filledState(), ctx());
    const reopened = toFormState(first);
    const second = buildRecord(reopened, ctx({
      prev: first, templateId: first.templateId, templateName: first.templateName,
    }));
    // savedAt is expected to advance; everything else must be identical.
    expect({ ...second, savedAt: first.savedAt }).toEqual(first);
  });

  it('keeps medication ids stable across edits', () => {
    const first = buildRecord(filledState(), ctx());
    const second = buildRecord(toFormState(first), ctx({ prev: first }));
    expect(second.medications[0]?.id).toBe(first.medications[0]?.id);
    expect(second.medications[0]?.id).toBe('med-1');
  });

  it('splits a legacy name-only record into given/family on load', () => {
    const legacy = { ...buildRecord(filledState(), ctx()), givenName: '', familyName: '', name: 'Joseph Okello' };
    const s = toFormState(legacy as PatientRecord);
    expect(s.givenName).toBe('Joseph');
    expect(s.familyName).toBe('Okello');
  });

  it('strips a legacy "58 kg" weight back to a number for the input', () => {
    const legacy = { ...buildRecord(filledState(), ctx()), weight: '58 kg' };
    expect(toFormState(legacy as PatientRecord).weight).toBe('58');
  });

  it('surfaces a legacy top-level bloodGlucose back into the labs grid', () => {
    const legacy = { ...buildRecord(filledState(), ctx()), labs: {}, bloodGlucose: '268' };
    const s = toFormState(legacy as PatientRecord);
    expect(s.labs['Blood Glucose']).toEqual({ kind: 'numeric', ordered: true, value: '268', unit: 'mg/dL', interpretation: '' });
  });
});

describe('fields this form does not own are never dropped', () => {
  it('carries accessToCare, legacy mirrors, referralStatus and deleted through a resave', () => {
    const prev = {
      ...buildRecord(filledState(), ctx()),
      accessToCare: { painLevel: 4, careBarriers: ['cost'] },
      transport: 'Boda', travelTime: '30 min',
      referralStatus: 'Completed',
      deleted: false,
    } as PatientRecord;
    const out = buildRecord(toFormState(prev), ctx({ prev }));
    expect(out.accessToCare).toEqual({ painLevel: 4, careBarriers: ['cost'] });
    expect(out.transport).toBe('Boda');
    expect(out.travelTime).toBe('30 min');
    expect(out.referralStatus).toBe('Completed');
    expect(out.deleted).toBe(false);
  });

  it('keeps the record id and device id of the edited record', () => {
    const prev = { ...buildRecord(filledState(), ctx()), id: 'orig-id', deviceId: 'other-device' } as PatientRecord;
    const out = buildRecord(toFormState(prev), ctx({ prev, deviceId: 'this-device' }));
    expect(out.id).toBe('orig-id');
    expect(out.deviceId).toBe('other-device');
  });

  it('falls back to the stored template name when the template was deleted', () => {
    const prev = { ...buildRecord(filledState(), ctx()), templateName: 'Surgery Pre-Op' } as PatientRecord;
    const out = buildRecord(toFormState(prev), ctx({ prev, templateName: prev.templateName }));
    expect(out.templateName).toBe('Surgery Pre-Op');
  });
});

describe('custom field merge (the clear-vs-preserve rule)', () => {
  it('clears a rendered field the clinician emptied', () => {
    const merged = mergeCustomFields({ f_pain: '7', f_note: 'keep' }, {}, ['f_pain']);
    expect(merged.f_pain).toBeUndefined();   // rendered + emptied -> cleared
    expect(merged.f_note).toBe('keep');      // not rendered -> preserved
  });

  it('preserves answers belonging to another template entirely', () => {
    const merged = mergeCustomFields({ f_dental: 'caries' }, { f_pain: '3' }, ['f_pain']);
    expect(merged).toEqual({ f_dental: 'caries', f_pain: '3' });
  });

  it('lets a re-entered value overwrite the previous one', () => {
    expect(mergeCustomFields({ f_pain: '7' }, { f_pain: '2' }, ['f_pain']).f_pain).toBe('2');
  });
});

describe('MRN + DOB helpers', () => {
  it('generates the legacy MRN format', () => {
    expect(generateBaseMRN('Amara', 'Nakato', '1989-04-12')).toBe('AMNA12041989');
  });

  it('parses typed DD/MM/YYYY and rejects nonsense', () => {
    expect(parseDOBString('12/04/1989')).toBe('1989-04-12');
    expect(parseDOBString('12041989')).toBe('1989-04-12');
    expect(parseDOBString('99/99/1989')).toBe('');
    expect(parseDOBString('12/04')).toBe('');
  });

  it('synthesizes 01/01/YYYY from an age estimate, like legacy', () => {
    const now = new Date('2026-08-08T00:00:00Z');
    expect(dobFromAgeEstimate('37', now)).toBe('1989-01-01');
    expect(dobFromAgeEstimate('', now)).toBe('');
    expect(dobFromAgeEstimate('999', now)).toBe('');
  });
});

describe('validation', () => {
  const now = new Date('2026-08-08T12:00:00Z');

  it('accepts a complete encounter', () => {
    expect(validateEncounter(filledState(), now)).toEqual([]);
  });

  it('reports each missing required field', () => {
    const fields = validateEncounter(emptyFormState('2026-08-01'), now).map((p) => p.field);
    expect(fields).toEqual(expect.arrayContaining(['givenName', 'familyName', 'site', 'sex', 'dobText']));
  });

  it('blames the age estimate, not the MRN, when DOB is unknown', () => {
    const s = { ...filledState(), dobUnknown: true, dobIso: '', dobText: '', ageEstimate: '', mrn: '' };
    const problems = validateEncounter(s, now);
    expect(problems.some((p) => p.field === 'ageEstimate')).toBe(true);
    expect(problems.some((p) => p.field === 'mrn')).toBe(false);
  });

  it('explains a single-letter name instead of blaming the MRN', () => {
    const s = { ...filledState(), givenName: 'A', mrn: '' };
    const problems = validateEncounter(s, now);
    expect(problems.some((p) => p.message.includes('two letters'))).toBe(true);
  });

  it('rejects future dates and implausible temperatures', () => {
    const future = { ...filledState(), date: '2027-01-01' };
    expect(validateEncounter(future, now).some((p) => p.field === 'date')).toBe(true);
    const fahrenheit = { ...filledState(), temp: '99.5' };
    expect(validateEncounter(fahrenheit, now).some((p) => p.field === 'temp')).toBe(true);
    // and still accepts a real fever
    expect(validateEncounter({ ...filledState(), temp: '39.4' }, now)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Regressions from the pre-field-test bug hunt. Each of these shipped broken
// once; the tests exist so they cannot come back silently.
// ---------------------------------------------------------------------------

describe('regressions', () => {
  it('a new patient after Save & Next never reuses the edited record id', () => {
    // The form clears its edit target on Save & Next. If `prev` ever leaks
    // through again, the second patient overwrites the first one's record.
    const first = buildRecord(filledState(), ctx({ prev: null, newId: () => 'first-id' }));
    const second = buildRecord(
      { ...filledState(), givenName: 'Bee', familyName: 'Two', mrn: 'BETW01011990' },
      ctx({ prev: null, newId: () => 'second-id' }),
    );
    expect(first.id).toBe('first-id');
    expect(second.id).toBe('second-id');
    expect(second.id).not.toBe(first.id);
    expect(second.givenName).toBe('Bee');
  });

  it('computes the dispensing quantity instead of writing null', () => {
    // qty feeds the pharmacy totals in analytics and the donor report.
    const s = { ...filledState() };
    s.medications = [{ id: 'm1', medId: 'f-para', dose: '1 tab', freq: 'q8h', duration: '5d' }];
    const rec = buildRecord(s, ctx({ formulary: [{ id: 'f-para', name: 'Paracetamol 500mg', unit: 'tabs' }] }));
    expect(rec.medications[0]?.qty).toBe(15);          // 1 tab x 3/day x 5 days
    expect(rec.medications[0]?.qtyUnit).toBe('tabs');
  });

  it('never destroys an existing quantity it cannot recompute', () => {
    const prev = {
      ...buildRecord(filledState(), ctx()),
      medications: [{ id: 'm1', medId: 'unknown-drug', dose: '1 tab', freq: 'q8h', duration: '5d', qty: 42, qtyUnit: 'tabs' }],
    } as PatientRecord;
    const out = buildRecord(toFormState(prev), ctx({ prev }));
    expect(out.medications[0]?.qty).toBe(42);
    expect(out.medications[0]?.qtyUnit).toBe('tabs');
  });

  it('round-trips an age-estimated record so it can be saved again', () => {
    const thisYear = new Date().getFullYear();
    const rec = { ...buildRecord(filledState(), ctx()), ageEstimated: true, dob: `${thisYear - 37}-01-01` } as PatientRecord;
    const s = toFormState(rec);
    expect(s.dobUnknown).toBe(true);
    expect(s.ageEstimate).toBe('37');                 // was '' -> save was blocked
    expect(validateEncounter(s)).toEqual([]);
    // and resaving must not move the stored date of birth
    expect(buildRecord(s, ctx({ prev: rec })).dob).toBe(rec.dob);
  });

  it('restores complaint pill state from the saved chief concern', () => {
    const rec = { ...buildRecord(filledState(), ctx()), chiefConcern: 'Fever; Cough' } as PatientRecord;
    expect(toFormState(rec).complaints).toEqual(['Fever', 'Cough']);
  });
});
