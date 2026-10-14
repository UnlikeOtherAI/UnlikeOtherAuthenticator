import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import type { PrismaClient } from '@prisma/client';
import { runInTransaction } from '../db/tenant-context.js';
import {
  lockRefreshSessionUser,
  lockRefreshSessionUserShared,
} from './refresh-session-lock.service.js';
import {
  withDirectoryMutation,
  directoryNewOrganisationId,
  type DirectoryChange,
} from './directory-mutation.service.js';

/** Resolve current affected org references under the canonical user lock.
 * Admission takes the shared form, preventing a new membership appearing
 * between scope discovery and an exclusive profile/epoch mutation.
 */
export async function userDirectoryOrganisations(
  tx: PrismaClient,
  userId: string,
): Promise<string[]> {
  const memberships = await tx.orgMember.findMany({ where: { userId }, select: { orgId: true } });
  const owned = await tx.organisation.findMany({
    where: { ownerId: userId },
    select: { id: true },
  });
  return [
    ...new Set([...memberships.map((row) => row.orgId), ...owned.map((row) => row.id)]),
  ].sort();
}

export function withDirectoryUserMutation<T>(
  prisma: PrismaClient,
  userId: string,
  kind: Extract<
    DirectoryChange['kind'],
    'profile.changed' | 'credential_epoch.changed' | 'membership.changed'
  >,
  write: (tx: PrismaClient) => Promise<T>,
  plan: { additionalOrgIds?: readonly string[]; mayCreateOrganisation?: boolean } = {},
) {
  return runInTransaction(prisma, async (tx) => {
    await lockProductTeamPolicyShared(tx);
    await lockRefreshSessionUser(userId, { prisma: tx });
    const orgIds = await userDirectoryOrganisations(tx, userId);
    const declared = [
      ...orgIds,
      ...(plan.additionalOrgIds ?? []),
      ...(plan.mayCreateOrganisation ? [directoryNewOrganisationId(tx)] : []),
    ];
    return withDirectoryMutation(
      tx,
      orgIds.map((orgId) => ({ orgId, kind, subjectId: userId })),
      write,
      declared,
    );
  });
}

/** Pin every user row an operation may lock, in one stable global order. */
export async function lockDirectoryMutationUsers(
  tx: PrismaClient,
  userIds: readonly (string | null | undefined)[],
  exclusive: readonly string[] = [],
) {
  const ids = [
    ...new Set(userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ].sort();
  for (const userId of ids) {
    await (exclusive.includes(userId) ? lockRefreshSessionUser : lockRefreshSessionUserShared)(
      userId,
      { prisma: tx },
    );
  }
}

export function withDirectoryMembershipMutation<T>(
  prisma: PrismaClient,
  userIds: readonly (string | null | undefined)[],
  changes: readonly DirectoryChange[],
  write: (tx: PrismaClient) => Promise<T>,
) {
  return runInTransaction(prisma, async (tx) => {
    await lockProductTeamPolicyShared(tx);
    await lockDirectoryMutationUsers(tx, userIds);
    return withDirectoryMutation(tx, changes, write);
  });
}
