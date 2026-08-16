import type { ClientConfig } from './config.service.js';
import { getPrisma } from '../db/prisma.js';
import { AppError } from '../utils/errors.js';
import {
  assertDatabaseEnabled,
  auditOrg,
  type OrgActorProvenance,
  getOrganisationMember,
  resolveOrgActor,
} from './organisation.service.base.js';
import { hasWorkspaceCapability } from './team.service.base.js';
import {
  TEAM_INVITE_SELECT,
  type InviteDeps,
  type InvitePrisma,
  getEnv,
  resolveInviteTarget,
} from './team-invite.service.base.js';

// Invitation revocation (extends design §4.7): DELETE .../teams/:teamId/invitations/:inviteId.
// Follows the team-invite-link revoke slicing — its own file, mirroring the existing
// base/token/acceptance/management/resend/member split.

/**
 * Permission: backend mode (no acting user — the domain pairing outranks any member role) or, in
 * user mode, a holder of `members.manage` (shared `hasWorkspaceCapability` check) or the invite's original
 * inviter. The inviter branch still requires a live ACTIVE org membership (the Phase 2 `activeOnly`
 * actor rule); a deactivated/removed inviter keeps no power over their old invites.
 */
async function canRevokeInvite(
  prisma: InvitePrisma,
  params: {
    orgId: string;
    teamId: string;
    actorUserId: string | undefined;
    invitedByUserId: string | null;
    config: ClientConfig;
  },
): Promise<boolean> {
  if (!params.actorUserId) return true;
  if (await hasWorkspaceCapability(prisma, 'members.manage', params)) return true;

  if (params.invitedByUserId && params.invitedByUserId === params.actorUserId) {
    const membership = await getOrganisationMember(
      prisma,
      { orgId: params.orgId, userId: params.actorUserId },
      { activeOnly: true },
    );
    return Boolean(membership);
  }

  return false;
}

/**
 * `DELETE /org/organisations/:orgId/teams/:teamId/invitations/:inviteId` — revoke a pending
 * invitation, whether already sent or still awaiting member-invite approval.
 *
 * Outcomes:
 *   - pending (sent or awaiting approval, expired included) → `revokedAt`/`revokedReason: REVOKED`
 *     stamped (the row is kept — invite history is audit history), outstanding emailed tokens are
 *     consumed, an `invite.revoked` audit row is written → `{ ok: true }`.
 *   - already revoked (explicitly or by replacement) or already declined → idempotent
 *     `{ ok: true }` with no second write and no second audit row.
 *   - already accepted → 409 `INVITATION_ALREADY_ACCEPTED` (membership already exists; removing
 *     the member is a member-lifecycle action, not an invite action).
 *   - unknown id, foreign org/team, cross-domain → generic 404 (no existence leak).
 */
export async function revokeTeamInvite(
  params: {
    orgId: string;
    teamId: string;
    inviteId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    config: ClientConfig;
  },
  deps?: InviteDeps,
): Promise<{ ok: true }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const prisma = deps?.prisma ?? (getPrisma() as InvitePrisma);
  const now = deps?.now ? deps.now() : new Date();

  const { org, team } = await resolveInviteTarget({
    prisma,
    orgId: params.orgId,
    teamId: params.teamId,
    domain: params.domain,
  });

  const invite = await prisma.teamInvite.findFirst({
    where: { id: params.inviteId, orgId: org.id, teamId: team.id },
    select: TEAM_INVITE_SELECT,
  });
  if (!invite) {
    throw new AppError('NOT_FOUND', 404);
  }

  const allowed = await canRevokeInvite(prisma, {
    orgId: org.id,
    teamId: team.id,
    actorUserId,
    invitedByUserId: invite.invitedByUserId,
    config: params.config,
  });
  if (!allowed) {
    // Generic, matching the member-invite permission failures — no role oracle.
    throw new AppError('FORBIDDEN', 403);
  }

  if (invite.acceptedAt) {
    throw new AppError('BAD_REQUEST', 409, 'INVITATION_ALREADY_ACCEPTED');
  }
  if (invite.revokedAt || invite.declinedAt) {
    // Already unusable — idempotent success, and no second audit row claiming a second revocation.
    return { ok: true };
  }

  await prisma.teamInvite.update({
    where: { id: invite.id },
    data: { revokedAt: now, revokedReason: 'REVOKED' },
    select: { id: true },
  });
  // Consume any still-outstanding emailed tokens too (mirrors declineTeamInviteByToken); the
  // acceptance paths already refuse on `revokedAt`, so this is defence in depth, not the gate.
  await prisma.verificationToken.updateMany({
    where: { teamInviteId: invite.id, usedAt: null },
    data: { usedAt: now },
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'invite.revoked',
    targetType: 'invite',
    targetId: invite.id,
    metadata: { teamId: team.id },
  });

  return { ok: true };
}
