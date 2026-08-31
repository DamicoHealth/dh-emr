/**
 * Update gate: the state machine behind the user-gated "Update now" bar.
 *
 * The contract under test (REBUILD-HANDOFF sections 7 and 8):
 *  - Clinical builds are USER-GATED: a waiting worker shows a banner and
 *    nothing ever reloads on its own.
 *  - Demo builds auto-update: the bar never shows there.
 *  - "Not now" silences the bar for the running session ONLY - dismissal
 *    is never persisted, so a still-pending update asks again next boot.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  autoUpdateFlag,
  createUpdateGate,
  isAutoUpdateBuild,
  updateGate,
} from '../src/sw/updateGate'

describe('autoUpdateFlag (build-flag normalization)', () => {
  it('selects auto-update only for the literal boolean true', () => {
    expect(autoUpdateFlag(true)).toBe(true)
    expect(autoUpdateFlag(false)).toBe(false)
    expect(autoUpdateFlag(undefined)).toBe(false)
    // Stray truthy values from a misconfigured define stay on the safe,
    // user-gated path.
    expect(autoUpdateFlag('1')).toBe(false)
    expect(autoUpdateFlag(1)).toBe(false)
  })

  it('reads clinical (user-gated) in this test build, where __DH_DEMO__ is false', () => {
    expect(isAutoUpdateBuild()).toBe(false)
  })
})

describe('clinical gate (user-gated updates)', () => {
  it('starts quiet: no bar before a worker is waiting', () => {
    const gate = createUpdateGate(false)
    expect(gate.state()).toEqual({ needRefresh: false, dismissed: false })
    expect(gate.shouldShowBar()).toBe(false)
  })

  it('shows the bar when a new worker is waiting', () => {
    const gate = createUpdateGate(false)
    gate.noteNeedRefresh()
    expect(gate.state().needRefresh).toBe(true)
    expect(gate.shouldShowBar()).toBe(true)
  })

  it('notifies subscribers once per transition, not per repeat call', () => {
    const gate = createUpdateGate(false)
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.noteNeedRefresh()
    gate.noteNeedRefresh()
    gate.noteNeedRefresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dismiss hides the bar but keeps the update pending', () => {
    const gate = createUpdateGate(false)
    gate.noteNeedRefresh()
    gate.dismiss()
    expect(gate.shouldShowBar()).toBe(false)
    expect(gate.state()).toEqual({ needRefresh: true, dismissed: true })
  })

  it('dismiss before anything is pending is a silent no-op', () => {
    const gate = createUpdateGate(false)
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.dismiss()
    expect(listener).not.toHaveBeenCalled()
    expect(gate.state().dismissed).toBe(false)
  })

  it('repeated dismiss does not re-notify', () => {
    const gate = createUpdateGate(false)
    gate.noteNeedRefresh()
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.dismiss()
    gate.dismiss()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('dismissal lives in memory only: nothing is written to storage', () => {
    // A persisted dismissal would silence the bar across boots, breaking
    // the reappears-next-boot rule. The gate must not touch localStorage.
    const gate = createUpdateGate(false)
    gate.noteNeedRefresh()
    gate.dismiss()
    expect(localStorage.length).toBe(0)
  })

  it('a fresh gate (next boot) shows the bar again for a still-pending update', () => {
    const first = createUpdateGate(false)
    first.noteNeedRefresh()
    first.dismiss()
    expect(first.shouldShowBar()).toBe(false)
    // Reboot: a new gate is built and the still-waiting worker fires
    // onNeedRefresh again during registration.
    const next = createUpdateGate(false)
    next.noteNeedRefresh()
    expect(next.shouldShowBar()).toBe(true)
  })

  it('unsubscribe stops notifications', () => {
    const gate = createUpdateGate(false)
    const listener = vi.fn()
    const unsub = gate.subscribe(listener)
    unsub()
    gate.noteNeedRefresh()
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('demo gate (auto-update build)', () => {
  it('never shows the bar, even with a waiting worker', () => {
    const gate = createUpdateGate(true)
    gate.noteNeedRefresh()
    expect(gate.shouldShowBar()).toBe(false)
  })

  it('dismiss on the auto path is a silent no-op', () => {
    const gate = createUpdateGate(true)
    gate.noteNeedRefresh()
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.dismiss()
    expect(listener).not.toHaveBeenCalled()
    expect(gate.state().dismissed).toBe(false)
  })
})

describe('app-wide singleton', () => {
  it('boots quiet and user-gated in this build', () => {
    // Read-only assertions: the singleton is module state shared with the
    // UpdateBar; tests must not mutate it.
    expect(updateGate.shouldShowBar()).toBe(false)
    expect(updateGate.state().needRefresh).toBe(false)
  })
})
