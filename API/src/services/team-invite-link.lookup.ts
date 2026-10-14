import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

type InviteLinkLookupPrisma = {
  teamInviteLink: Pick<PrismaClient['teamInviteLink'], 'findUnique'>;
  team: Pick<PrismaClient['team'], 'findFirst'>;
};

type InviteLinkLookup = {
  id: string;
  orgId: string;
  teamId: string;
  roleToAssign: string;
  maxUses: number;
  useCount: number;
  revokedAt: Date | null;
  expiresAt: Date;
};

/**
 * Shared validity lookup for both the landing check (Task 4) and redemption (Task 2). Every
 * failure — unknown token, revoked, expired, over-cap, a dangling or HIDDEN team — throws the
 * SAME generic error so there is no oracle on which specific condition failed.
 */
export async function findValidInviteLink(
  prisma: InviteLinkLookupPrisma,
  params: { tokenHash: string; now: Date },
): Promise<{ link: InviteLinkLookup; team: { id: string; orgId: string; orgDomain: string } }> {
  const link = await prisma.teamInviteLink.findUnique({
    where: { tokenHash: params.tokenHash },
    select: {
      id: true,
      orgId: true,
      teamId: true,
      roleToAssign: true,
      maxUses: true,
      useCount: true,
      revokedAt: true,
      expiresAt: true,
    },
  });
  if (!link) throw new AppError('BAD_REQUEST', 400);
  if (link.revokedAt) throw new AppError('BAD_REQUEST', 400);
  if (link.expiresAt.getTime() <= params.now.getTime()) throw new AppError('BAD_REQUEST', 400);
  if (link.useCount >= link.maxUses) throw new AppError('BAD_REQUEST', 400);

  // Looked up by the ids the link carries, not by the redeeming product's domain: one organisation
  // is usable from every UOA-integrated product, and the link is already a bearer credential
  // scoped to one team. The org's ORIGIN domain comes back because the caller's next checks bind
  // the invitation and its accepted membership to that tenant, not to who is redeeming.
  const team = await prisma.team.findFirst({
    where: { id: link.teamId, orgId: link.orgId },
    select: { id: true, orgId: true, joinPolicy: true, org: { select: { domain: true } } },
  });
  if (!team) throw new AppError('BAD_REQUEST', 400);
  if (team.joinPolicy === 'HIDDEN') throw new AppError('BAD_REQUEST', 400);

  return { link, team: { id: team.id, orgId: team.orgId, orgDomain: team.org.domain } };
}
