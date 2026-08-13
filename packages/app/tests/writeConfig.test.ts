/**
 * Sites and providers are typed once, at setup, and then stamped onto every
 * record the device files. Getting the parse wrong is not cosmetic: it puts a
 * clinician's name on records under a name that does not exist.
 */
import { describe, expect, it } from 'vitest'
import { isPlaceholderConfig, parseList } from '../src/config/keys'
import { DEFAULT_PHYSICIANS, DEFAULT_SITES } from '../src/config/defaults/lists'

describe('parseList', () => {
  it('takes one entry per line', () => {
    expect(parseList('Kabale Community Clinic\nMobile Unit A'))
      .toEqual(['Kabale Community Clinic', 'Mobile Unit A'])
  })

  it('keeps commas inside a value', () => {
    // "Grace N., clinical officer" is ONE provider. Splitting on the comma
    // turned her into two, and records then carried a provider who does not
    // exist.
    expect(parseList('Dr. A. Mensah\nGrace N., clinical officer'))
      .toEqual(['Dr. A. Mensah', 'Grace N., clinical officer'])
    expect(parseList('Kabale, Kigezi')).toEqual(['Kabale, Kigezi'])
  })

  it('trims, drops blank lines and de-duplicates', () => {
    expect(parseList('  A  \n\n\nB\nA\n   ')).toEqual(['A', 'B'])
  })

  it('returns nothing for an empty entry, so setup never pins an empty list', () => {
    // Writing [] would leave the Site select empty, which blocks every save.
    expect(parseList('')).toEqual([])
    expect(parseList('   \n  ')).toEqual([])
  })
})

describe('isPlaceholderConfig', () => {
  it('recognises a device still on the built-in placeholders', () => {
    expect(isPlaceholderConfig([...DEFAULT_SITES], [...DEFAULT_PHYSICIANS])).toBe(true)
    expect(isPlaceholderConfig([...DEFAULT_SITES], ['Dr. A. Mensah'])).toBe(true)
  })

  it('accepts a device that has been configured', () => {
    expect(isPlaceholderConfig(['Kabale Community Clinic'], ['Dr. A. Mensah'])).toBe(false)
  })
})
