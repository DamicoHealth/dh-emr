/**
 * MRN generation is a compatibility contract: this app and the legacy app
 * must mint the SAME number for the same patient, and every MRN already in the
 * field must keep generating unchanged. The Unicode fix below was added because
 * a name written in a non-Latin script stripped to nothing and the patient
 * could not be filed at all.
 */
import { describe, expect, it } from 'vitest'
import { generateBaseMRN, resolveMrnSuffix } from '../src/domain/mrn'

describe('generateBaseMRN', () => {
  it('is unchanged for plain ASCII names', () => {
    expect(generateBaseMRN('Amara', 'Nakato', '1990-04-12')).toBe('AMNA12041990')
    expect(generateBaseMRN('joseph', 'okello', '2001-11-03')).toBe('JOOK03112001')
  })

  it('is unchanged for accented Latin names', () => {
    expect(generateBaseMRN('José', 'García', '1985-07-09')).toBe('JOGA09071985')
    // 'Müller' strips to 'Mller' under the original rule, so ML - not MU.
    expect(generateBaseMRN('Zoë', 'Müller', '1999-01-02')).toBe('ZOML02011999')
  })

  it('is unchanged when the accent is in the FIRST TWO letters', () => {
    // The original rule strips the accented letter outright, so "Ólafur" keys
    // LA, not OL. That looks wrong and IS the historical MRN: normalising first
    // re-keyed these patients and split their existing chart in two. Every one
    // of these is a byte-for-byte lock on the pre-existing behaviour.
    expect(generateBaseMRN('Ólafur', 'Nakato', '1990-04-12')).toBe('LANA12041990')
    expect(generateBaseMRN('Émile', 'Okello', '1990-04-12')).toBe('MIOK12041990')
    expect(generateBaseMRN('Ökonom', 'Auma', '1990-04-12')).toBe('KOAU12041990')
    // ...and where stripping leaves fewer than two letters, the new fallback
    // takes over, because the original could not file the patient at all.
    // 'Ól' has one ASCII letter, so the original refused it entirely.
    expect(generateBaseMRN('Ól', 'Nakato', '1990-04-12')).toBe('OLNA12041990')
  })

  it('is unchanged for names with punctuation and spaces', () => {
    expect(generateBaseMRN('Ann-Marie', "O'Brien", '1975-03-30')).toBe('ANOB30031975')
  })

  it('now files a patient whose name is not written in Latin letters', () => {
    // Previously every one of these returned '' and the encounter could not save.
    for (const [g, f] of [['አማራ', 'ንጉሤ'], ['محمد', 'حسن'], ['Ольга', 'Иванова'], ['สมชาย', 'ใจดี']] as const) {
      const mrn = generateBaseMRN(g, f, '1988-06-15')
      expect(mrn).not.toBe('')
      expect(mrn.endsWith('15061988')).toBe(true)
    }
  })

  it('is deterministic: the same patient always gets the same number', () => {
    const a = generateBaseMRN('አማራ', 'ንጉሤ', '1988-06-15')
    const b = generateBaseMRN('አማራ', 'ንጉሤ', '1988-06-15')
    expect(a).toBe(b)
  })

  it('still refuses when a name has fewer than two letters', () => {
    expect(generateBaseMRN('A', 'Nakato', '1990-04-12')).toBe('')
    expect(generateBaseMRN('Amara', '.', '1990-04-12')).toBe('')
    expect(generateBaseMRN('Amara', 'Nakato', '')).toBe('')
  })
})

describe('resolveMrnSuffix (B..Z same-base-different-name rule)', () => {
  // Amara Nakato and Amara Nabirye share a base: AM + NA + same DOB.
  const base = 'AMNA12041990'

  it('uses the bare base when no record shares it', () => {
    expect(resolveMrnSuffix(base, 'Amara Nakato', [])).toBe(base)
    expect(resolveMrnSuffix(base, 'Amara Nakato', [
      { mrn: 'JOOK03112001', givenName: 'Joseph', familyName: 'Okello' },
    ])).toBe(base)
  })

  it('returns "" for an empty base - "" is never a valid MRN', () => {
    expect(resolveMrnSuffix('', 'Amara Nakato', [])).toBe('')
  })

  it('reuses the stored number for the SAME patient, case-insensitively', () => {
    const records = [{ mrn: base, givenName: 'Amara', familyName: 'Nakato' }]
    expect(resolveMrnSuffix(base, 'amara nakato', records)).toBe(base)
    expect(resolveMrnSuffix(base, 'Amara Nakato', records)).toBe(base)
  })

  it('reuses a stored SUFFIXED number for the same patient', () => {
    // The returning patient may themselves be the B: they keep B forever.
    const records = [
      { mrn: base, givenName: 'Amara', familyName: 'Nakato' },
      { mrn: `${base}B`, givenName: 'Amara', familyName: 'Nabirye' },
    ]
    expect(resolveMrnSuffix(base, 'Amara Nabirye', records)).toBe(`${base}B`)
  })

  it('gives a DIFFERENT patient sharing the base the first unused letter from B', () => {
    const records = [{ mrn: base, givenName: 'Amara', familyName: 'Nakato' }]
    expect(resolveMrnSuffix(base, 'Amara Nabirye', records)).toBe(`${base}B`)
  })

  it('skips letters that are already taken', () => {
    const records = [
      { mrn: base, givenName: 'Amara', familyName: 'Nakato' },
      { mrn: `${base}B`, givenName: 'Amara', familyName: 'Nabirye' },
    ]
    expect(resolveMrnSuffix(base, 'Amara Namutebi', records)).toBe(`${base}C`)
  })

  it('suffixes even when the unsuffixed original is absent - it implicitly holds A', () => {
    const records = [{ mrn: `${base}B`, givenName: 'Amara', familyName: 'Nabirye' }]
    expect(resolveMrnSuffix(base, 'Amara Namutebi', records)).toBe(`${base}C`)
  })

  it('ignores soft-deleted records', () => {
    const records = [{ mrn: base, givenName: 'Amara', familyName: 'Nakato', deleted: true }]
    expect(resolveMrnSuffix(base, 'Amara Nabirye', records)).toBe(base)
  })

  it('strips at most ONE trailing capital when recovering the base', () => {
    // 'AMNA12041990B' matches the base; a hypothetical double letter would not.
    const records = [{ mrn: `${base}BB`, givenName: 'Amara', familyName: 'Nabirye' }]
    expect(resolveMrnSuffix(base, 'Amara Namutebi', records)).toBe(base)
  })
})
