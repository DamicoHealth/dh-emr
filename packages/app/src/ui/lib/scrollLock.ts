/**
 * Counted body scroll lock.
 *
 * The count and the saved scroll position are MODULE-LEVEL, not per hook
 * call, because panels genuinely overlap: opening a patient chart and then
 * Edit mounts the visit form while the chart is still unmounting. A per-call
 * save-previous-styles version read the already-locked styles as its
 * baseline and restored them forever, leaving the body stuck at
 * 'position: fixed; top: -800px' and the app blank offscreen.
 *
 * Rules:
 *  - Only the FIRST lock records window.scrollY and applies the styles.
 *  - Only the LAST release clears them - to '' outright, never a snapshot.
 *    The app never sets these four properties for any other purpose, so
 *    empty is the correct resting state and cannot carry a corrupt baseline.
 *  - position: fixed is the only thing iOS Safari reliably honours;
 *    overflow: hidden alone still allows touch scrolling.
 */
import { useEffect } from 'react'

let lockCount = 0
let savedScrollY = 0

function applyLock(): void {
  if (lockCount === 0) {
    savedScrollY = window.scrollY
    document.body.style.overflow = 'hidden'
    document.body.style.position = 'fixed'
    document.body.style.top = `-${savedScrollY}px`
    document.body.style.width = '100%'
  }
  lockCount++
}

function releaseLock(): void {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount > 0) return
  document.body.style.overflow = ''
  document.body.style.position = ''
  document.body.style.top = ''
  document.body.style.width = ''
  window.scrollTo(0, savedScrollY)
}

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    applyLock()
    return releaseLock
  }, [active])
}

/** Test seam: assert the lock fully unwound. */
export const __lockDepth = (): number => lockCount
