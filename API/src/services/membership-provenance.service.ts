import type { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { asPrismaClient } from '../db/tenant-context.js';
import { revokeEnterpriseOrganisation, revokeEnterpriseTeam } from './enterprise-authority-revocation.service.js';

export type ManagedMembershipGrant = { teamId: string | null; role: 'member' | 'admin'; resourceId: string };
function roleFor(roles: string[], org: boolean): string {
  const unique = [...new Set(roles)];
  if (org && unique.includes('owner')) return 'owner';
  const custom = unique.filter((role) => !['member', 'admin'].includes(role));
  if (custom.length > 1 || (custom.length && unique.includes('admin'))) {
    throw new AppError('FORBIDDEN', 403, 'SSO_ROLE_MERGE_REQUIRES_REVIEW');
  }
  return custom[0] ?? (unique.includes('admin') ? 'admin' : 'member');
}

/** Aggregate writes never become a new manual contribution or remove a manual tombstone. */
async function managedWrite<T>(tx: Prisma.TransactionClient, run: () => Promise<T>): Promise<T> {
  const prior = await tx.$queryRaw<Array<{ value: string | null }>>`SELECT current_setting('app.membership_write_source', true) AS value`;
  await tx.$executeRaw`SELECT set_config('app.membership_write_source', 'managed', true)`;
  try { return await run(); }
  finally { await tx.$executeRaw`SELECT set_config('app.membership_write_source', ${prior[0]?.value ?? ''}, true)`; }
}

/** Caller holds outbox prefix and the canonical user/org membership locks through commit. */
export async function reconcileEffectiveMembership(userId: string, orgId: string, tx: Prisma.TransactionClient) {
  const [org, contributions, suppressions, teams, oldOrg] = await Promise.all([
    tx.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { ownerId: true } }),
    tx.membershipContribution.findMany({ where: { orgId, userId, active: true } }),
    tx.membershipSuppression.findMany({ where: { orgId, userId } }),
    tx.teamMember.findMany({ where: { team: { orgId }, userId }, select: { teamId: true, status: true, teamRole: true } }),
    tx.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { status: true, role: true } }),
  ]);
  const blocked = new Set(suppressions.map((row) => row.scopeKey));
  const eligible = contributions.filter((row) => row.teamId === null || !blocked.has(row.teamId));
  const hasOrgAccess = !blocked.has('org') && eligible.length > 0;
  if (org.ownerId === userId && !hasOrgAccess) throw new AppError('FORBIDDEN', 403, 'SSO_MEMBERSHIP_SUPPRESSED');
  const orgRoles = contributions.filter((row) => row.teamId === null).map((row) => row.role);
  if (org.ownerId === userId) orgRoles.push('owner');
  await managedWrite(tx, async () => {
    if (hasOrgAccess || org.ownerId === userId) {
      await tx.orgMember.upsert({ where: { orgId_userId: { orgId, userId } },
        create: { orgId, userId, role: roleFor(orgRoles, true), status: 'ACTIVE' },
        update: { role: roleFor(orgRoles, true), status: 'ACTIVE' } });
    } else await tx.orgMember.updateMany({ where: { orgId, userId, role: { not: 'owner' } }, data: { status: 'DEACTIVATED' } });
    const teamIds = new Set([...teams.map((row) => row.teamId), ...contributions.flatMap((row) => row.teamId ? [row.teamId] : [])]);
    for (const teamId of [...teamIds].sort()) {
      const grants = contributions.filter((row) => row.teamId === teamId);
      if (hasOrgAccess && !blocked.has(teamId) && grants.length) {
        const team = await tx.team.findFirst({ where: { id: teamId, orgId, lifecycleStatus: 'ACTIVE' }, select: { id: true } });
        if (!team) throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_UNAVAILABLE');
        const role = roleFor(grants.map((row) => row.role), false);
        await tx.teamMember.upsert({ where: { teamId_userId: { teamId, userId } },
          create: { teamId, userId, teamRole: role, status: 'ACTIVE' }, update: { teamRole: role, status: 'ACTIVE' } });
      } else await tx.teamMember.updateMany({ where: { teamId, userId }, data: { status: 'DEACTIVATED' } });
    }
  });
  const nextOrg = await tx.orgMember.findUnique({ where: { orgId_userId: { orgId, userId } }, select: { status: true, role: true } });
  if (oldOrg?.status === 'ACTIVE' && (nextOrg?.status !== 'ACTIVE' || nextOrg.role !== oldOrg.role)) {
    await revokeEnterpriseOrganisation(asPrismaClient(tx), orgId, userId);
  } else {
    const nextTeams = await tx.teamMember.findMany({ where: { userId, team: { orgId } }, select: { teamId: true, status: true, teamRole: true } });
    for (const old of teams.filter((row) => row.status === 'ACTIVE')) {
      const next = nextTeams.find((row) => row.teamId === old.teamId);
      if (next?.status !== 'ACTIVE' || next.teamRole !== old.teamRole) await revokeEnterpriseTeam(asPrismaClient(tx), old.teamId, userId);
    }
  }
}

/** Replaces this one source only. Manual and other IdP/provisioning contributions survive. */
export async function replaceManagedMemberships(input: { userId: string; orgId: string; clientDomain: string;
  connectionId: string; sourceKind: 'sso' | 'scim'; sourceId: string; grants: ManagedMembershipGrant[];
}, tx: Prisma.TransactionClient) {
  if (!await tx.orgSsoConnection.findFirst({ where: { id: input.connectionId, clientDomain: input.clientDomain,
    orgId: input.orgId }, select: { id: true } })) throw new AppError('FORBIDDEN', 403, 'SSO_SOURCE_SCOPE_INVALID');
  if (await tx.membershipSuppression.findUnique({ where: { orgId_userId_scopeKey: {
    orgId: input.orgId, userId: input.userId, scopeKey: 'org' } } })) throw new AppError('FORBIDDEN', 403, 'SSO_MEMBERSHIP_SUPPRESSED');
  const source = { orgId: input.orgId, userId: input.userId, sourceKind: input.sourceKind, sourceId: input.sourceId };
  await tx.membershipContribution.updateMany({ where: { ...source, connectionId: input.connectionId }, data: { active: false } });
  const grouped = new Map<string, ManagedMembershipGrant[]>();
  for (const grant of input.grants) {
    const key = grant.teamId ?? 'org'; grouped.set(key, [...(grouped.get(key) ?? []), grant]);
  }
  for (const [scopeKey, grants] of grouped) {
    const grant = { teamId: grants[0].teamId, role: roleFor(grants.map((row) => row.role), scopeKey === 'org'),
      resourceIds: [...new Set(grants.map((row) => row.resourceId))].sort() };
    if (await tx.membershipSuppression.findUnique({ where: { orgId_userId_scopeKey: {
      orgId: input.orgId, userId: input.userId, scopeKey } } })) throw new AppError('FORBIDDEN', 403, 'SSO_MEMBERSHIP_SUPPRESSED');
    if (!grant.teamId && grant.role !== 'member') throw new AppError('FORBIDDEN', 403, 'SSO_OWNER_MAPPING_FORBIDDEN');
    if (grant.teamId && !await tx.team.findFirst({ where: { id: grant.teamId, orgId: input.orgId,
      lifecycleStatus: 'ACTIVE' }, select: { id: true } })) throw new AppError('FORBIDDEN', 403, 'SSO_TEAM_UNAVAILABLE');
    const existing = await tx.membershipContribution.findUnique({ where: { orgId_userId_scopeKey_sourceKind_sourceId: { ...source, scopeKey } } });
    if (existing && existing.connectionId !== input.connectionId) throw new AppError('FORBIDDEN', 403, 'SSO_SOURCE_SCOPE_INVALID');
    await tx.membershipContribution.upsert({ where: { orgId_userId_scopeKey_sourceKind_sourceId: { ...source, scopeKey } },
      create: { ...source, teamId: grant.teamId, scopeKey, clientDomain: input.clientDomain,
        connectionId: input.connectionId, role: grant.role, resourceIds: grant.resourceIds },
      update: { role: grant.role, resourceIds: grant.resourceIds, active: true } });
  }
  await reconcileEffectiveMembership(input.userId, input.orgId, tx);
}

export async function withdrawConnectionMemberships(input: { connectionId: string; userId?: string; sourceKind?: 'sso' | 'scim'; sourceId?: string },
  tx: Prisma.TransactionClient) {
  const where = { connectionId: input.connectionId, ...(input.userId ? { userId: input.userId } : {}),
    ...(input.sourceKind ? { sourceKind: input.sourceKind } : {}), ...(input.sourceId ? { sourceId: input.sourceId } : {}) };
  const affected = await tx.membershipContribution.findMany({ where, distinct: ['userId', 'orgId'], select: { userId: true, orgId: true } });
  await tx.membershipContribution.updateMany({ where, data: { active: false } });
  for (const row of affected) await reconcileEffectiveMembership(row.userId, row.orgId, tx);
}
