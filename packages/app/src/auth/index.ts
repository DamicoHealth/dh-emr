/**
 * Public surface of the auth module (clinic mode).
 *
 * Composition note: profile.ts is a pure state machine over injected seams;
 * loadCurrentProfile below is the app wiring - the real session manager and
 * the authed REST helper. Screens and the shell import from HERE.
 */
export {
  NO_CLOUD_ERROR,
  authSession,
  createSessionManager,
} from './session'
export type {
  AuthClientAuth,
  AuthClientFactory,
  AuthClientLike,
  AuthSession,
  SessionManager,
  SessionManagerDeps,
  SignInResult,
  SignUpResult,
} from './session'
export {
  PROFILE_CACHE_KEY,
  PROFILE_STALE_MS,
  clearCachedProfile,
  loadProfile,
} from './profile'
export type { ActiveProfile, ProfileDeps, ProfileState } from './profile'
export { NO_SESSION_ERROR, authedRequest, postgrestErrorMessage } from './api'
export type { AuthedRequestDeps } from './api'
export { getOrgMode, parseOrgMode, subscribeOrgMode, useOrgMode } from './orgMode'
export type { OrgMode, OrgModeSubscriptionDeps } from './orgMode'

import { setCurrentUserId } from '../kernel'
import { authedRequest } from './api'
import { loadProfile, type ProfileState } from './profile'
import { authSession } from './session'

/** Where does the signed-in user stand, with the app's real wiring. */
export async function loadCurrentProfile(): Promise<ProfileState> {
  const state = await loadProfile({
    request: (path) => authedRequest(path),
    getSession: () => authSession.getSession(),
  })
  // Publish the author identity to the kernel: new records stamp user_id
  // from it, and the clinic-mode insert policy requires that stamp
  // (user_id must equal auth.uid()) or every push fails as NOT backed up.
  // Only an ACTIVE account authors visits; pending/revoked/signed-out
  // clear it so nothing is attributed to an account that cannot write.
  const session = await authSession.getSession()
  setCurrentUserId(state.state === 'active' && session ? session.user.id : null)
  return state
}
