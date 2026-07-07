import { authStart, selectTeam, verifyLoginCode, type AuthFlowQuery } from './api.js';
import { interpretWorkspaceResponse, type WorkspaceResponseOutcome } from './workspace-response.js';

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
