/**
 * Clinic-mode staff administration. The shell mounts this screen only for
 * an active admin, but the controls still gate on profile.isAdmin with the
 * reason shown: a cached profile can outlive a demotion, and a disabled
 * control that says why beats a server error after a tap.
 *
 * All server traffic goes through staffApi (which goes through
 * authedRequest, the one bearer-token seam). Server refusals - the rules
 * trigger's RAISE strings - are UI copy and appear VERBATIM in the banner.
 *
 * Self-demotion guard: when the signed-in admin is the only active admin,
 * their own Revoke and Remove admin controls are disabled with the same
 * sentence the server would raise. The server still enforces it; the UI
 * just spares the person the failed round trip.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ActiveProfile } from '../../auth'
import { ROLE_LABELS, isRole } from '../../config/roles'
import {
  LAST_ADMIN_REASON,
  NOT_ADMIN_REASON,
  STATION_ROLES,
  approveStaff,
  isLastActiveAdmin,
  listStaff,
  pendingCount,
  restoreStaff,
  revokeStaff,
  setAdmin,
  setStationRole,
  staffStatus,
  type StaffRow,
} from './staffApi'
import InviteCard from './InviteCard'
import './staff.css'

export interface StaffScreenProps {
  /** The signed-in admin (the shell only mounts this screen for admins). */
  profile: ActiveProfile
  /** Call after changing accounts so the shell can refresh dependent state. */
  onRefresh?: () => void
}

type Message = { tone: 'ok' | 'bad'; text: string } | null

const STATUS_LABEL = { pending: 'Pending', active: 'Active', revoked: 'Revoked' } as const

/**
 * What a role is CALLED on screen: the same ROLE_LABELS the visit form header
 * and the template builder's Roles grid use. The raw stored value is only
 * ever the select's value. A value outside the fixed list (a pre-split
 * 'nurse', a typo made in the dashboard) is shown as stored, so the admin
 * can see the odd value and correct it.
 */
const roleLabel = (role: string): string => (isRole(role) ? ROLE_LABELS[role] : role)

export default function StaffScreen({ profile, onRefresh }: StaffScreenProps) {
  const [rows, setRows] = useState<StaffRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [message, setMessage] = useState<Message>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null)
    try {
      setRows(await listStaff())
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      // Keep whatever roster we already had rather than blanking the screen.
      setRows((r) => r ?? [])
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (
    id: string,
    action: string,
    fn: () => Promise<StaffRow>,
    okText: (r: StaffRow) => string,
  ): Promise<void> => {
    setBusy(`${id}:${action}`)
    setMessage(null)
    try {
      const updated = await fn()
      setRows((rs) => (rs ?? []).map((r) => (r.id === updated.id ? updated : r)))
      setMessage({ tone: 'ok', text: okText(updated) })
      onRefresh?.()
    } catch (e) {
      // The server's exact words, e.g. 'Only an administrator can approve an
      // account.' A refusal can also mean the roster is stale (another admin
      // acted first), so reload it.
      setMessage({ tone: 'bad', text: e instanceof Error ? e.message : String(e) })
      void load()
    } finally {
      setBusy(null)
    }
  }

  if (rows === null) {
    return (
      <div className="screen">
        <div className="muted">Loading staff accounts…</div>
      </div>
    )
  }

  const isAdmin = profile.isAdmin
  const lastAdmin = isLastActiveAdmin(rows, profile.userId)
  const anyBusy = busy !== null
  const nPending = pendingCount(rows)
  const others = rows.filter((r) => r.id !== profile.userId)

  const nameOf = (r: StaffRow): string => r.display_name || 'Unnamed account'

  return (
    <div className="screen">
      {message ? (
        <div
          className={message.tone === 'ok' ? 'alert alert-info' : 'alert alert-bad'}
          role={message.tone === 'ok' ? 'status' : 'alert'}
        >
          {message.text}
        </div>
      ) : null}

      {loadError ? (
        <div className="alert alert-bad" role="alert">
          <strong>Could not load the staff list.</strong>
          <p>{loadError}</p>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void load()
              }}
            >
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {/* Join link + QR: how a new device gets its project without typing
          an address or key. Gated on the live admin flag like the rest. */}
      <InviteCard isAdmin={isAdmin} />

      <section className="card">
        <h3>Staff accounts</h3>
        <p className="muted">
          Approve new accounts, set station roles, and revoke access. A new account can see
          nothing until it is approved here. Changes are enforced by the server: a device that is
          offline keeps its last confirmed access and is cut off the moment it reconnects.
        </p>
        {!isAdmin ? <p className="gate-note">{NOT_ADMIN_REASON}</p> : null}
        {nPending > 0 ? (
          <p className="staff-pending-note" role="status">
            {nPending === 1
              ? '1 account is waiting for your approval.'
              : `${nPending} accounts are waiting for your approval.`}
          </p>
        ) : null}

        {others.length === 0 ? (
          <p className="muted">
            No one else is here yet. Connect a device with the invite link above; staff members
            then create their own accounts from its sign-in screen. New accounts appear on this
            list waiting for your approval, and they can see nothing until you approve them, so
            there is no rush.
          </p>
        ) : null}

        <ul className="staff-list">
          {rows.map((row) => {
            const status = staffStatus(row)
            const self = row.id === profile.userId
            // The only active admin must not lock the org out of itself.
            const selfGuard = self && lastAdmin
            const canAct = isAdmin && !anyBusy
            const reason = !isAdmin ? NOT_ADMIN_REASON : undefined
            const roleOptions = (STATION_ROLES as readonly string[]).includes(row.role)
              ? [...STATION_ROLES]
              : [row.role, ...STATION_ROLES]
            return (
              <li className="staff-row" key={row.id}>
                <div className="staff-id">
                  <span className="staff-name">
                    {nameOf(row)}
                    {self ? <span className="muted"> (you)</span> : null}
                  </span>
                  <span className={`staff-chip staff-chip-${status}`}>
                    {STATUS_LABEL[status]}
                  </span>
                  <span className="staff-chip staff-chip-role">{roleLabel(row.role)}</span>
                  {row.is_admin ? <span className="staff-chip staff-chip-admin">Admin</span> : null}
                </div>
                <div className="staff-controls">
                  <label className="staff-role">
                    <span className="sr-only">Station role for {nameOf(row)}</span>
                    <select
                      value={row.role}
                      onChange={(e) => {
                        const role = e.target.value
                        void run(
                          row.id,
                          'role',
                          () => setStationRole(row.id, role),
                          (r) => `${nameOf(r)} is now ${roleLabel(r.role)}.`,
                        )
                      }}
                      disabled={!canAct}
                      title={reason}
                    >
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  </label>

                  {status === 'pending' ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        void run(
                          row.id,
                          'approve',
                          () => approveStaff(row.id),
                          (r) => `${nameOf(r)} is approved and can sign in now.`,
                        )
                      }}
                      disabled={!canAct}
                      title={reason}
                    >
                      {busy === `${row.id}:approve` ? 'Approving…' : 'Approve'}
                    </button>
                  ) : null}

                  {status === 'active' ? (
                    <button
                      type="button"
                      className="btn btn-ghost btn-danger"
                      onClick={() => {
                        if (
                          !window.confirm(
                            `Revoke access for ${nameOf(row)}?\n\nThey are locked out the next time their device talks to the server. Nothing they recorded is deleted, and you can restore them here later.`,
                          )
                        ) {
                          return
                        }
                        void run(
                          row.id,
                          'revoke',
                          () => revokeStaff(row.id),
                          (r) => `${nameOf(r)} is revoked. It takes effect when their device next connects.`,
                        )
                      }}
                      disabled={!canAct || selfGuard}
                      title={!isAdmin ? NOT_ADMIN_REASON : selfGuard ? LAST_ADMIN_REASON : undefined}
                    >
                      {busy === `${row.id}:revoke` ? 'Revoking…' : 'Revoke'}
                    </button>
                  ) : null}

                  {status === 'revoked' ? (
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        void run(
                          row.id,
                          'restore',
                          () => restoreStaff(row.id),
                          (r) => `${nameOf(r)} is restored and can sign in again.`,
                        )
                      }}
                      disabled={!canAct}
                      title={reason}
                    >
                      {busy === `${row.id}:restore` ? 'Restoring…' : 'Restore'}
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      const next = !row.is_admin
                      if (
                        next &&
                        !window.confirm(
                          `Make ${nameOf(row)} an administrator?\n\nAdmins approve and revoke accounts, and edit the organization's lists, formulary and form templates.`,
                        )
                      ) {
                        return
                      }
                      void run(
                        row.id,
                        'admin',
                        () => setAdmin(row.id, next),
                        (r) =>
                          r.is_admin
                            ? `${nameOf(r)} is now an administrator.`
                            : `${nameOf(r)} is no longer an administrator.`,
                      )
                    }}
                    disabled={!canAct || (row.is_admin && selfGuard)}
                    title={
                      !isAdmin
                        ? NOT_ADMIN_REASON
                        : row.is_admin && selfGuard
                          ? LAST_ADMIN_REASON
                          : undefined
                    }
                  >
                    {busy === `${row.id}:admin`
                      ? 'Saving…'
                      : row.is_admin
                        ? 'Remove admin'
                        : 'Make admin'}
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        <p className="muted small">
          Revoking never deletes anything: visits an account recorded stay in the organization.
          If you ever lock yourself out entirely, the recovery steps live in the setup guide
          (SETUP.md), using the project dashboard.
        </p>
      </section>
    </div>
  )
}
