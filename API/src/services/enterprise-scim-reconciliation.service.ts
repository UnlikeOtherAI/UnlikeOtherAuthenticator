import type { Prisma, ScimResourceLink } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { connectionGroupMappings } from './enterprise-group-mapping.service.js';
import { replaceManagedMemberships, withdrawConnectionMemberships, type ManagedMembershipGrant } from './membership-provenance.service.js';
import { parseScimAttributes } from './enterprise-scim-protocol.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';

export async function validateScimMembers(connectionId: string, raw: unknown, tx: Prisma.TransactionClient) {
  const attrs = parseScimAttributes(raw);
  const ids = [...new Set((attrs.members ?? []).map((member) => member.value))];
  if (ids.length && await tx.scimResourceLink.count({ where: { id: { in: ids }, connectionId,
    resourceType: 'Users', deletedAt: null } }) !== ids.length) throw new AppError('BAD_REQUEST', 400, 'SCIM_INVALID_MEMBER');
}

async function withdrawUser(row: ScimResourceLink, tx: Prisma.TransactionClient) {
  if (!row.userId || !row.subjectBinding) return;
  await withdrawConnectionMemberships({ connectionId: row.connectionId, userId: row.userId, sourceKind: 'scim', sourceId: row.id }, tx);
  await withdrawConnectionMemberships({ connectionId: row.connectionId, userId: row.userId, sourceKind: 'sso', sourceId: row.subjectBinding }, tx);
}

/** Caller holds outbox prefix, product and connection locks. Each immutable user source is replaced independently. */
export async function reconcileScimUsers(connectionId: string, resourceIds: string[], tx: Prisma.TransactionClient) {
  if (!resourceIds.length) return;
  const users = await tx.scimResourceLink.findMany({ where: { connectionId, resourceType: 'Users', id: { in: [...new Set(resourceIds)] },
    userId: { not: null }, subjectBinding: { not: null } }, orderBy: [{ userId: 'asc' }, { id: 'asc' }] });
  const connection = await tx.orgSsoConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const policy = await tx.orgSsoPolicy.findUniqueOrThrow({ where: { clientDomain_orgId: { clientDomain: connection.clientDomain, orgId: connection.orgId } } });
  const groups = await tx.scimResourceLink.findMany({ where: { connectionId, resourceType: 'Groups', active: true, deletedAt: null }, take: 1001 });
  if (groups.length > 1000) throw new AppError('BAD_REQUEST', 409, 'SCIM_GROUP_LIMIT');
  const mappings = connectionGroupMappings(policy.groupMappings, connectionId);
  for (const row of users) {
    if (!row.userId || !row.subjectBinding) throw new AppError('INTERNAL', 500, 'SCIM_RECONCILIATION_REQUIRED');
    const userId = row.userId;
    await lockRefreshSessionUserDomain({ userId, domain: row.clientDomain }, { prisma: tx });
    await lockTeamMembershipRows({ userId, orgId: row.orgId }, { prisma: tx });
    const [person, identity, suppressions] = await Promise.all([
      tx.user.findUnique({ where: { id: userId }, select: { lifecycleStatus: true } }),
      tx.externalIdentity.findFirst({ where: { id: row.subjectBinding, connectionId, userId, orgId: row.orgId } }),
      tx.membershipSuppression.findMany({ where: { userId, orgId: row.orgId }, select: { scopeKey: true } }),
    ]);
    const blocked = new Set(suppressions.map((suppression) => suppression.scopeKey));
    if (!row.active || row.deletedAt || person?.lifecycleStatus !== 'ACTIVE' || identity?.status !== 'ACTIVE' || blocked.has('org')) {
      await withdrawUser(row, tx);
      await revokeEnterpriseScope({ scope: 'connection', clientDomain: row.clientDomain, orgId: row.orgId,
        connectionId, userId, revision: row.version }, tx);
      continue;
    }
    const grants: ManagedMembershipGrant[] = [{ teamId: null, role: 'member', resourceId: row.id }];
    if (policy.defaultTeamId && !blocked.has(policy.defaultTeamId)) grants.push({ teamId: policy.defaultTeamId, role: 'member', resourceId: 'default' });
    for (const group of groups) {
      if (!(parseScimAttributes(group.attributes).members ?? []).some((member) => member.value === row.id)) continue;
      for (const mapping of mappings.filter((entry) => entry.external_group_id === (group.externalId ?? group.id))) {
        if (!blocked.has(mapping.team_id)) grants.push({ teamId: mapping.team_id, role: mapping.team_role, resourceId: group.id });
      }
    }
    await replaceManagedMemberships({ userId, orgId: row.orgId, clientDomain: row.clientDomain,
      connectionId, sourceKind: 'scim', sourceId: row.id, grants }, tx);
  }
}

/** Exact owner-authorized stable-identity reconciliation. Names and email never select a UOA person. */
export async function reconcileScimResource(input: { connectionId: string; resourceId: string; externalIdentityId: string;
  version: number; actorUserId: string }, tx: Prisma.TransactionClient) {
  const row = await tx.scimResourceLink.findFirst({ where: { id: input.resourceId, connectionId: input.connectionId,
    resourceType: 'Users', deletedAt: null } });
  const identity = await tx.externalIdentity.findFirst({ where: { id: input.externalIdentityId, connectionId: input.connectionId, status: 'ACTIVE' } });
  if (!row || !identity || row.version !== input.version || identity.orgId !== row.orgId || identity.clientDomain !== row.clientDomain ||
    (row.subjectBinding && (row.subjectBinding !== identity.id || row.userId !== identity.userId))) {
    throw new AppError('BAD_REQUEST', 409, 'SCIM_RECONCILIATION_REQUIRED');
  }
  const existing = await tx.scimResourceLink.findFirst({ where: { connectionId: row.connectionId, resourceType: 'Users',
    subjectBinding: identity.id, id: { not: row.id } }, select: { id: true } });
  if (existing) throw new AppError('BAD_REQUEST', 409, 'SCIM_RECONCILIATION_REQUIRED');
  await tx.scimResourceLink.update({ where: { id: row.id }, data: { subjectBinding: identity.id, userId: identity.userId,
    version: { increment: 1 } } });
  await reconcileScimUsers(row.connectionId, [row.id], tx);
  await tx.orgAuditLog.create({ data: { orgId: row.orgId, actorUserId: input.actorUserId, action: 'scim.identity_reconciled',
    targetType: 'user', targetId: identity.userId, metadata: { connection_id: row.connectionId, resource_id: row.id, external_identity_id: identity.id } } });
  return { ok: true };
}
