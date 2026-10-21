import type { PrismaClient } from '@prisma/client';
import { getAdminPrisma } from '../db/prisma.js';

/** Read only opted-in verified contact data for two live members of the exact team. */
export async function teamTelephoneNumbers(params: {
  orgId: string; teamId: string; actorUserId?: string; userIds: string[];
}, deps: { prisma?: Pick<PrismaClient, 'userTelephone'> } = {}): Promise<Map<string, string>> {
  if (!params.actorUserId || !params.userIds.length) return new Map();
  const actor = { userId: params.actorUserId, status: 'ACTIVE' as const, user: { lifecycleStatus: 'ACTIVE' as const } };
  const rows = await (deps.prisma ?? getAdminPrisma()).userTelephone.findMany({
    where: { userId: { in: params.userIds }, visibility: 'team', number: { not: null }, verifiedAt: { not: null },
      user: { lifecycleStatus: 'ACTIVE',
        orgMembers: { some: { orgId: params.orgId, status: 'ACTIVE',
          org: { lifecycleStatus: 'ACTIVE', members: { some: actor } } } },
        teamMembers: { some: { teamId: params.teamId, status: 'ACTIVE',
          team: { orgId: params.orgId, lifecycleStatus: 'ACTIVE', members: { some: actor } } } },
      },
    },
    select: { userId: true, number: true },
  });
  return new Map(rows.flatMap(row => row.number ? [[row.userId, row.number] as const] : []));
}
