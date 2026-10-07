/**
 * DIFFERENTIAL TEST: dispensing quantity must be identical in both apps.
 *
 * The number goes onto the record and into the pharmacy and donor totals. The
 * old React port had added a \b to the unit regex that the legacy app lacks, so
 * "1 gram" parsed as 1000mg in one app and not at all in the other - a silently
 * halved dispensing count for the same prescription.
 */
import { describe, expect, it } from 'vitest'
import { calcMedQty, parseDoseToMg } from '../src/domain/medQty'

// @types/node is not installed in this package, so node:fs comes in through an
// untyped dynamic import. Vitest runs tests in Node, where it always resolves.
const { readFileSync } = (await import('node:fs' as string)) as {
  readFileSync: (path: string, encoding: 'utf8') => string
}
const { resolve } = (await import('node:path' as string)) as {
  resolve: (...parts: string[]) => string
}
const { cwd } = (await import('node:process' as string)) as { cwd: () => string }

/** Absolute path of a vendored legacy fixture. Resolved from the package
 *  root (vitest's cwd), not import.meta.url: under the jsdom environment
 *  import.meta.url is an http URL, not a file path. */
function fixturePath(name: string): string {
  return resolve(cwd(), 'tests/fixtures/legacy', name)
}

type LegacyQty = { qty: number; unit: string; tabsPerDose: number } | null
type Formulary = { id: string; name: string; unit?: string; dose?: string }[]

/**
 * Load the legacy implementation off disk. calcMedQty there reads the formulary
 * from a getFormulary() global, so the harness injects one.
 */
function loadLegacy(formulary: Formulary): {
  parseDoseToMg: (s: string) => number | null
  calcMedQty: (id: string, dose: string, freq: string, dur: string) => LegacyQty
} {
  const src = readFileSync(fixturePath('med-builder.js'), 'utf8')
  const parse = src.match(/function parseDoseToMg\([\s\S]*?\n\}/)
  const calc = src.match(/function calcMedQty\([\s\S]*?\n\}/)
  const freq = src.match(/const FREQ_DOSES_PER_DAY = \{[^}]*\};/)
  if (!parse || !calc || !freq) throw new Error('Could not find the quantity functions in tests/fixtures/legacy/med-builder.js')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('getFormulary', `${freq[0]}\n${parse[0]}\n${calc[0]}\nreturn { parseDoseToMg, calcMedQty };`)(
    () => formulary,
  ) as never
}

const FORMULARY: Formulary = [
  { id: 'para', name: 'Paracetamol 500mg', unit: 'tabs' },
  { id: 'split', name: 'Paracetamol', dose: '500mg', unit: 'tabs' },
  { id: 'syrup', name: 'Amoxicillin syrup', unit: 'ml' },
]

const DOSES = ['500mg', '1 g', '1 gram', '2 grams', '250 mcg', '200 mgs', '1g', '2 tabs',
  '1 tab', 'one tablet', '5ml', '', '0.5g', '1000mg', '1.5 g', '750 MG']

describe('dose parsing parity', () => {
  const legacy = loadLegacy(FORMULARY)

  it('parses every dose string the same way as the legacy app', () => {
    const divergences: string[] = []
    for (const d of DOSES) {
      const a = legacy.parseDoseToMg(d)
      const b = parseDoseToMg(d)
      if ((a ?? null) !== (b ?? null)) divergences.push(`${JSON.stringify(d)}: legacy=${a} react=${b}`)
    }
    expect(divergences).toEqual([])
  })

  it('reads a spelled-out gram, which the \\b regression broke', () => {
    expect(parseDoseToMg('1 gram')).toBe(1000)
    expect(parseDoseToMg('2 grams')).toBe(2000)
    expect(parseDoseToMg('200 mgs')).toBe(200)
  })

  it('produces the same dispensing quantity for every prescription shape', () => {
    for (const id of ['para', 'split', 'syrup', 'unknown']) {
      for (const dose of DOSES) {
        for (const [freq, dur] of [['q8h', '5d'], ['q6h', '3d'], ['q12h', '7d'],
          ['once', 'Single dose'], ['prn', '5d'], ['q8h', 'Ongoing'], ['q8h', 'nonsense']] as const) {
          const a = legacy.calcMedQty(id, dose, freq, dur)
          const b = calcMedQty(id, dose, freq, dur, FORMULARY)
          expect(b?.qty ?? null, `id=${id} dose=${dose} freq=${freq} dur=${dur}`).toBe(a?.qty ?? null)
          expect(b?.tabsPerDose ?? null, `tabsPerDose id=${id} dose=${dose}`).toBe(a?.tabsPerDose ?? null)
        }
      }
    }
  })
})
