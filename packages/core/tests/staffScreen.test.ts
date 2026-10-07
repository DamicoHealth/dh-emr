/**
 * The Staff screen's copy (src/ui/staff/StaffScreen.tsx), rendered over a
 * mocked staffApi (no network):
 *  - roles are shown by their ROLE_LABELS, the same words as the visit form
 *    header and the template builder's Roles grid; the raw stored value is
 *    only ever the select's value, and a value outside the fixed list stays
 *    visible as stored so the admin can correct it;
 *  - the Make admin confirm describes what admins actually do. No mode
 *    switch exists anywhere in the app, so it must not promise one.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ActiveProfile } from '../src/auth'
import type { StaffRow } from '../src/ui/staff/staffApi'

const api = vi.hoisted(() => ({
  rows: [] as StaffRow[],
  patches: [] as { id: string; patch: Record<string, unknown> }[],
}))

vi.mock('../src/ui/staff/staffApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/staff/staffApi')>()
  const patch = (id: string, p: Record<string, unknown>): StaffRow => {
    api.patches.push({ id, patch: p })
    const row = api.rows.find((r) => r.id === id)
    if (!row) throw new Error(`no staff row ${id}`)
    const next = { ...row, ...p } as StaffRow
    api.rows = api.rows.map((r) => (r.id === id ? next : r))
    return next
  }
  return {
    ...actual,
    listStaff: async () => api.rows,
    setStationRole: async (id: string, role: string) => patch(id, { role }),
    setAdmin: async (id: string, isAdmin: boolean) => patch(id, { is_admin: isAdmin }),
  }
})

import StaffScreen from '../src/ui/staff/StaffScreen'

const h = React.createElement

const row = (over: Partial<StaffRow>): StaffRow => ({
  id: 'x',
  display_name: '',
  role: 'provider',
  is_admin: false,
  activated_at: '2026-10-01T00:00:00Z',
  revoked_at: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
})

const me: ActiveProfile = {
  userId: 'me',
  displayName: 'Alec',
  role: 'provider',
  isAdmin: true,
  confirmedAt: '2026-10-06T00:00:00Z',
}

beforeEach(() => {
  api.rows = [
    row({ id: 'me', display_name: 'Alec', is_admin: true }),
    row({ id: 'u2', display_name: 'Grace N.', role: 'pharmacy' }),
    // A pre-split role name still stored on the server.
    row({ id: 'u3', display_name: 'Odd One', role: 'nurse', activated_at: null }),
  ]
  api.patches = []
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const rowOf = (select: HTMLElement): HTMLElement => select.closest('.staff-row') as HTMLElement

describe('Staff screen roles', () => {
  it('shows roles by their labels in the select and the chip; the stored value is only the select value', async () => {
    render(h(StaffScreen, { profile: me }))
    const select = (await screen.findByLabelText('Station role for Grace N.')) as HTMLSelectElement
    expect(select.value).toBe('pharmacy')
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'Reception',
      'Triage',
      'Provider',
      'Lab',
      'Pharmacy',
    ])
    expect([...select.options].map((o) => o.value)).toEqual([
      'reception',
      'triage',
      'provider',
      'lab',
      'pharmacy',
    ])
    expect(within(rowOf(select)).getByText('Pharmacy', { selector: '.staff-chip' })).toBeTruthy()
    expect(within(rowOf(select)).queryByText('pharmacy')).toBeNull()

    // The odd stored value stays visible AS STORED, so it can be corrected.
    const odd = screen.getByLabelText('Station role for Odd One') as HTMLSelectElement
    expect(odd.value).toBe('nurse')
    expect(odd.options[0]?.textContent).toBe('nurse')
    expect(within(rowOf(odd)).getByText('nurse', { selector: '.staff-chip' })).toBeTruthy()

    // A change confirms with the label, and PATCHes the raw value.
    fireEvent.change(select, { target: { value: 'lab' } })
    await screen.findByText('Grace N. is now Lab.')
    expect(api.patches).toEqual([{ id: 'u2', patch: { role: 'lab' } }])
  })

  it('the Make admin confirm describes admin powers and never a mode switch', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(h(StaffScreen, { profile: me }))
    const select = await screen.findByLabelText('Station role for Grace N.')
    fireEvent.click(within(rowOf(select)).getByRole('button', { name: 'Make admin' }))
    expect(confirm).toHaveBeenCalledTimes(1)
    const text = String(confirm.mock.calls[0]?.[0])
    expect(text).toBe(
      "Make Grace N. an administrator?\n\nAdmins approve and revoke accounts, and edit the organization's lists, formulary and form templates.",
    )
    expect(text).not.toMatch(/mode/)
    await screen.findByText('Grace N. is now an administrator.')
    expect(api.patches).toEqual([{ id: 'u2', patch: { is_admin: true } }])
  })
})
