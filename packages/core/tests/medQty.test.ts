/**
 * Dispensing quantity feeds the pharmacy count and the donor report, so the
 * NUMBERS here must match the legacy med-builder.js exactly. What changed is
 * that an unreadable dose string now says so instead of silently assuming one
 * unit per dose.
 */
import { describe, expect, it } from 'vitest'
import { calcMedQty, FREQ_DOSES_PER_DAY, parseDoseToMg } from '../src/domain/medQty'
import { FREQUENCIES } from '../src/domain/constants'

describe('parseDoseToMg', () => {
  it('reads mg, g and mcg', () => {
    expect(parseDoseToMg('500mg')).toBe(500)
    expect(parseDoseToMg('1 g')).toBe(1000)
    expect(parseDoseToMg('250 mcg')).toBe(0.25)
  })
  it('returns null for anything it cannot read', () => {
    expect(parseDoseToMg('one tablet')).toBeNull()
    expect(parseDoseToMg('5ml')).toBeNull()
    expect(parseDoseToMg('')).toBeNull()
  })
})

describe('strength from a separate dose field', () => {
  // The config admin UI stores { name: 'Paracetamol', dose: '500mg' } rather
  // than putting the strength in the name. Reading only the name meant every
  // drug in such a formulary assumed 1 unit per dose.
  const split = [{ id: 'para', name: 'Paracetamol', dose: '500mg', unit: 'tabs' }]

  it('reads the strength from dose when the name has none', () => {
    const q = calcMedQty('para', '1000mg', 'q8h', '5d', split)!
    expect(q.tabsPerDose).toBe(2)
    expect(q.qty).toBe(30)
    expect(q.assumed).toBe(false)
  })

  it('does not flag a normal prescription against a split formulary', () => {
    const q = calcMedQty('para', '500mg', 'q8h', '5d', split)!
    expect(q.qty).toBe(15)
    expect(q.assumed).toBe(false)
  })
})

describe('unreadable dose strings', () => {
  const formulary = [{ id: 'para', name: 'Paracetamol 500mg', unit: 'tabs' }]

  it('flags a dose the parser cannot read, without changing the number', () => {
    // Legacy behaviour assumes 1 per dose. That is right for "one tablet" and
    // silently wrong for "5ml" or "2 tablets" - the count was invisible either
    // way, so the pharmacy total could be half what was intended.
    const q = calcMedQty('para', 'one tablet', 'q8h', '5d', formulary)!
    expect(q.qty).toBe(15)               // unchanged: the donor report depends on it
    expect(q.assumed).toBe(true)         // but the guess is now visible
  })

  it('does not flag a readable mg dose', () => {
    const q = calcMedQty('para', '500mg', 'q8h', '5d', formulary)!
    expect(q.qty).toBe(15)
    expect(q.assumed).toBe(false)
  })

  it('does not flag an explicit tab count', () => {
    const q = calcMedQty('para', '2 tabs', 'q12h', '3d', formulary)!
    expect(q.qty).toBe(12)
    expect(q.assumed).toBe(false)
  })

  it('doubles correctly when the mg dose is two tablets worth', () => {
    const q = calcMedQty('para', '1000mg', 'q8h', '5d', formulary)!
    expect(q.tabsPerDose).toBe(2)
    expect(q.qty).toBe(30)
    expect(q.assumed).toBe(false)
  })
})

describe('constants alignment', () => {
  it('every FREQUENCIES value is a key of FREQ_DOSES_PER_DAY', () => {
    // calcMedQty looks freqVal up verbatim; an unknown key silently means
    // "no quantity", so a drifting dropdown value would zero the pharmacy count.
    for (const f of FREQUENCIES) {
      expect(Object.prototype.hasOwnProperty.call(FREQ_DOSES_PER_DAY, f.value), f.value).toBe(true)
    }
  })
})
