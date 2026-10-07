/**
 * Dispensing quantity - a faithful port of calcMedQty() in the legacy app
 * (vendored at tests/fixtures/legacy/med-builder.js).
 *
 * This drives the pharmacy/dispensing totals in the analytics and donor report,
 * so it must produce the same numbers as the legacy form. Returns null when a
 * quantity cannot be determined (the legacy behavior), never a guess.
 * tests/medQtyParity.test.ts differential-tests this module against the
 * vendored legacy source on every commit.
 */
export interface FormularyEntry { id: string; name: string; unit?: string; dose?: string }

export const FREQ_DOSES_PER_DAY: Record<string, number | null> = {
  once: 1, q24h: 1, q12h: 2, q8h: 3, q6h: 4, qhs: 1, 'bid-topical': null, prn: null,
}

const COUNTABLE_UNITS = ['tabs', 'caps', 'sachet']

/** "500mg" / "1 g" -> milligrams. Ported from parseDoseToMg. */
export function parseDoseToMg(text: string): number | null {
  if (!text) return null
  // No \b. The old React port added one that the legacy med-builder.js does
  // not have, and it changes dispensing counts: "1 gram" matches g -> 1000mg
  // in the legacy app but nothing here, so the quantity silently halved. The
  // two apps write to the same records, so they must parse doses identically.
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*(mg|g|mcg)/i)
  if (!m) return null
  const numText = m[1]
  const unitText = m[2]
  if (numText === undefined || unitText === undefined) return null
  const n = parseFloat(numText)
  const unit = unitText.toLowerCase()
  if (unit === 'g') return n * 1000
  if (unit === 'mcg') return n / 1000
  return n
}

export interface MedQty {
  qty: number; unit: string; tabsPerDose: number; dpd: number; days: number
  /**
   * True when the dose string could not be read as either a tab count or an mg
   * amount, so tabsPerDose fell back to 1.
   *
   * The NUMBER is unchanged - this is the legacy behaviour and the donor report
   * depends on it - but the assumption used to be invisible. "one tablet"
   * happens to be right; "5ml" and "2 tablets" silently dispense the wrong
   * count. The form shows this so it can be corrected while the patient is
   * still in front of the clinician.
   */
  assumed: boolean
}

export function calcMedQty(
  medId: string, dose: string, freqVal: string, duration: string, formulary: FormularyEntry[],
): MedQty | null {
  const med = formulary.find((f) => f.id === medId)
  if (!med || !med.unit || !COUNTABLE_UNITS.includes(med.unit)) return null
  const dpd = FREQ_DOSES_PER_DAY[freqVal]
  if (dpd == null) return null
  if (duration === 'Ongoing') return null

  let days = 1
  const durMatch = /^(\d+)d$/.exec(duration || '')
  if (durMatch && durMatch[1] !== undefined) days = parseInt(durMatch[1], 10)
  else if (duration !== 'Single dose') return null

  const tabsMatch = /^(\d+)\s*tab/i.exec(dose || '')
  if (tabsMatch && tabsMatch[1] !== undefined) {
    const t = parseInt(tabsMatch[1], 10)
    return { qty: t * dpd * days, unit: med.unit, tabsPerDose: t, dpd, days, assumed: false }
  }
  const prescribedMg = parseDoseToMg(dose)
  // Strength can live in the NAME ("Paracetamol 500mg", the built-in shape) or
  // in a separate `dose` field, which is what the config admin UI produces.
  // Reading only the name meant every drug in a config-defined formulary fell
  // back to 1 unit per dose, so "1000mg" dispensed half what was prescribed.
  const unitMg = parseDoseToMg(med.name) ?? parseDoseToMg(med.dose || '')
  const readable = !!(prescribedMg && unitMg && unitMg > 0)
  const tabsPerDose = readable && prescribedMg && unitMg ? Math.ceil(prescribedMg / unitMg) : 1
  return { qty: tabsPerDose * dpd * days, unit: med.unit, tabsPerDose, dpd, days, assumed: !readable }
}
