/**
 * iOS Safari does not shrink the layout viewport for the software keyboard -
 * it slides the page up, so a 100%-height panel keeps its sticky footer
 * underneath the keyboard. This hook publishes the VISUAL viewport height as
 * --vvh; .panel consumes it via height: var(--vvh, 100%).
 *
 * No-op where visualViewport is unavailable (the CSS fallback covers it).
 */
import { useEffect } from 'react'

export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const update = (): void => {
      document.documentElement.style.setProperty('--vvh', `${Math.round(vv.height)}px`)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      document.documentElement.style.removeProperty('--vvh')
    }
  }, [])
}
