import type { PrismaClient } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { runInTransaction } from '../db/tenant-context.js';
import { readTargetDisplay } from './profile-display.service.js';
import { authorizeDirectoryRead } from './directory-credential.service.js';
import { lockRefreshSessionUserShared } from './refresh-session-lock.service.js';

type Input = { authorization?: string; orgId: string; userId: string };
/** Direct live standing, not a login credential or a mirrored membership store. */
export async function readDirectoryStanding(input: Input, prisma: PrismaClient) {
  return runInTransaction(prisma, async tx => {
    await authorizeDirectoryRead({ ...input, permission: 'MEMBERSHIP_READ' }, tx);
    await lockRefreshSessionUserShared(input.userId, { prisma: tx });
    await authorizeDirectoryRead({ ...input, permission: 'MEMBERSHIP_READ' }, tx);
    const member = await tx.orgMember.findUnique({ where: { orgId_userId: { orgId: input.orgId, userId: input.userId } },
      select: { status: true, role: true, org: { select: { lifecycleStatus: true } },
        user: { select: { lifecycleStatus: true, tokenVersion: true } } } });
    const base = { subject: input.userId, organisation_id: input.orgId };
    if (!member || member.status !== 'ACTIVE' || member.org.lifecycleStatus !== 'ACTIVE' || member.user.lifecycleStatus !== 'ACTIVE') return { ...base, active: false as const };
    const teams = await tx.teamMember.findMany({ where: { userId: input.userId, status: 'ACTIVE',
      team: { orgId: input.orgId, lifecycleStatus: 'ACTIVE' } }, select: { teamId: true, teamRole: true }, orderBy: { teamId: 'asc' }, take: 201 });
    if (teams.length > 200) throw new AppError('SERVICE_UNAVAILABLE', 503, 'DIRECTORY_RESULT_TOO_LARGE');
    return { ...base, active: true as const, credential_epoch: member.user.tokenVersion, org_role: member.role,
      teams: teams.map(team => ({ id: team.teamId, role: team.teamRole })) };
  });
}

export async function readDirectoryDisplay(input: Input, prisma: PrismaClient) {
  return runInTransaction(prisma, async tx => {
    await authorizeDirectoryRead({ ...input, permission: 'DISPLAY_READ' }, tx);
    return readTargetDisplay(tx, { orgId: input.orgId, userId: input.userId });
  });
}
