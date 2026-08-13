/**
 * Dialog behavior for overlay panels: focus on open, Escape routed to the
 * CALLER's close handler (so a form's discard confirmation still guards
 * typed work), a Tab trap that wraps both ends, and focus returned to the
 * opener on unmount.
 *
 * Consumers render something like:
 *   <aside ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true"
 *          aria-label="New visit" className="panel">
 * and pair it with useBodyScrollLock(true).
 */
import { useEffect, useRef, type MutableRefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), ' +
  'select:not([disabled]), textarea:not([disabled]), ' +
  '[tabindex]:not([tabindex="-1"])'

export function useDialog<T extends HTMLElement = HTMLElement>(
  onRequestClose: () => void,
): MutableRefObject<T | null> {
  const panelRef = useRef<T | null>(null)
  // Latest close handler without re-running the effect.
  const closeRef = useRef(onRequestClose)
  closeRef.current = onRequestClose

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    // preventScroll: do not scroll a long form back to the top on open.
    panelRef.current?.focus?.({ preventScroll: true })

    const onKeyDown = (e: KeyboardEvent): void => {
      const panel = panelRef.current
      if (!panel) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (focusables.length === 0) {
        e.preventDefault()
        panel.focus({ preventScroll: true })
        return
      }
      const first = focusables[0] as HTMLElement
      const last = focusables[focusables.length - 1] as HTMLElement
      const active = document.activeElement
      // Wrap at both ends AND pull focus back in if it escaped the panel.
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }

    // Capture phase, so the trap sees the key before any screen handler.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Put the user back where they were, not at the top of the page.
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true })
    }
  }, [])

  return panelRef
}
