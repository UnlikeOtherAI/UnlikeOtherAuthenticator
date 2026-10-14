import { Prisma, type PrismaClient, type LifecycleScope } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { lockProductTeamPolicyShared } from './product-team-policy-lock.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import {
  lockDirectoryMutationUsers,
  userDirectoryOrganisations,
} from './directory-user-mutation.service.js';
import { withDirectoryMutation, type DirectoryChange } from './directory-mutation.service.js';

/** Exact prior provenance is needed after memberships are physically removed.
 * ERASE additionally scrubs prior outbox subject references by indexed lookup.
 */
export async function userErasureDirectoryOrganisations(
  tx: PrismaClient,
  userId: string,
  erase: boolean,
) {
  const current = await userDirectoryOrganisations(tx, userId);
  const historical = await tx.historicalOrganisationIdentityReference.findMany({
    where: { userId },
    select: { orgId: true },
  });
  const previous = erase
    ? await tx.$queryRaw<Array<{ orgId: string }>>(Prisma.sql`
    SELECT DISTINCT org_id AS "orgId" FROM directory_change_outbox WHERE subject_id=${userId}`)
    : [];
  const identity = await tx.user.findUnique({ where: { id: userId }, select: { email: true } });
  const policy = identity?.email
    ? await tx.$queryRaw<Array<{ orgId: string }>>(Prisma.sql`
    SELECT id AS "orgId" FROM organisations
    WHERE EXISTS (SELECT 1 FROM unnest(allowed_emails) AS entry WHERE lower(entry)=lower(${identity.email}))
    UNION SELECT org_id AS "orgId" FROM teams
    WHERE EXISTS (SELECT 1 FROM unnest(allowed_emails) AS entry WHERE lower(entry)=lower(${identity.email}))`)
    : [];
  return [
    ...new Set([
      ...current,
      ...historical.map((row) => row.orgId),
      ...previous.map((row) => row.orgId),
      ...policy.map((row) => row.orgId),
    ]),
  ].sort();
}

export async function withDirectoryLifecycleMutation<T>(
  tx: PrismaClient,
  input: {
    scope: LifecycleScope;
    id: string;
    deleted?: boolean;
    eraseReference?: boolean;
    orgId?: string;
    pinAllMembers?: boolean;
    additionalOrgIds?: readonly string[];
  },
  write: (tx: PrismaClient) => Promise<T>,
) {
  // Callers acquire an exclusive policy fence before pinAllMembers. It freezes
  // admission while the complete member-user set is resolved and locked.
  await lockProductTeamPolicyShared(tx);
  let orgIds: string[];
  if (input.scope === 'USER') {
    await lockRefreshSessionUser(input.id, { prisma: tx });
    orgIds = input.deleted
      ? await userErasureDirectoryOrganisations(tx, input.id, input.eraseReference === true)
      : await userDirectoryOrganisations(tx, input.id);
  } else {
    const orgId =
      input.scope === 'ORGANISATION'
        ? input.id
        : (input.orgId ??
          (await tx.team.findUnique({ where: { id: input.id }, select: { orgId: true } }))?.orgId);
    if (!orgId) throw new AppError('NOT_FOUND', 404);
    orgIds = [orgId];
    if (input.pinAllMembers) {
      const memberships =
        input.scope === 'TEAM'
          ? await tx.teamMember.findMany({ where: { teamId: input.id }, select: { userId: true } })
          : [
              ...(await tx.orgMember.findMany({ where: { orgId }, select: { userId: true } })),
              ...(await tx.teamMember.findMany({
                where: { team: { orgId } },
                select: { userId: true },
              })),
            ];
      const users = memberships.map((row) => row.userId);
      await lockDirectoryMutationUsers(tx, users, users);
    }
  }
  const kind: DirectoryChange['kind'] =
    input.scope === 'USER'
      ? 'membership.changed'
      : input.scope === 'TEAM'
        ? input.deleted
          ? 'team.deleted'
          : 'team.changed'
        : input.deleted
          ? 'organisation.deleted'
          : 'organisation.changed';
  // Retained/erased history still needs locking and scrubbing, but a deleted
  // or physically absent org must never gain a newly opened legacy stream.
  const eventOrgIds =
    input.scope === 'USER'
      ? (
          await tx.organisation.findMany({
            where: { id: { in: orgIds }, lifecycleStatus: { not: 'DELETED' } },
            select: { id: true },
          })
        ).map((org) => org.id)
      : orgIds;
  const changes = eventOrgIds.map((orgId) => ({
    orgId,
    kind,
    ...(input.scope === 'USER' && !input.deleted && !input.eraseReference
      ? { subjectId: input.id }
      : {}),
    ...(input.scope === 'TEAM' ? { teamId: input.id } : {}),
  }));
  return withDirectoryMutation(tx, changes, write, [...orgIds, ...(input.additionalOrgIds ?? [])]);
}
