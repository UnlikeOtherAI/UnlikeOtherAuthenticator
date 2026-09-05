/**
 * Decides what an emailed team invitation should do when its link carries no
 * PKCE challenge.
 *
 * An invitation link is opened from a mailbox, not from an OAuth client, so it
 * has no code verifier and therefore cannot end in an authorization code. That
 * is fine for a new account, which lands on the invite registration screen and
 * signs in there. It was NOT fine for someone who already has an account: their
 * token is a `LOGIN_LINK`, the registration screen does not apply, and the
 * generic login restart drops the invitation entirely — the invitee is left
 * looking at a sign-in form whose social buttons then fail for want of PKCE,
 * with the invitation still pending forever.
 *
 * The mail-bound token is itself the whole proof an invitation needs, and the
 * invitee has already pressed Accept on the landing page that named the team.
 * So an existing account's invitation is consumed here and ends on a terminal
 * confirmation page; they sign in to the product normally afterwards.
 */
import type { ClientConfig } from './config.service.js';
import { AppError, isAppError } from '../utils/errors.js';
import {
  verifyEmailToken as defaultVerifyEmailToken,
  type VerifyEmailDeps,
} from './auth-verify-email.service.js';
import {
  getTeamInviteLandingData as defaultGetTeamInviteLandingData,
  type InviteTokenDeps,
} from './team-invite.service.js';

export type EmailInviteContinuation =
  /** No invitation is bound to this token; the caller keeps its historic behaviour. */
  | { kind: 'none' }
  /** A brand-new account: show the invite registration screen for this address. */
  | { kind: 'registration'; email: string }
  /** An existing account: the invitation has been accepted and the token consumed. */
  | { kind: 'accepted'; teamName: string; organisationName: string }
  /** The invitation could not be used (expired, revoked, already used, conflicting). */
  | { kind: 'unavailable'; error: unknown };

export type EmailInviteContinuationDeps = {
  inviteDeps?: InviteTokenDeps;
  verifyDeps?: VerifyEmailDeps;
  getTeamInviteLandingData?: typeof defaultGetTeamInviteLandingData;
  verifyEmailToken?: typeof defaultVerifyEmailToken;
};

export async function resolveEmailInviteContinuation(
  params: {
    token: string;
    configUrl: string;
    config: ClientConfig;
  },
  deps?: EmailInviteContinuationDeps,
): Promise<EmailInviteContinuation> {
  const getLandingData = deps?.getTeamInviteLandingData ?? defaultGetTeamInviteLandingData;
  const verifyToken = deps?.verifyEmailToken ?? defaultVerifyEmailToken;

  let invite: Awaited<ReturnType<typeof defaultGetTeamInviteLandingData>>;
  try {
    invite = await getLandingData(
      { token: params.token, configUrl: params.configUrl, config: params.config },
      deps?.inviteDeps,
    );
  } catch (err) {
    // A plain (non-invitation) email link reaches this path too, and must keep
    // its historic login restart. Only infrastructure failures surface.
    if (!isAppError(err)) throw err;
    return { kind: 'none' };
  }

  if (invite.tokenType === 'VERIFY_EMAIL_SET_PASSWORD') {
    return { kind: 'registration', email: invite.email };
  }

  try {
    const result = await verifyToken(
      { token: params.token, configUrl: params.configUrl, config: params.config },
      deps?.verifyDeps,
    );
    if (!result.acceptedInvite) {
      // The token was invitation-bound a moment ago, so this means the invite
      // row went away underneath us. Do not fall through to a login restart
      // that would silently swallow the invitation.
      return { kind: 'unavailable', error: new AppError('BAD_REQUEST', 400, 'INVALID_TOKEN') };
    }
    return {
      kind: 'accepted',
      teamName: invite.teamName,
      organisationName: invite.organisationName,
    };
  } catch (err) {
    if (!isAppError(err)) throw err;
    return { kind: 'unavailable', error: err };
  }
}
