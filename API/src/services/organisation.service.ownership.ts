import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { OWNER_ROLE, resolveDemotedOwnerRole } from './role-grants.js';
import { lockOrganisationMemberships } from './organisation-membership-lock.service.js';

import {
  assertDatabaseEnabled,
  auditOrg,
  ensureOrgRole,
  getOrganisationMember,
  parseOrgFeatureRoles,
  resolveOrgActor,
  resolveOrganisation,
  toOrganisationRecord,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type OrganisationRecord,
} from './organisation.service.base.js';

// Ownership transfer, split out of organisation.service.members.ts (which had reached the project's
// 500-line limit). It is the one operation in that file that mutates the ORGANISATION rather than a
// roster row, and the only one gated on being `Organisation.ownerId` rather than on a capability.

/**
 * The role the outgoing owner is left holding, validated against this domain's vocabulary.
 *
 * A caller may name it; otherwise `resolveDemotedOwnerRole` picks. Either way the result is a role
 * `org_roles` contains, because a demotion is a membership write like any other — see
 * `changeOrganisationMemberRole`, which validates the same way. Writing an unvalidated string here
 * (as this path did with a literal `'admin'`) produces a member holding a role their own domain
 * cannot name, grant capabilities to, or change through any validated path.
 */
function resolveOutgoingOwnerRole(config: ClientConfig, requested: string | undefined): string {
  const role = requested?.trim();

  if (role) {
    ensureOrgRole(role, parseOrgFeatureRoles(config));
    // The endpoint's contract is a demotion (brief §24.3 step 4). Naming `owner` would move
    // `ownerId` while leaving the outgoing owner structurally holding every capability — a
    // transfer that does not transfer.
    if (role === OWNER_ROLE) throw new AppError('BAD_REQUEST', 400, 'INVALID_PREVIOUS_OWNER_ROLE');
    return role;
  }

  const fallback = resolveDemotedOwnerRole(config);
  // Only reachable when the domain configured `org_roles: ["owner"]`: there is no role to demote
  // into, so the transfer fails closed instead of writing one this config would reject back.
  if (!fallback) throw new AppError('BAD_REQUEST', 400, 'NO_DEMOTED_OWNER_ROLE');
  return fallback;
}

export async function transferOrganisationOwnership(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    newOwnerId: string;
    previousOwnerRole?: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const newOwnerId = params.newOwnerId.trim();
  if (!newOwnerId) throw new AppError('BAD_REQUEST', 400);

  // Resolved before any write: a vocabulary that cannot express the demotion must not leave the
  // organisation half-transferred.
  const outgoingOwnerRole = resolveOutgoingOwnerRole(params.config, params.previousOwnerRole);

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });
  const { organisation, demoted, outgoingOwnerId } = await runInTransaction(prisma, async (tx) => {
    // Container lock precedes every membership lock, including organisation deletion.
    // The canonical owner and both memberships are read again only after these locks.
    await lockOrganisationMemberships(tx, org.id, [org.ownerId, newOwnerId]);
    const currentOrg = await resolveOrganisation(tx, { orgId: org.id });
    if (currentOrg.ownerId !== org.ownerId || (actorUserId && currentOrg.ownerId !== actorUserId)) {
      throw new AppError('FORBIDDEN', 403);
    }
    const outgoingOwnerId = currentOrg.ownerId;
    if (outgoingOwnerId === newOwnerId) throw new AppError('BAD_REQUEST', 400);
    const oldOwnerMembership = await getOrganisationMember(
      tx, { orgId: org.id, userId: outgoingOwnerId }, { activeOnly: true },
    );
    // Trusted backend recovery can repair an absent outgoing membership. A person cannot
    // exercise ownership without ACTIVE standing, even if ownerId still names them.
    if (actorUserId && oldOwnerMembership?.role !== OWNER_ROLE) {
      throw new AppError('FORBIDDEN', 403);
    }
    const newOwnerMembership = await getOrganisationMember(
      tx, { orgId: org.id, userId: newOwnerId }, { activeOnly: true },
    );
    if (!newOwnerMembership) throw new AppError('NOT_FOUND', 404);
    const moved = await tx.organisation.updateMany({
      where: { id: org.id, ownerId: outgoingOwnerId }, data: { ownerId: newOwnerId },
    });
    if (moved.count !== 1) throw new AppError('FORBIDDEN', 403);
    await tx.orgMember.update({ where: { id: newOwnerMembership.id }, data: { role: OWNER_ROLE } });
    if (oldOwnerMembership) {
      await tx.orgMember.update({ where: { id: oldOwnerMembership.id }, data: { role: outgoingOwnerRole } });
    }

    const updated = await tx.organisation.findUniqueOrThrow({
      where: { id: org.id },
      select: {
        id: true,
        domain: true,
        name: true,
        slug: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return { organisation: updated, demoted: Boolean(oldOwnerMembership), outgoingOwnerId };
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'org.ownership_transferred',
    targetType: 'organisation',
    targetId: org.id,
    // `previousOwnerRole` records the role actually written. An owner with no membership row is
    // not demoted at all, and the audit entry must not claim a role change that never happened.
    metadata: demoted
      ? { newOwnerId, previousOwnerId: outgoingOwnerId, previousOwnerRole: outgoingOwnerRole }
      : { newOwnerId, previousOwnerId: outgoingOwnerId },
  });

  return toOrganisationRecord(organisation);
}
