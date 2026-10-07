/**
 * The account screens' brand (src/ui/auth). Only DH EMR Clinic has
 * accounts, so the sign-in / create account, awaiting-approval and revoked
 * screens say "DH EMR Clinic" by default (the same name as the Clinic top
 * bar, manifest and About card), never a bare "DH EMR". The brand prop
 * exists so a future host can say its own name without forking the screens.
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import SignInScreen from '../src/ui/auth/SignInScreen'
import PendingScreen from '../src/ui/auth/PendingScreen'
import RevokedScreen from '../src/ui/auth/RevokedScreen'

const h = React.createElement
const noop = async (): Promise<void> => {}

afterEach(() => {
  cleanup()
})

const screens = (brand?: string) => [
  h(SignInScreen, { onSignedIn: vi.fn(), ...(brand ? { brand } : {}) }),
  h(PendingScreen, {
    displayName: 'Grace',
    offline: false,
    onCheckAgain: noop,
    onSignOut: noop,
    ...(brand ? { brand } : {}),
  }),
  h(RevokedScreen, {
    displayName: 'Grace',
    onCheckAgain: noop,
    onSignOut: noop,
    ...(brand ? { brand } : {}),
  }),
]

describe('account screens brand', () => {
  it('all three say DH EMR Clinic by default', () => {
    for (const el of screens()) {
      render(el)
      expect(screen.getByText('DH EMR Clinic')).toBeTruthy()
      expect(screen.queryByText('DH EMR')).toBeNull()
      cleanup()
    }
  })

  it('the brand prop replaces the name on all three', () => {
    for (const el of screens('Kabale Clinic Records')) {
      render(el)
      expect(screen.getByText('Kabale Clinic Records')).toBeTruthy()
      expect(screen.queryByText('DH EMR Clinic')).toBeNull()
      cleanup()
    }
  })
})
