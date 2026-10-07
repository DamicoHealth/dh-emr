/**
 * The Staff screen of the Clinic demo: the simulated roster, local only.
 *
 * The real Staff screen (core/ui/staff/StaffScreen) talks to the org's
 * server through authedRequest, and the server's rules trigger is the
 * authority. The demo has no server (SAFETY LAW 4: no network, ever), so
 * this screen keeps the same shape and copy but reads and writes the
 * roster in the kernel settings KV under ONE known key (seeded by seed.ts,
 * restored by Reset demo). Approve, revoke, restore, role and admin
 * changes act on that local roster and nowhere else. The pure gating
 * helpers (staffStatus, isLastActiveAdmin, STATION_ROLES) are the real
 * ones, so the self-demotion guard reads exactly as in production.
 *
 * The "Invite a device" card is replaced by its not-available note: a join
 * link needs a project to point at.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ActiveProfile } from '@dh/core/auth'
import { settings } from '@dh/core/kernel'
import {
  LAST_ADMIN_REASON,
  NOT_ADMIN_REASON,
  STATION_ROLES,
  isLastActiveAdmin,
  pendingCount,
  staffStatus,
  type StaffRow,
} from '@dh/core/ui/staff/staffApi'
import '@dh/core/ui/staff/staff.css'
import { DEMO_STAFF_KEY } from './seed'

export interface DemoStaffScreenProps {
  profile: ActiveProfile
  onRefresh?: () => void
}

export const DEMO_INVITE_MESSAGE =
  'Inviting devices is not available in the demo. In a real clinic this card shows a join link ' +
  'and a QR code: a new device opens the link, sets itself up and shows sign-in, and nobody ' +
  'types a project address or key.'

type Message = { tone: 'ok' | 'bad'; text: string } | null

const STATUS_LABEL = { pending: 'Pending', active: 'Active', revoked: 'Revoked' } as const

async function readRoster(): Promise<StaffRow[]> {
  const v = await settings.get<StaffRow[]>(DEMO_STAFF_KEY)
  return Array.isArray(v) ? v : []
}

/** Patch one row on the stored roster and return the whole updated list. */
async function patchRoster(
  id: string,
  patch: (row: StaffRow) => StaffRow,
): Promise<{ rows: StaffRow[]; row: StaffRow }> {
  const rows = await readRoster()
  const idx = rows.findIndex((r) => r.id === id)
  if (idx < 0) throw new Error('That account is no longer on the roster.')
  const row = patch(rows[idx] as StaffRow)
  rows[idx] = row
  await settings.set(DEMO_STAFF_KEY, rows)
  return { rows, row }
}

export default function DemoStaffScreen({ profile, onRefresh }: DemoStaffScreenProps) {
  const [rows, setRows] = useState<StaffRow[] | null>(null)
  const [message, setMessage] = useState<Message>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setRows(await readRoster())
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (
    id: string,
    action: string,
    patch: (row: StaffRow) => StaffRow,
    okText: (r: StaffRow) => string,
  ): Promise<void> => {
    setBusy(`${id}:${action}`)
    setMessage(null)
    try {
      const r = await patchRoster(id, patch)
      setRows(r.rows)
      setMessage({ tone: 'ok', text: okText(r.row) })
      onRefresh?.()
    } catch (e) {
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
  const nameOf = (r: StaffRow): string => r.display_name || 'Unnamed account'
  const stamp = (): string => new Date().toISOString()

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

      <section className="card invite-card">
        <h3>Invite a device</h3>
        <p className="gate-note">{DEMO_INVITE_MESSAGE}</p>
      </section>

      <section className="card">
        <h3>Staff accounts</h3>
        <p className="muted">
          Approve new accounts, set station roles, and revoke access. A new account can see
          nothing until it is approved here. In this demo the roster is simulated and every
          change stays in this browser.
        </p>
        {!isAdmin ? <p className="gate-note">{NOT_ADMIN_REASON}</p> : null}
        {nPending > 0 ? (
          <p className="staff-pending-note" role="status">
            {nPending === 1
              ? '1 account is waiting for your approval.'
              : `${nPending} accounts are waiting for your approval.`}
          </p>
        ) : null}

        <ul className="staff-list">
          {rows.map((row) => {
            const status = staffStatus(row)
            const self = row.id === profile.userId
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
                  <span className={`staff-chip staff-chip-${status}`}>{STATUS_LABEL[status]}</span>
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
                          (r) => ({ ...r, role }),
                          (r) => `${nameOf(r)} is now ${r.role}.`,
                        )
                      }}
                      disabled={!canAct}
                      title={reason}
                    >
                      {roleOptions.map((r) => (
                        <option key={r} value={r}>
                          {r}
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
                          (r) => ({ ...r, activated_at: stamp() }),
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
                          (r) => ({ ...r, revoked_at: stamp() }),
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
                          (r) => ({ ...r, revoked_at: null }),
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
                          `Make ${nameOf(row)} an administrator?\n\nAdmins approve and revoke accounts, edit the organization's lists and formulary, and can switch the organization's mode.`,
                        )
                      ) {
                        return
                      }
                      void run(
                        row.id,
                        'admin',
                        (r) => ({ ...r, is_admin: next }),
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
          Revoking a seat here does not stop you simulating it from the panel.
        </p>
      </section>
    </div>
  )
}
