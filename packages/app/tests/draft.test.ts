/**
 * iOS discards background tabs on memory pressure. Answering a call or letting
 * the screen lock mid-encounter used to destroy everything typed, silently.
 * These pin the recovery net AND the rules that stop a draft reaching the wrong
 * patient's chart.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { clearDraft, describeDraft, draftHasContent, draftMatches, readDraft, saveDraft } from '../src/ui/encounter/draft';
import { emptyFormState } from '../src/ui/encounter/formState';

beforeEach(() => { sessionStorage.clear(); });

describe('encounter draft', () => {
  it('round-trips a part-typed encounter', () => {
    const s = emptyFormState('2026-08-10');
    s.givenName = 'Amara'; s.familyName = 'Nakato'; s.temp = '39.1';
    saveDraft(s, null);
    const d = readDraft()!;
    expect(d.editingId).toBeNull();
    expect(d.state.givenName).toBe('Amara');
    expect(d.state.temp).toBe('39.1');
  });

  it('remembers which record was being edited', () => {
    saveDraft(emptyFormState(), 'rec-7');
    expect(readDraft()!.editingId).toBe('rec-7');
  });

  it('is cleared on save and on an explicit discard', () => {
    saveDraft(emptyFormState(), null);
    clearDraft();
    expect(readDraft()).toBeNull();
  });

  it('does not treat an untouched form as recoverable content', () => {
    expect(draftHasContent(emptyFormState())).toBe(false);
  });

  it('treats clinical content with no name as recoverable', () => {
    // A triage entry can have vitals before anyone has typed the name.
    const s = emptyFormState();
    s.temp = '38.4';
    expect(draftHasContent(s)).toBe(true);
  });

  it('survives corrupt storage without throwing', () => {
    sessionStorage.setItem('dhemr_encounter_draft', '{not json');
    expect(readDraft()).toBeNull();
  });

  it('names the patient in the recovery prompt', () => {
    const s = emptyFormState();
    s.givenName = 'Joseph'; s.familyName = 'Okello';
    saveDraft(s, null, null, new Date(2026, 7, 10, 14, 5));
    expect(describeDraft(readDraft()!)).toMatch(/Joseph Okello/);
  });
});

describe('draft scoping', () => {
  const withName = (n: string) => { const s = emptyFormState(); s.givenName = n; return s; };

  it('matches only the form it was typed in', () => {
    saveDraft(withName('Amara'), null, null);
    const d = readDraft();
    expect(draftMatches(d, null, null)).toBe(true);       // same new encounter
    expect(draftMatches(d, 'rec-7', null)).toBe(false);   // an edit of a record
    expect(draftMatches(d, null, 'visit-3')).toBe(false); // a new visit for a patient
  });

  it('does NOT load an abandoned new-encounter draft into another patient\'s new visit', () => {
    // Patient A half-entered, tab switched away, then '+ New visit' opened on
    // patient B's chart. A's answers used to land on B's form.
    saveDraft(withName('Amara'), null, null);
    expect(draftMatches(readDraft(), null, 'patient-b-visit')).toBe(false);
  });

  it('keeps a new-visit draft tied to its own patient', () => {
    saveDraft(withName('Joseph'), null, 'visit-42');
    expect(draftMatches(readDraft(), null, 'visit-42')).toBe(true);
    expect(draftMatches(readDraft(), null, 'visit-99')).toBe(false);
    expect(draftMatches(readDraft(), null, null)).toBe(false);
  });

  it('treats a draft from an older build as a plain new encounter', () => {
    sessionStorage.setItem('dhemr_encounter_draft', JSON.stringify({
      state: withName('Legacy'), editingId: null, savedAt: new Date().toISOString(),
    }));
    const d = readDraft()!;
    expect(d.seedFromId).toBeNull();
    expect(draftMatches(d, null, null)).toBe(true);
    expect(draftMatches(d, null, 'some-visit')).toBe(false);
  });
});
