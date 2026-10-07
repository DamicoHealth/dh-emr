/**
 * Counted body scroll lock - pure hook logic.
 *
 * The bug class under test: two panels overlap (patient chart open -> Edit
 * mounts the visit form while the chart is still unmounting). A per-call
 * save-previous-styles implementation read the already-locked styles as its
 * baseline and restored them forever, leaving body 'position: fixed;
 * top: -800px' and the app blank offscreen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { __lockDepth, useBodyScrollLock } from '../src/ui/lib/scrollLock'

function bodyStyles() {
  const s = document.body.style
  return { overflow: s.overflow, position: s.position, top: s.top, width: s.width }
}

const CLEAN = { overflow: '', position: '', top: '', width: '' }

const lock = () => renderHook(() => useBodyScrollLock(true))

/** jsdom's scrollY is not reliably assignable, so shadow it with a data prop. */
function setScrollY(y: number): void {
  Object.defineProperty(window, 'scrollY', { value: y, configurable: true, writable: true })
}

beforeEach(() => {
  document.body.setAttribute('style', '')
  window.scrollTo(0, 0)
  // no test may leak a lock into the next
  expect(__lockDepth()).toBe(0)
})

describe('body scroll lock', () => {
  it('locks the page and restores it exactly', () => {
    setScrollY(640)
    const r = lock()
    expect(bodyStyles()).toEqual({
      overflow: 'hidden',
      position: 'fixed',
      top: '-640px',
      width: '100%',
    })
    r.unmount()
    expect(bodyStyles()).toEqual(CLEAN)
    expect(__lockDepth()).toBe(0)
  })

  it('survives overlapping panels (chart open -> Edit -> form)', () => {
    setScrollY(800)
    const chart = lock()
    const form = lock()
    chart.unmount()
    // Still one panel open, so the page must stay locked.
    expect(bodyStyles().position).toBe('fixed')
    form.unmount()
    // the bug: stayed fixed at -800px forever
    expect(bodyStyles()).toEqual(CLEAN)
    expect(__lockDepth()).toBe(0)
  })

  it('records the scroll position from the FIRST lock, not a nested one', () => {
    // jsdom scrollTo is a no-op so watch the call
    const scrolled = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    setScrollY(500)
    const a = lock()
    expect(bodyStyles().top).toBe('-500px')
    setScrollY(0)
    const b = lock()
    // nested lock must not overwrite it
    expect(bodyStyles().top).toBe('-500px')
    b.unmount()
    a.unmount()
    expect(bodyStyles()).toEqual(CLEAN)
    // back to the patient they were on
    expect(scrolled).toHaveBeenCalledWith(0, 500)
    scrolled.mockRestore()
  })

  it('tolerates StrictMode double-invocation', () => {
    setScrollY(300)
    const first = lock()
    expect(bodyStyles().top).toBe('-300px')
    first.unmount()
    expect(bodyStyles()).toEqual(CLEAN)
    const second = lock()
    expect(bodyStyles().top).toBe('-300px')
    second.unmount()
    expect(bodyStyles()).toEqual(CLEAN)
  })

  it('does nothing when inactive', () => {
    const r = renderHook(() => useBodyScrollLock(false))
    expect(bodyStyles()).toEqual(CLEAN)
    r.unmount()
    expect(__lockDepth()).toBe(0)
  })
})
