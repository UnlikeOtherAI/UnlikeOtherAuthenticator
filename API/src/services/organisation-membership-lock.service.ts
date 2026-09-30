import { Prisma, type PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { lockTeamOrganisationRow } from './team-scope.service.js';

/** Organisation writes take the container first, then membership rows in a stable order. */
export async function lockOrganisationMemberships(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  orgId: string,
  userIds: string[],
): Promise<void> {
  if (!(await lockTeamOrganisationRow(orgId, { prisma }))) {
    throw new AppError('NOT_FOUND', 404);
  }
  const ids = [...new Set(userIds)].sort();
  if (!ids.length) return;
  await prisma.$queryRaw(Prisma.sql`
    SELECT om.id FROM "org_members" om
    WHERE om."org_id" = ${orgId} AND om."user_id" IN (${Prisma.join(ids)})
    ORDER BY om."user_id" FOR UPDATE OF om
  `);
}

/** Ordinary membership operations cannot alter any owner, including legacy owner rows. */
export function assertMutableOrganisationMember(
  member: { role: string; userId: string },
  ownerId: string,
): void {
  if (member.role === 'owner' || member.userId === ownerId) {
    throw new AppError('BAD_REQUEST', 400, 'OWNER_PROTECTED');
  }
}
