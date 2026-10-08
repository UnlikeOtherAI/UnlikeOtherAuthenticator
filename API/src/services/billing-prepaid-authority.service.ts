import { MembershipStatus, Prisma } from '@prisma/client';

import { AppError } from '../utils/errors.js';
import { isAuthenticationEpochMismatchError, lockAndAssertAuthenticationEpoch } from
  './authentication-epoch.service.js';

export async function lockAndAssertPrepaidEpoch(input: {
  userId: string; identityDomain: string; tokenVersion: number;
}, tx: Prisma.TransactionClient): Promise<void> {
  try {
    await lockAndAssertAuthenticationEpoch({ userId: input.userId,
      domain: input.identityDomain, credentialEpoch: input.tokenVersion }, { prisma: tx });
  } catch (error) {
    if (isAuthenticationEpochMismatchError(error)) {
      throw new AppError('FORBIDDEN', 403, 'PREPAID_SUBJECT_NOT_ENTITLED');
    }
    throw error;
  }
}

export async function assertActivePrepaidSubject(
  tx: Prisma.TransactionClient,
  input: { userId: string; organisationId: string; teamId: string },
  tokenVersion: number,
): Promise<void> {
  // Admission serializes against token-epoch and membership revocation writers.
  // Every reserve, including an idempotent replay, reacquires these row locks.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${input.userId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM organisations WHERE id = ${input.organisationId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM org_members
    WHERE org_id = ${input.organisationId} AND user_id = ${input.userId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM teams WHERE id = ${input.teamId} FOR SHARE`);
  await tx.$queryRaw(Prisma.sql`SELECT id FROM team_members
    WHERE team_id = ${input.teamId} AND user_id = ${input.userId} FOR SHARE`);
  const [user, orgMember, team] = await Promise.all([
    tx.user.findUnique({ where: { id: input.userId },
      select: { id: true, lifecycleStatus: true, tokenVersion: true } }),
    tx.orgMember.findUnique({ where: { orgId_userId: {
      orgId: input.organisationId, userId: input.userId } }, select: { status: true } }),
    tx.team.findFirst({ where: { id: input.teamId, orgId: input.organisationId,
      lifecycleStatus: 'ACTIVE', org: { lifecycleStatus: 'ACTIVE' },
      members: { some: { userId: input.userId, status: MembershipStatus.ACTIVE } } },
    select: { id: true } }),
  ]);
  if (!user || user.lifecycleStatus !== 'ACTIVE' || user.tokenVersion !== tokenVersion ||
    orgMember?.status !== MembershipStatus.ACTIVE || !team) {
    throw new AppError('FORBIDDEN', 403, 'PREPAID_SUBJECT_NOT_ENTITLED');
  }
}
