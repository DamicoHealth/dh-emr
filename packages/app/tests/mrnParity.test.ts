/**
 * DIFFERENTIAL TEST: this app and the legacy app must mint the SAME
 * patient number for every possible name.
 *
 * They sync into one Supabase project and one records list. If they disagree,
 * the same human being gets two charts and a clinician reviewing history sees
 * half of it. This reads the vendored legacy implementation straight off disk
 * and runs both over the same inputs, so the two can never silently drift
 * apart again.
 *
 * This exists because a "safe" Unicode fix did drift: normalising the name
 * before stripping re-keyed every patient whose name STARTS with an accented
 * letter (Olafur with an accented O went from LA to OL), which would have split
 * the chart of every such patient already in the field.
 */
import { describe, expect, it } from 'vitest'
import { generateBaseMRN } from '../src/domain/mrn'

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

/** Pull twoInitials + generateBaseMRN out of the legacy app and make them callable. */
function loadLegacyMRN(): (g: string, f: string, dob: string) => string {
  const src = readFileSync(fixturePath('helpers.js'), 'utf8')
  const two = src.match(/function twoInitials\(name\)[\s\S]*?\n\}/)
  const base = src.match(/function generateBaseMRN\(given, family, dob\)[\s\S]*?\n\}/)
  if (!two || !base) throw new Error('Could not find the MRN functions in tests/fixtures/legacy/helpers.js')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${two[0]}\n${base[0]}\nreturn generateBaseMRN;`)() as (g: string, f: string, dob: string) => string
}

const NAMES = [
  // plain ASCII
  'Amara', 'Joseph', 'Grace', 'A', 'Ann-Marie', "O'Brien", 'Mary Jane',
  // accented Latin, including the accent-in-first-two case that regressed
  'José', 'Zoë', 'Müller', 'Ólafur', 'Émile', 'Ökonom', 'Ñuñez', 'Ægir', 'Øystein', 'Straße',
  // non-Latin scripts, which the original could not file at all
  'አማራ', 'ንጉሤ', 'محمد', 'حسن', 'Ольга', 'Иванова', 'สมชาย', 'ใจดี', '李', '王小明',
  // degenerate input
  '', '   ', '1234', 'A1B2', '--', 'ß',
]

describe('MRN parity between this app and the legacy app', () => {
  const legacyMRN = loadLegacyMRN()

  it('agrees on every combination of names', () => {
    const divergences: string[] = []
    for (const g of NAMES) {
      for (const f of NAMES) {
        const legacy = legacyMRN(g, f, '1990-04-12')
        const react = generateBaseMRN(g, f, '1990-04-12')
        if (legacy !== react) divergences.push(`${JSON.stringify([g, f])}: legacy=${legacy || '(none)'} react=${react || '(none)'}`)
      }
    }
    expect(divergences).toEqual([])
  })

  it('agrees across a range of dates', () => {
    const divergences: string[] = []
    for (const dob of ['1990-04-12', '2001-01-01', '1955-12-31', '2026-02-28', 'bad-date', '']) {
      const legacy = legacyMRN('Amara', 'Nakato', dob)
      const react = generateBaseMRN('Amara', 'Nakato', dob)
      if (legacy !== react) divergences.push(`${dob}: legacy=${legacy} react=${react}`)
    }
    expect(divergences).toEqual([])
  })

  it('still files a patient whose name is not written in Latin letters', () => {
    // The whole point of the change. If this ever goes back to '', the two apps
    // agree again but the patient cannot be entered at all.
    expect(generateBaseMRN('አማራ', 'ንጉሤ', '1990-04-12')).not.toBe('')
    expect(legacyMRN('አማራ', 'ንጉሤ', '1990-04-12')).not.toBe('')
  })
})
