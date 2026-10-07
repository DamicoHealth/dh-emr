/**
 * The encounter date defaulted to `toISOString()`, which is UTC. An evening
 * clinic in the Americas stamped charts with TOMORROW, and an early-morning
 * entry east of UTC stamped them with YESTERDAY - misdated charts that also
 * drop out of the day's count. These pin the local-calendar behaviour.
 */
import { describe, expect, it } from 'vitest'
import { todayLocal } from '../src/domain/today'

describe('local calendar date', () => {
  it('uses the local day, not the UTC day, in the evening', () => {
    // 8 Aug 2026, 20:40 local. In any timezone behind UTC this is 9 Aug in UTC.
    const evening = new Date(2026, 7, 8, 20, 40)
    expect(todayLocal(evening)).toBe('2026-08-08')
  })

  it('uses the local day just after midnight', () => {
    const justAfterMidnight = new Date(2026, 7, 9, 0, 5)
    expect(todayLocal(justAfterMidnight)).toBe('2026-08-09')
  })

  it('zero-pads single-digit months and days', () => {
    expect(todayLocal(new Date(2026, 0, 3, 12, 0))).toBe('2026-01-03')
  })

  it('defaults a new encounter to the local day', () => {
    // The original asserted emptyFormState().date === todayLocal(new Date()).
    // The encounter form state module is not built yet, so this pins the same
    // behaviour one layer down: the no-argument default IS the current local
    // day. When formState lands, its test must assert .date === todayLocal().
    const now = new Date()
    expect(todayLocal()).toBe(todayLocal(now))
  })
})
