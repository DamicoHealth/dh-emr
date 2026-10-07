/**
 * "Invite a device" for the Staff screen: the organization's join link as
 * text, a Copy button and a QR code, so no device ever types a project
 * address or key (src/sync/joinLink.ts). Admins only; everyone else sees
 * the controls disabled with the reason, like the rest of the Staff screen.
 *
 * The link is built from THIS device's stored credentials (the project it
 * is connected to) plus an organization name kept in device settings and
 * editable here; the link regenerates as the name is typed. The key the
 * link carries is the publishable key, public by design, and the card says
 * so in plain words together with who to share the link with.
 *
 * The QR is inline SVG from src/lib/qr.ts: no image pipeline, works
 * offline, and is drawn pure black on white with the standard quiet zone,
 * which is what camera apps read most reliably from another screen.
 */
import { useEffect, useMemo, useState } from 'react'
import { getSetting, setSetting } from '../../kernel'
import { encodeQr, qrSvgPath, type QrMatrix } from '../../lib/qr'
import { ORG_NAME_SETTING, currentAppUrl, encodeJoinLink, syncEngine } from '../../sync'
import { NOT_ADMIN_REASON } from './staffApi'

export interface InviteCardProps {
  /** Admin gate: non-admins see the card with disabled controls and the reason. */
  isAdmin: boolean
  /** Credentials source; defaults to the app's sync engine. */
  getCredentials?: () => { url: string | null; key: string | null }
  /** The app address the link opens; defaults to this page's own. */
  appUrl?: string
  /** Clipboard write; defaults to navigator.clipboard.writeText. */
  copyText?: (text: string) => Promise<void>
}

export const COPY_OK = 'Link copied. Paste it into a message to your staff.'
export const COPY_FAILED =
  'Could not copy automatically. Select the link above and copy it by hand.'
export const NO_PROJECT_LINK =
  'This device is not connected to a project, so there is no link to share yet.'
export const QR_UNAVAILABLE =
  'The link is too long for a QR code. Share the link itself instead.'

type Built = { link: string; qr: QrMatrix | null } | { error: string }

export default function InviteCard({ isAdmin, getCredentials, appUrl, copyText }: InviteCardProps) {
  // null until the stored name has been read, so the link is never built
  // from a blank name that a stored one would replace a moment later.
  const [orgName, setOrgName] = useState<string | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  useEffect(() => {
    let stale = false
    getSetting<string>(ORG_NAME_SETTING)
      .then((v) => {
        if (!stale) setOrgName(v ?? '')
      })
      .catch(() => {
        if (!stale) setOrgName('')
      })
    return () => {
      stale = true
    }
  }, [])

  const creds = (getCredentials ?? syncEngine.getCredentials)()
  const built = useMemo<Built | null>(() => {
    if (!isAdmin || orgName === null) return null
    if (!creds.url || !creds.key) return { error: NO_PROJECT_LINK }
    try {
      const link = encodeJoinLink(
        { url: creds.url, key: creds.key, orgName },
        { appUrl: appUrl ?? currentAppUrl() },
      )
      let qr: QrMatrix | null = null
      try {
        qr = encodeQr(link)
      } catch {
        qr = null // past version 20: the text link still works
      }
      return { link, qr }
    } catch (e) {
      // encodeJoinLink refuses a server key with the exact keys.ts copy.
      return { error: e instanceof Error ? e.message : String(e) }
    }
  }, [isAdmin, orgName, creds.url, creds.key, appUrl])

  const doCopy = async (): Promise<void> => {
    if (!built || !('link' in built)) return
    const write = copyText ?? ((t: string) => navigator.clipboard.writeText(t))
    try {
      await write(built.link)
      setNote({ tone: 'ok', text: COPY_OK })
    } catch {
      setNote({ tone: 'bad', text: COPY_FAILED })
    }
  }

  const path = built && 'link' in built && built.qr ? qrSvgPath(built.qr) : null

  return (
    <section className="card invite-card">
      <h3>Invite a device</h3>
      <p className="muted">
        Staff open this link on their device, or scan the code with its camera. The app sets
        itself up and shows sign-in; they create an account there, and you approve it below.
        Nobody types a project address or key.
      </p>
      {!isAdmin ? <p className="gate-note">{NOT_ADMIN_REASON}</p> : null}

      <label className="field">
        <span className="field-label">Organization name</span>
        <input
          value={orgName ?? ''}
          onChange={(e) => {
            const v = e.target.value
            setOrgName(v)
            void setSetting(ORG_NAME_SETTING, v)
          }}
          disabled={!isAdmin}
          placeholder="Kabale Community Clinic"
          autoComplete="organization"
        />
        <span className="field-hint">
          Shown on a device when it joins. It travels in the link, so set it before you share.
        </span>
      </label>

      {built && 'error' in built ? (
        <div className="alert alert-bad" role="alert">
          {built.error}
        </div>
      ) : null}

      {built && 'link' in built ? (
        <>
          <label className="field">
            <span className="field-label">Join link</span>
            <textarea
              className="mono invite-link"
              readOnly
              rows={3}
              value={built.link}
              onFocus={(e) => e.currentTarget.select()}
            />
          </label>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void doCopy()
              }}
            >
              Copy link
            </button>
          </div>
          {note ? (
            <div
              className={note.tone === 'ok' ? 'alert alert-info' : 'alert alert-bad'}
              role={note.tone === 'ok' ? 'status' : 'alert'}
            >
              {note.text}
            </div>
          ) : null}
          <div className="invite-qr">
            {path ? (
              <svg
                viewBox={`0 0 ${path.viewSize} ${path.viewSize}`}
                role="img"
                aria-label="QR code of the join link"
                shapeRendering="crispEdges"
              >
                <rect width={path.viewSize} height={path.viewSize} fill="#ffffff" />
                <path d={path.d} fill="#000000" />
              </svg>
            ) : (
              <p className="muted small">{QR_UNAVAILABLE}</p>
            )}
          </div>
        </>
      ) : null}

      {!isAdmin ? (
        <div className="btn-row">
          <button type="button" className="btn" disabled title={NOT_ADMIN_REASON}>
            Copy link
          </button>
        </div>
      ) : null}

      <p className="muted small">
        What the link carries: the project address, its publishable key and the organization
        name. The publishable key is public by design and unlocks nothing on its own, because
        every read and write needs an approved account. Anyone with the link can create an
        account that waits for your approval, so share it with staff, not the public.
      </p>
    </section>
  )
}
