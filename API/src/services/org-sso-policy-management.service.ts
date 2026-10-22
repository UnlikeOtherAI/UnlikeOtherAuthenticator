import { GroupMapping } from './enterprise-group-mapping.service.js';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import { enterpriseReadiness } from './org-sso-policy.service.js';
import { getAdminPrisma } from '../db/prisma.js';
import { revokeEnterpriseScope } from './org-sso-revocation.service.js';
import type { managementSession } from './org-sso-management.service.js';
import { reconcileScimUsers } from './enterprise-scim-reconciliation.service.js';
import { withdrawConnectionMemberships } from './membership-provenance.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';

export const EnterprisePolicyPatch = z.object({ revision: z.number().int().nonnegative(),
  enforcement: z.enum(['off', 'required_for_verified_domains', 'required_for_all_members']).optional(),
  session_max_age_seconds: z.number().int().min(300).max(86400).optional(), reauth_mode: z.enum(['detect_only', 'force']).optional(),
  jit_enabled: z.boolean().optional(), default_team_id: z.string().min(1).max(100).nullable().optional(),
  allow_unverified_contractors: z.boolean().optional(), group_mappings: z.array(GroupMapping).max(100).optional(),
}).strict();

/** Called in the owner transaction after outbox-prefix, epoch and enterprise locks. */
export async function updateEnterprisePolicy(session: Awaited<ReturnType<typeof managementSession>>,
  input: z.infer<typeof EnterprisePolicyPatch>, tx: Prisma.TransactionClient) {
  const scope = { clientDomain: session.clientDomain, orgId: session.orgId };
  const prior = await tx.orgSsoPolicy.findUnique({ where: { clientDomain_orgId: scope } });
  if ((prior?.revision ?? 0) !== input.revision) throw new AppError('BAD_REQUEST', 409, 'SSO_REVISION_CONFLICT');
  if (input.enforcement && input.enforcement !== 'off') {
    const ready = await enterpriseReadiness(session.clientDomain, tx as ReturnType<typeof getAdminPrisma>, session.orgId);
    if (!ready.enforcement_allowed) throw new AppError('FORBIDDEN', 403, 'SSO_RECOVERY_NOT_READY');
    if (!await tx.orgSsoConnection.findFirst({ where: { ...scope, status: 'active' } })) {
      throw new AppError('FORBIDDEN', 403, 'SSO_ACTIVATION_NOT_READY');
    }
  }
  const ids = [...new Set([...(input.default_team_id ? [input.default_team_id] : []),
    ...(input.group_mappings ?? []).map((mapping) => mapping.team_id)])];
  if (ids.length && await tx.team.count({ where: { id: { in: ids }, orgId: session.orgId, lifecycleStatus: 'ACTIVE' } }) !== ids.length) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_TEAM_UNAVAILABLE');
  }
  const connectionIds = [...new Set((input.group_mappings ?? []).map(mapping => mapping.connection_id))];
  if (connectionIds.length && await tx.orgSsoConnection.count({ where: { ...scope, id: { in: connectionIds } } }) !== connectionIds.length) {
    throw new AppError('BAD_REQUEST', 400, 'SSO_CONNECTION_UNAVAILABLE');
  }
  const jit = input.jit_enabled ?? prior?.jitEnabled ?? false;
  const defaultTeam = input.default_team_id === undefined ? prior?.defaultTeamId : input.default_team_id;
  if (jit && !defaultTeam) throw new AppError('BAD_REQUEST', 400, 'SSO_DEFAULT_TEAM_REQUIRED');
  const securityChange = Object.keys(input).some((key) => key !== 'revision');
  const data = { ...(input.enforcement === undefined ? {} : { enforcement: input.enforcement }),
    ...(input.session_max_age_seconds === undefined ? {} : { sessionMaxAgeSeconds: input.session_max_age_seconds }),
    ...(input.reauth_mode === undefined ? {} : { reauthMode: input.reauth_mode }),
    ...(input.jit_enabled === undefined ? {} : { jitEnabled: input.jit_enabled }),
    ...(input.default_team_id === undefined ? {} : { defaultTeamId: input.default_team_id }),
    ...(input.allow_unverified_contractors === undefined ? {} : { allowUnverifiedContractors: input.allow_unverified_contractors }),
    ...(input.group_mappings === undefined ? {} : { groupMappings: input.group_mappings }) };
  const row = await tx.orgSsoPolicy.upsert({ where: { clientDomain_orgId: scope }, create: { ...scope, ...data },
    update: { ...data, revision: { increment: 1 }, ...(securityChange ? { generation: { increment: 1 } } : {}) } });
  if (input.group_mappings !== undefined || input.default_team_id !== undefined || input.jit_enabled !== undefined) {
    // Old signed group claims are not standing authority for new mappings. A fresh SSO login rebuilds that source.
    const sources = await tx.membershipContribution.findMany({ where: { ...scope, sourceKind: 'sso', active: true },
      distinct: ['userId', 'connectionId'], select: { userId: true, connectionId: true }, orderBy: { userId: 'asc' } });
    for (const source of sources) {
      if (!source.connectionId) throw new AppError('INTERNAL', 500, 'SSO_SOURCE_INVALID');
      await lockRefreshSessionUserDomain({ userId: source.userId, domain: session.clientDomain }, { prisma: tx });
      await lockTeamMembershipRows({ userId: source.userId, orgId: session.orgId }, { prisma: tx });
      await withdrawConnectionMemberships({ connectionId: source.connectionId, userId: source.userId, sourceKind: 'sso' }, tx);
    }
    // Provisioner resources remain standing scoped authority, but only after immutable owner reconciliation.
    const connections = await tx.orgSsoConnection.findMany({ where: { ...scope, status: { notIn: ['disabled', 'suspended'] } }, select: { id: true } });
    for (const connection of connections) {
      const resources = await tx.scimResourceLink.findMany({ where: { connectionId: connection.id, resourceType: 'Users',
        subjectBinding: { not: null } }, select: { id: true }, take: 10001 });
      if (resources.length > 10000) throw new AppError('BAD_REQUEST', 409, 'SCIM_RESOURCE_LIMIT');
      await reconcileScimUsers(connection.id, resources.map((resource) => resource.id), tx);
    }
  }
  if (securityChange) await revokeEnterpriseScope({ ...scope, scope: 'product_org', revision: row.generation }, tx);
  await tx.orgAuditLog.create({ data: { orgId: session.orgId, actorUserId: session.userId,
    action: 'sso.policy_updated', targetType: 'organisation', targetId: session.orgId,
    metadata: { revision: row.revision, generation: row.generation, enforcement: row.enforcement } } });
  return { ok: true, revision: row.revision };
}
