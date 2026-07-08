import type { WorkspaceChoices } from '../hooks/use-popup.js';
import { authStart, fetchSessionChoices, selectTeam, verifyLoginCode, type AuthFlowQuery } from './api.js';
import {
  interpretWorkspaceResponse,
  toWorkspaceChoices,
  type WorkspaceResponseOutcome,
} from './workspace-response.js';

/** POST /auth/verify-code, decoded into the next client step (Phase 3c, `CodeEntryPage`). */
export async function submitVerifyCode(
  params: { email: string; code: string } & AuthFlowQuery,
): Promise<WorkspaceResponseOutcome> {
  const { email, code, ...query } = params;
  const result = await verifyLoginCode({ email, code }, query);
  return interpretWorkspaceResponse(result.ok ? result.data : null);
}

/**
 * POST /auth/select-team, decoded into the next client step. Shared by `WorkspaceCard`,
 * `InviteCard` (accept/decline), and `CreateWorkspaceCard` — all three are the same call with a
 * different combination of `teamId`/`inviteId`/`action`.
 */
export async function submitTeamSelection(
  params: {
    loginToken: string;
    teamId?: string;
    inviteId?: string;
    action?: 'accept' | 'decline';
  } & AuthFlowQuery,
): Promise<WorkspaceResponseOutcome> {
  const { loginToken, teamId, inviteId, action, ...query } = params;
  const result = await selectTeam({ login_token: loginToken, teamId, inviteId, action }, query);
  return interpretWorkspaceResponse(result.ok ? result.data : null);
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
 * redirect (Phase 3c follow-up, `WorkspaceChooserPage`'s social-callback hydration path). Unlike
 * `submitTeamSelection`/`submitVerifyCode` this never resolves to a twofa/redirect outcome — 2FA
 * already ran before the redirecting flow minted `login_token` — so the only results are the
 * chooser payload or `null` (a generic failure, left for the caller to render).
 */
export async function submitSessionChoices(
  params: { loginToken: string } & AuthFlowQuery,
): Promise<WorkspaceChoices | null> {
  const { loginToken, ...query } = params;
  const result = await fetchSessionChoices({ login_token: loginToken }, query);
  return result.ok ? toWorkspaceChoices(result.data) : null;
}
