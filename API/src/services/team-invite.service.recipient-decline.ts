import type { Prisma } from '@prisma/client';
import type { ClientConfig } from './config.service.js';
import { AppError } from '../utils/errors.js';
import { assertEntryTeam } from './entry-team-interface.service.js';
import { declineTeamInviteForUser } from './team-invite.service.acceptance.js';
import { isExpired } from './team-invite-state-machine.js';

export async function declineRecipientTeamInvite(
  tx: Prisma.TransactionClient,
  input: { orgId: string; teamId: string; inviteId: string; userId: string; config: ClientConfig },
): Promise<void> {
  const { orgId, teamId, inviteId, userId, config } = input;
  await tx.$queryRaw`SELECT id FROM team_invites
    WHERE id=${inviteId} AND org_id=${orgId} AND team_id=${teamId} FOR UPDATE`;
  const invite = await tx.teamInvite.findFirst({
    where: { id: inviteId, orgId, teamId },
    select: { orgId: true, teamId: true, declinedAt: true, acceptedAt: true, revokedAt: true, approvalStatus: true, expiresAt: true },
  });
  const now = new Date();
  if (!invite || (!invite.declinedAt && (isExpired(invite, now) || invite.approvalStatus === 'PENDING'))) {
    throw new AppError('BAD_REQUEST', 400);
  }
  await assertEntryTeam(config, invite, tx);
  await declineTeamInviteForUser({ prisma: tx, teamInviteId: inviteId, userId, config, now });
  await tx.verificationToken.updateMany({
    where: { teamInviteId: inviteId, usedAt: null }, data: { usedAt: now },
  });
}
