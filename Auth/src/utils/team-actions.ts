import type { SessionChoices } from '../hooks/use-popup.js';
import {
  authStart,
  createTeam,
  createOrganisation,
  fetchSessionChoices,
  selectTeam,
  verifyLoginCode,
  type AuthFlowQuery,
  type TeamJoinPolicy,
} from './api.js';
import {
  interpretTeamResponse,
  isExpiredBridge,
  toSessionChoices,
  type TeamResponseOutcome,
} from './team-response.js';

/** POST /auth/verify-code, decoded into the next client step (Phase 3c, `CodeEntryPage`). */
export async function submitVerifyCode(
  params: { email: string; code: string } & AuthFlowQuery,
): Promise<TeamResponseOutcome> {
  const { email, code, ...query } = params;
  const result = await verifyLoginCode({ email, code }, query);
  // Not folded into `expired` here: on /auth/verify-code a 401 is a wrong or dead CODE, which the
  // user retypes on the same screen — there is no bridge yet to have expired.
  return interpretTeamResponse(result.ok ? result.data : null);
}

/**
 * POST /auth/select-team, decoded into the next client step. Shared by `TeamCard`,
 * `InviteCard` (accept/decline), and `CreateTeamDialog` — all three are the same call with a
 * different combination of `teamId`/`inviteId`/`action`.
 */
export async function submitTeamSelection(
  params: {
    loginToken: string;
    teamId?: string;
    inviteId?: string;
    action?: 'accept' | 'decline';
  } & AuthFlowQuery,
): Promise<TeamResponseOutcome> {
  const { loginToken, teamId, inviteId, action, ...query } = params;
  const result = await selectTeam({ login_token: loginToken, teamId, inviteId, action }, query);
  if (!result.ok && isExpiredBridge(result.status)) return { kind: 'expired' };
  return interpretTeamResponse(result.ok ? result.data : null);
}

/** Creates and selects a team with the same authenticated login capability as the chooser. */
export async function submitOrganisationCreation(
  params: { loginToken: string; name: string; joinPolicy?: TeamJoinPolicy } & AuthFlowQuery,
): Promise<TeamResponseOutcome> {
  const { loginToken, name, joinPolicy, ...query } = params;
  const result = await createOrganisation(
    { login_token: loginToken, name, join_policy: joinPolicy },
    query,
  );
  if (!result.ok && isExpiredBridge(result.status)) return { kind: 'expired' };
  return interpretTeamResponse(result.ok ? result.data : null);
}

/**
 * Creates and selects a further team inside an org the user already belongs to. Distinct from
 * `submitOrganisationCreation`, which creates a new organisation: here the org exists and
 * the server re-checks that this user is an ACTIVE owner/admin of it.
 */
export async function submitTeamCreation(
  params: {
    loginToken: string;
    orgId: string;
    name: string;
    joinPolicy?: TeamJoinPolicy;
  } & AuthFlowQuery,
): Promise<TeamResponseOutcome> {
  const { loginToken, orgId, name, joinPolicy, ...query } = params;
  const result = await createTeam(
    { login_token: loginToken, org_id: orgId, name, join_policy: joinPolicy },
    query,
  );
  if (!result.ok && isExpiredBridge(result.status)) return { kind: 'expired' };
  return interpretTeamResponse(result.ok ? result.data : null);
}

/**
 * POST /auth/start (resend). Brief §11 / no-enumeration: the server always answers with the same
 * generic success message, so the caller shows the same "sent" acknowledgement unconditionally.
 */
export async function requestSignInCode(params: { email: string } & AuthFlowQuery): Promise<void> {
  const { email, ...query } = params;
  await authStart({ email }, query);
}

/**
 * POST /auth/session-choices — hydrate the chooser payload for a `login_token` seeded via a
 * redirect (Phase 3c follow-up, `TeamChooserPage`'s social-callback hydration path). Unlike
 * `submitTeamSelection`/`submitVerifyCode` this never resolves to a twofa/redirect outcome — 2FA
 * already ran before the redirecting flow minted `login_token` — so the only results are the
 * chooser payload or `null` (a generic failure, left for the caller to render).
 */
export async function submitSessionChoices(
  params: { loginToken: string } & AuthFlowQuery,
): Promise<SessionChoices | 'expired' | null> {
  const { loginToken, ...query } = params;
  const result = await fetchSessionChoices({ login_token: loginToken }, query);
  if (result.ok) return toSessionChoices(result.data);
  return isExpiredBridge(result.status) ? 'expired' : null;
}
