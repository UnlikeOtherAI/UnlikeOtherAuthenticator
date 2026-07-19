import type { PrismaClient } from '@prisma/client';

import { AppError } from '../utils/errors.js';

type WorkspaceScopePrisma = Pick<
  PrismaClient,
  'organisation' | 'orgMember' | 'team' | 'teamMember'
>;

function rejectWorkspaceScope(): never {
  throw new AppError('UNAUTHORIZED', 401, 'AUTHENTICATION_FAILED');
}

/**
 * Require the exact selected organisation and team to belong to this client
 * domain and require ACTIVE membership at both levels. Lifecycle tombstones
 * are deliberately never treated as reusable membership.
 */
export async function assertActiveWorkspaceScope(
  params: {
    userId: string;
    domain: string;
    orgId?: string | null;
    teamId?: string | null;
  },
  deps: { prisma: WorkspaceScopePrisma },
): Promise<void> {
  const orgId = params.orgId ?? undefined;
  const teamId = params.teamId ?? undefined;
  if (!orgId && !teamId) return;
  if (!orgId || !teamId) rejectWorkspaceScope();

  const [orgMember, teamMember] = await Promise.all([
    deps.prisma.orgMember.findFirst({
      where: {
        orgId,
        userId: params.userId,
        status: 'ACTIVE',
        org: { domain: params.domain },
      },
      select: { id: true },
    }),
    deps.prisma.teamMember.findFirst({
      where: {
        teamId,
        userId: params.userId,
        status: 'ACTIVE',
        team: {
          orgId,
          org: { domain: params.domain },
        },
      },
      select: { id: true },
    }),
  ]);

  if (!orgMember || !teamMember) rejectWorkspaceScope();
}
