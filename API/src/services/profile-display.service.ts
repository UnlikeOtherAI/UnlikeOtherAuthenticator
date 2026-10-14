import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';

/** Single policy for both interactive and explicitly granted background displays.
 * Caller proves its own authority first; this helper proves exact target provenance. */
export async function readTargetDisplay(tx: PrismaClient, target: { orgId: string; userId: string }) {
  const org = await tx.organisation.findUnique({ where: { id: target.orgId }, select: { lifecycleStatus: true } });
  if (org?.lifecycleStatus !== 'ACTIVE') throw new AppError('NOT_FOUND', 404);
  const member = await tx.orgMember.findUnique({ where: { orgId_userId: target },
    select: { status: true, user: { select: { id: true, name: true, lifecycleStatus: true } } } });
  if (member) {
    if (member.user.lifecycleStatus === 'DELETED') return { id: target.userId, deleted: true, name: 'Deleted user' };
    if (member.status !== 'ACTIVE' || member.user.lifecycleStatus !== 'ACTIVE') return { id: target.userId, deleted: false, name: member.status === 'REMOVED' ? 'Former member' : 'Unavailable member' };
    return { id: target.userId, deleted: false, name: member.user.name, showAvatar: true };
  }
  const retained = await tx.historicalOrganisationIdentityReference.findUnique({ where: { userId_orgId: target },
    select: { user: { select: { lifecycleStatus: true } } } });
  if (retained?.user.lifecycleStatus === 'DELETED') return { id: target.userId, deleted: true, name: 'Deleted user' };
  throw new AppError('NOT_FOUND', 404);
}
