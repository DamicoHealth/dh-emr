/**
 * The Settings admin gate per product (src/ui/settings/SettingsScreen.tsx).
 *
 * Field: the DEVICE role chosen in the wizard gates every editor, with the
 * device-role copy verbatim (the Field guides quote it), and the This device
 * card shows that role.
 *
 * Clinic: the signed-in ACCOUNT's admin flag gates every editor (clinic
 * lists, formulary, lab tests and their ranges, the preset cards, the
 * template editor), with the account copy verbatim (the Clinic guides quote
 * it). The device role decides NOTHING there: a device that joined through
 * a link is 'standard' by design and the server accepts config writes only
 * from an admin account. Before this, a link-joined admin got a read-only
 * Settings screen and the gate copy told them to change a device setting
 * that does not exist in Clinic.
 */
import React from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { resetStorage } from './setup'
import { config, setCurrentDeviceId, setSetting, settings } from '../src/kernel'
import SettingsScreen, {
  CLINIC_GATE_REASON,
  type SettingsScreenProps,
} from '../src/ui/settings/SettingsScreen'

const h = React.createElement

/** The Field copy, verbatim. */
const FIELD_GATE_REASON = 'Only an admin device can change this. This device is set to standard.'

const SETTING_KEYS = [
  'deviceId',
  'deviceName',
  'deviceRole',
  'standaloneMode',
  'supabaseUrl',
  'supabaseKey',
]
const CONFIG_KEYS = [
  'sites',
  'providers',
  'complaints',
  'procedures',
  'referralTypes',
  'flowStations',
  'formulary',
  'customLabTests',
  'formTemplates',
  'formSchema',
  'customDxPresets',
  'rxPresets',
  'hiddenPresets',
]

/** Every gated save button on the screen, by its exact label. */
const SAVE_BUTTONS = [
  'Save sites',
  'Save formulary',
  'Save lab tests',
  'Save diagnosis quick-picks',
  'Save prescription presets',
]

beforeEach(async () => {
  await resetStorage()
  for (const k of SETTING_KEYS) await settings.remove(k)
  for (const k of CONFIG_KEYS) await config.remove(k)
  setCurrentDeviceId(null)
})

afterEach(() => {
  cleanup()
})

async function device(role: 'admin' | 'standard'): Promise<void> {
  await setSetting('deviceId', 'b8d5c8e2-9f11-4f6e-8d55-1234567890ab')
  await setSetting('deviceName', 'Clinic iPad')
  await setSetting('deviceRole', role)
}

const account = (isAdmin: boolean, role = 'pharmacy') => ({ displayName: 'Grace', role, isAdmin })

async function renderSettings(props: SettingsScreenProps): Promise<void> {
  render(h(SettingsScreen, props))
  await screen.findByText('Save sites')
  // The preset cards load on their own.
  await screen.findByText('Save prescription presets')
}

const button = (label: string): HTMLButtonElement => screen.getByText(label) as HTMLButtonElement

const card = (heading: string): HTMLElement =>
  screen.getByRole('heading', { name: heading }).closest('section') as HTMLElement

describe('Settings admin gate, product=clinic (the ACCOUNT decides)', () => {
  it('an admin account edits everything on a standard device (a link-joined device is standard by design)', async () => {
    await device('standard')
    await renderSettings({ product: 'clinic', account: account(true) })

    for (const label of SAVE_BUTTONS) {
      expect(button(label).disabled, label).toBe(false)
      expect(button(label).getAttribute('title'), label).toBeNull()
    }
    expect((screen.getByLabelText('Clinic or site names') as HTMLTextAreaElement).disabled).toBe(false)
    expect((screen.getByLabelText('Medication 1 name') as HTMLInputElement).disabled).toBe(false)
    expect(screen.queryByText(CLINIC_GATE_REASON)).toBeNull()
    expect(screen.queryByText(FIELD_GATE_REASON)).toBeNull()
    expect(screen.queryByText(/admin device/)).toBeNull()

    // The template editor opens editable as far as the admin gate goes (the
    // library here is synthesized, which is its own separate lock).
    fireEvent.click(screen.getByText('Open the template editor'))
    const builder = await screen.findByRole('dialog', { name: 'Form templates' })
    expect(within(builder).queryByText('Read only')).toBeNull()
    expect(within(builder).queryByText(CLINIC_GATE_REASON)).toBeNull()
  })

  it('a non-admin account is read-only with the account reason, even on an admin device', async () => {
    await device('admin')
    await renderSettings({ product: 'clinic', account: account(false, 'nurse') })

    for (const label of SAVE_BUTTONS) {
      expect(button(label).disabled, label).toBe(true)
      expect(button(label).getAttribute('title'), label).toBe(CLINIC_GATE_REASON)
    }
    const sites = screen.getByLabelText('Clinic or site names') as HTMLTextAreaElement
    expect(sites.disabled).toBe(true)
    expect(sites.getAttribute('title')).toBe(CLINIC_GATE_REASON)
    const med = screen.getByLabelText('Medication 1 name') as HTMLInputElement
    expect(med.disabled).toBe(true)
    expect(med.getAttribute('title')).toBe(CLINIC_GATE_REASON)

    // One gate note per gated card: Formulary, Lab tests, Diagnosis
    // quick-picks, Prescription presets; the two prose notes say the same.
    expect(screen.getAllByText(CLINIC_GATE_REASON)).toHaveLength(4)
    expect(
      screen.getByText(
        "Editing is turned off: only an administrator account can change clinic lists, the formulary or lab tests. Ask your clinic's admin.",
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        "The editor opens read-only: only an administrator account can change form templates. Ask your clinic's admin.",
      ),
    ).toBeTruthy()
    // The device-role copy never appears in Clinic.
    expect(screen.queryByText(FIELD_GATE_REASON)).toBeNull()
    expect(screen.queryByText(/admin device/)).toBeNull()

    // Account card: the role label the visit form header uses (the
    // pre-split 'nurse' resolves to Triage). This device: no Role row at all.
    const acct = card('Account')
    expect(within(acct).getByText('Role')).toBeTruthy()
    expect(within(acct).getByText('Triage')).toBeTruthy()
    expect(within(acct).queryByText('nurse')).toBeNull()
    const dev = card('This device')
    expect(within(dev).queryByText('Role')).toBeNull()
    expect(within(dev).queryByText('Admin')).toBeNull()
    expect(within(dev).queryByText('Standard')).toBeNull()

    // Template editor: Read only with the account reason on the banner and
    // on every control.
    fireEvent.click(screen.getByText('Open the template editor'))
    const builder = await screen.findByRole('dialog', { name: 'Form templates' })
    await within(builder).findByText('Read only')
    expect(within(builder).getByText(CLINIC_GATE_REASON)).toBeTruthy()
    expect(within(builder).getByLabelText('New form name').getAttribute('title')).toBe(
      CLINIC_GATE_REASON,
    )
    expect(within(builder).queryByText(FIELD_GATE_REASON)).toBeNull()
    fireEvent.click(within(builder).getByRole('button', { name: 'Close' }))

    // Reference ranges editor (a numeric built-in test): the same reason.
    fireEvent.click(screen.getAllByRole('button', { name: /reference ranges$/ })[0] as HTMLElement)
    const ranges = await screen.findByRole('dialog', { name: /^Reference ranges for / })
    await within(ranges).findByText('Read only')
    expect(within(ranges).getByText(CLINIC_GATE_REASON)).toBeTruthy()
    expect(within(ranges).queryByText(FIELD_GATE_REASON)).toBeNull()
  })
})

describe('Settings admin gate, product=field (the DEVICE decides, unchanged)', () => {
  it('a standard device is read-only with the device-role copy verbatim, and the Role row stays', async () => {
    await device('standard')
    await renderSettings({ product: 'field' })

    for (const label of SAVE_BUTTONS) {
      expect(button(label).disabled, label).toBe(true)
      expect(button(label).getAttribute('title'), label).toBe(FIELD_GATE_REASON)
    }
    expect(screen.getAllByText(FIELD_GATE_REASON)).toHaveLength(4)
    expect(
      screen.getByText(
        'Editing is turned off: only an admin device can change clinic lists, the formulary or lab tests. This device is set to standard.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByText(
        'The editor opens read-only: only an admin device can change form templates. This device is set to standard.',
      ),
    ).toBeTruthy()
    expect(screen.queryByText(CLINIC_GATE_REASON)).toBeNull()
    expect(screen.queryByText(/administrator account/)).toBeNull()
    // No accounts in Field; the device's own role is what the person sees.
    expect(screen.queryByRole('heading', { name: 'Account' })).toBeNull()
    const dev = card('This device')
    expect(within(dev).getByText('Role')).toBeTruthy()
    expect(within(dev).getByText('Standard')).toBeTruthy()
  })

  it('an admin device edits everything', async () => {
    await device('admin')
    await renderSettings({ product: 'field' })
    for (const label of SAVE_BUTTONS) expect(button(label).disabled, label).toBe(false)
    expect(screen.queryByText(FIELD_GATE_REASON)).toBeNull()
    expect(within(card('This device')).getByText('Admin')).toBeTruthy()
  })
})
