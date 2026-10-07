/**
 * The Clinic demo's chrome around the real shell: the standing banner on
 * top, the app on the left (or full width on phones), the "You are
 * simulating" panel beside it (a bottom sheet on phones), the colleague
 * toast, and the timer that drives the simulated colleagues.
 *
 * The shell inside is the production App, fed a simulated profile through
 * DemoAppHooks (main.tsx); nothing here forks its role logic. The timer
 * performs one scripted action every 25-40 s (activity.ts), writes it
 * through the kernel, and tells the shell to refresh.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  activityCursor,
  activityFinished,
  isActivityPaused,
  onActivityPaused,
  setActivityPaused,
  simulateStep,
  stepDelayMs,
  SCRIPT,
  type SimulatedAction,
} from './activity'
import { DemoBanner } from './DemoBanner'
import { DemoPanel } from './DemoPanel'
import { currentDemoRole, notifyRecordsChanged, onDemoRoleChange, setDemoRole, type DemoRoleId } from './gate'
import './demo.css'

/** How long a colleague toast stays up. */
export const TOAST_MS = 6_000

function phoneWidth(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 639px)').matches
  } catch {
    return false
  }
}

export function DemoShell({ children }: { children: ReactNode }) {
  const [role, setRole] = useState<DemoRoleId>(() => currentDemoRole())
  const [paused, setPaused] = useState<boolean>(() => isActivityPaused())
  // The sheet starts closed on a phone so the board is visible first.
  const [collapsed, setCollapsed] = useState<boolean>(() => phoneWidth())
  const [finished, setFinished] = useState(false)
  const [acting, setActing] = useState(false)
  const [nextAt, setNextAt] = useState<number | null>(null)
  const [clock, setClock] = useState<number>(() => new Date().getTime())
  const [last, setLast] = useState<SimulatedAction | null>(null)
  const [toast, setToast] = useState<SimulatedAction | null>(null)
  // Bumped after a manual action so the timer re-arms from the new cursor.
  const [armNonce, setArmNonce] = useState(0)

  useEffect(() => onDemoRoleChange(() => setRole(currentDemoRole())), [])
  useEffect(() => onActivityPaused(setPaused), [])

  // Is the script already walked to its end (returning visitor)?
  useEffect(() => {
    let stale = false
    void activityFinished().then((f) => {
      if (!stale) setFinished(f)
    })
    return () => {
      stale = true
    }
  }, [])

  const announce = useCallback((a: SimulatedAction) => {
    setLast(a)
    setToast(a)
    notifyRecordsChanged()
  }, [])

  // One scripted action, now.
  const act = useCallback(async (): Promise<void> => {
    setActing(true)
    try {
      const a = await simulateStep()
      if (a) announce(a)
      if (await activityFinished()) setFinished(true)
    } catch (e) {
      console.warn('[demo] simulated action failed', e)
    } finally {
      setActing(false)
      setArmNonce((n) => n + 1)
    }
  }, [announce])

  // The timer: arm from the stored cursor, fire one action, re-arm.
  useEffect(() => {
    if (paused || finished) {
      setNextAt(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    void activityCursor().then((cursor) => {
      if (cancelled) return
      if (cursor >= SCRIPT.length) {
        setFinished(true)
        return
      }
      const delay = stepDelayMs(cursor)
      setNextAt(new Date().getTime() + delay)
      timer = setTimeout(() => {
        if (!cancelled) void act()
      }, delay)
    })
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [paused, finished, armNonce, act])

  // Countdown pulse while a next action is scheduled.
  useEffect(() => {
    if (nextAt === null) return
    const t = setInterval(() => setClock(new Date().getTime()), 1_000)
    return () => clearInterval(t)
  }, [nextAt])

  // Toast lifetime.
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), TOAST_MS)
    return () => clearTimeout(t)
  }, [toast])

  const togglePause = useCallback(() => {
    void setActivityPaused(!isActivityPaused())
  }, [])

  const nextIn = nextAt === null ? null : Math.max(0, Math.round((nextAt - clock) / 1000))

  return (
    <>
      <DemoBanner paused={paused} onTogglePause={togglePause} />
      <div className="demo-layout">
        <div className="demo-main">{children}</div>
        <DemoPanel
          role={role}
          onPick={(id) => {
            void setDemoRole(id)
          }}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((c) => !c)}
          paused={paused}
          onTogglePause={togglePause}
          onActNow={() => {
            void act()
          }}
          nextIn={nextIn}
          finished={finished}
          acting={acting}
          lastAction={last}
        />
      </div>
      {toast ? (
        <div className="demo-toast" role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}
    </>
  )
}
