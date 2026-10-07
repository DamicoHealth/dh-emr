/**
 * "You are simulating": the persistent role switcher for the Clinic demo.
 * A side panel from 640px up, a bottom sheet above the tab bar on phones,
 * collapsible either way. Picking a seat hands the shell a different
 * simulated profile (gate.ts); the shell then renders exactly what it
 * would for a real account with that role, landing on that role's
 * workspace. Data never resets on a switch.
 *
 * The lower half shows the simulated colleagues: a countdown to their next
 * action, Pause / Resume, Act now, and the last thing they did.
 */
import { DEMO_ROSTER, type DemoRoleId } from './gate'
import type { SimulatedAction } from './activity'

export interface DemoPanelProps {
  role: DemoRoleId
  onPick: (role: DemoRoleId) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  paused: boolean
  onTogglePause: () => void
  onActNow: () => void
  /** Seconds until the next simulated action, null while paused or finished. */
  nextIn: number | null
  finished: boolean
  acting: boolean
  lastAction: SimulatedAction | null
}

export const PANEL_TITLE = 'You are simulating'

export function DemoPanel({
  role,
  onPick,
  collapsed,
  onToggleCollapsed,
  paused,
  onTogglePause,
  onActNow,
  nextIn,
  finished,
  acting,
  lastAction,
}: DemoPanelProps) {
  const current = DEMO_ROSTER.find((m) => m.id === role)
  const status = finished
    ? 'The colleagues have finished their part of the day. Reset the demo to replay it.'
    : paused
      ? 'Paused. Nothing moves until you resume or press Act now.'
      : nextIn === null
        ? 'Colleagues are working.'
        : `Colleagues are working. Next action in about ${nextIn} s.`

  return (
    <aside
      className={collapsed ? 'demo-panel demo-panel-collapsed' : 'demo-panel'}
      aria-label={PANEL_TITLE}
    >
      <header className="demo-panel-head">
        <div>
          <h2 className="demo-panel-title">{PANEL_TITLE}</h2>
          <div className="demo-panel-current">{current?.label ?? role}</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost demo-panel-toggle"
          aria-expanded={!collapsed}
          onClick={onToggleCollapsed}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
      </header>

      {collapsed ? null : (
        <div className="demo-panel-body">
          <p className="muted small" style={{ margin: 0 }}>
            Pick a role to see the clinic the way that person does. Your changes stay as you
            switch, so you can check a patient in as Reception, triage them as Triage and
            dispense as Pharmacy.
          </p>
          <div className="demo-roles" role="radiogroup" aria-label="Role to simulate">
            {DEMO_ROSTER.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={m.id === role}
                className="demo-role"
                onClick={() => onPick(m.id)}
              >
                <span className="demo-role-label">{m.label}</span>
                <span className="demo-role-name">{m.profile.displayName}</span>
                <span className="demo-role-does">
                  {m.does}. Lands on: {m.landsOn}.
                </span>
              </button>
            ))}
          </div>

          <section className="demo-activity" aria-label="Simulated colleagues">
            <h3>Colleagues at work</h3>
            <p className="muted small" style={{ margin: 0 }} role="status">
              {status}
            </p>
            <div className="btn-row">
              <button type="button" className="btn" aria-pressed={paused} onClick={onTogglePause}>
                {paused ? 'Resume activity' : 'Pause activity'}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={onActNow}
                disabled={acting || finished}
              >
                {acting ? 'Working…' : 'Act now'}
              </button>
            </div>
            {lastAction ? (
              <p className="demo-last" role="status">
                Last: {lastAction.text}
              </p>
            ) : null}
          </section>
        </div>
      )}
    </aside>
  )
}
