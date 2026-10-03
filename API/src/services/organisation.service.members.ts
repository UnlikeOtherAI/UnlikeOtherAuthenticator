import type { ClientConfig } from './config.service.js';
import { getEnv } from '../config/env.js';
import { getAdminPrisma, getPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import {
  revokeRefreshTokenFamiliesForUserOrganisation,
  revokeRefreshTokensForUserDomain,
} from './refresh-token-revocation.service.js';
import { lockRefreshSessionUserDomain } from './refresh-session-lock.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import {
  assertMutableOrganisationMember,
  lockOrganisationMemberships,
} from './organisation-membership-lock.service.js';

import {
  assertDatabaseEnabled,
  auditOrg,
  ensureOrgRole,
  getOrganisationMember,
  parseOrgFeatureRoles,
  parseOrgLimit,
  requireOrgCapability,
  resolveOrgActor,
  resolveOrganisation,
  toMemberRecord,
  type OrgActorProvenance,
  type OrgServiceDeps,
  type OrgServicePrisma,
  type OrganisationMemberRecord,
} from './organisation.service.base.js';

const MEMBER_SELECT = {
  id: true,
  orgId: true,
  userId: true,
  role: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} as const;

export { listOrganisationMembers } from './organisation.service.roster.js';

export async function addOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    role: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  const role = params.role.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  const maxMembers = parseOrgLimit(params.config);
  const orgRoles = parseOrgFeatureRoles(params.config);
  ensureOrgRole(role, orgRoles);
  if (role === 'owner') throw new AppError('BAD_REQUEST', 400, 'OWNER_ROLE_RESERVED');

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  const { member: createdMember, reactivated } = await runInTransaction(prisma, async (tx) => {
    await lockOrganisationMemberships(tx, org.id, [userId, ...(actorUserId ? [actorUserId] : [])]);
    if (actorUserId) {
      const actorMembership = await getOrganisationMember(tx, { orgId: org.id, userId: actorUserId }, { activeOnly: true });
      requireOrgCapability(params.config, 'members.manage', actorMembership?.role);
    }
    await lockTeamMembershipRows({ userId, orgId: org.id }, { prisma: tx });
    // Include the status so a prior DEACTIVATED/REMOVED row can be reactivated instead of
    // rejected (design §4.1: statuses are tombstones, re-adding flips them back to ACTIVE).
    const existingMemberInOrg = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId },
      select: { id: true, status: true, role: true, userId: true },
    });
    if (existingMemberInOrg) assertMutableOrganisationMember(existingMemberInOrg, org.ownerId);
    if (existingMemberInOrg && existingMemberInOrg.status === 'ACTIVE') {
      throw new AppError('BAD_REQUEST', 400);
    }

    const memberCount = await tx.orgMember.count({ where: { orgId: org.id, status: 'ACTIVE' } });
    if (memberCount >= maxMembers) throw new AppError('BAD_REQUEST', 400);

    const targetUser = await tx.user.findUnique({
      where: { lifecycleStatus: 'ACTIVE', id: userId },
      select: { id: true, domain: true },
    });
    if (!targetUser) throw new AppError('BAD_REQUEST', 400);
    if (targetUser.domain && targetUser.domain !== org.domain) {
      throw new AppError('BAD_REQUEST', 400);
    }

    const defaultTeam = await tx.team.findFirst({
      where: { orgId: org.id, isDefault: true },
      select: { id: true },
    });
    if (!defaultTeam) {
      throw new AppError('INTERNAL', 500, 'DEFAULT_TEAM_MISSING');
    }

    if (existingMemberInOrg) {
      const now = new Date();
      const reactivatedMember = await tx.orgMember.update({
        where: { id: existingMemberInOrg.id },
        data: { role, status: 'ACTIVE', statusChangedAt: now },
        select: MEMBER_SELECT,
      });

      const existingTeamMembership = await tx.teamMember.findFirst({
        where: { teamId: defaultTeam.id, userId },
        select: { id: true },
      });
      if (existingTeamMembership) {
        await tx.teamMember.update({
          where: { id: existingTeamMembership.id },
          data: { status: 'ACTIVE', statusChangedAt: now },
        });
      } else {
        await tx.teamMember.create({
          data: { teamId: defaultTeam.id, userId },
        });
      }

      return { member: reactivatedMember, reactivated: true };
    }

    const created = await tx.orgMember.create({
      data: {
        orgId: org.id,
        userId,
        role,
      },
      select: MEMBER_SELECT,
    });

    await tx.teamMember.create({
      data: { teamId: defaultTeam.id, userId },
    });

    return { member: created, reactivated: false };
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'member.added',
    targetType: 'org_member',
    targetId: createdMember.id,
    metadata: reactivated ? { userId, role, reactivated: true } : { userId, role },
  });

  return toMemberRecord(createdMember, org.domain);
}

export async function changeOrganisationMemberRole(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    role: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps,
): Promise<OrganisationMemberRecord> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  const role = params.role.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  const orgRoles = parseOrgFeatureRoles(params.config);
  ensureOrgRole(role, orgRoles);
  if (role === 'owner') throw new AppError('BAD_REQUEST', 400, 'OWNER_ROLE_RESERVED');

  const prisma = deps?.prisma ?? (getPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });
  const { updated, previousRole } = await runInTransaction(prisma, async (tx) => {
    await lockOrganisationMemberships(tx, org.id, [userId, ...(actorUserId ? [actorUserId] : [])]);
    if (actorUserId) {
      const actorMembership = await getOrganisationMember(tx, { orgId: org.id, userId: actorUserId }, { activeOnly: true });
      requireOrgCapability(params.config, 'members.manage', actorMembership?.role);
    }
    const member = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId, status: 'ACTIVE' },
      select: { id: true, role: true, userId: true },
    });
    if (!member) throw new AppError('NOT_FOUND', 404);
    assertMutableOrganisationMember(member, org.ownerId);
    const updatedMember = await tx.orgMember.update({
      where: { id: member.id }, data: { role }, select: MEMBER_SELECT,
    });
    return { updated: updatedMember, previousRole: member.role };
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'member.role_changed',
    targetType: 'org_member',
    targetId: updated.id,
    metadata: { userId, role, previousRole },
  });

  return toMemberRecord(updated, org.domain);
}

export async function removeOrganisationMember(
  params: {
    orgId: string;
    domain: string;
    actorUserId?: string;
    actor?: OrgActorProvenance;
    userId: string;
    config: ClientConfig;
  },
  deps?: OrgServiceDeps & {
    afterMembershipStatusWrite?: () => Promise<void>;
    revokeRefreshTokenFamiliesForUserOrganisation?: typeof revokeRefreshTokenFamiliesForUserOrganisation;
    revokeRefreshTokensForUserDomain?: typeof revokeRefreshTokensForUserDomain;
  },
): Promise<{ removed: boolean }> {
  const env = deps?.env ?? getEnv();
  assertDatabaseEnabled(env);

  const actorUserId = resolveOrgActor(params);
  const userId = params.userId.trim();
  if (!userId) throw new AppError('BAD_REQUEST', 400);

  // This destructive lifecycle boundary must revoke scoped sessions issued by every product
  // domain in the same transaction, which requires the BYPASSRLS client.
  const prisma = deps?.prisma ?? (getAdminPrisma() as unknown as OrgServicePrisma);
  const org = await resolveOrganisation(prisma, { orgId: params.orgId });

  // Backend callers have independent authority; owner protection applies to every caller.
  const actorMembership = actorUserId
    ? await getOrganisationMember(
        prisma,
        { orgId: org.id, userId: actorUserId },
        { activeOnly: true },
      )
    : null;
  if (actorUserId) {
    requireOrgCapability(params.config, 'members.manage', actorMembership?.role);
  }

  const member = await getOrganisationMember(prisma, { orgId: org.id, userId });
  if (!member) throw new AppError('NOT_FOUND', 404);

  assertMutableOrganisationMember(member, org.ownerId);

  await runInTransaction(prisma, async (tx) => {
    await lockRefreshSessionUserDomain({ userId, domain: org.domain }, { prisma: tx });
    await lockOrganisationMemberships(tx, org.id, [userId, ...(actorUserId ? [actorUserId] : [])]);
    if (actorUserId) {
      const actorStanding = await getOrganisationMember(tx, { orgId: org.id, userId: actorUserId }, { activeOnly: true });
      requireOrgCapability(params.config, 'members.manage', actorStanding?.role);
    }
    await lockTeamMembershipRows({ userId, orgId: org.id }, { prisma: tx });
    const lockedMember = await tx.orgMember.findFirst({
      where: { orgId: org.id, userId },
      select: { id: true, role: true, userId: true },
    });
    if (!lockedMember) throw new AppError('NOT_FOUND', 404);

    assertMutableOrganisationMember(lockedMember, org.ownerId);

    const now = new Date();

    await tx.teamMember.updateMany({
      where: {
        userId,
        team: {
          orgId: org.id,
        },
        status: { not: 'REMOVED' },
      },
      data: { status: 'REMOVED', statusChangedAt: now },
    });
    // Groups have no status column (no lifecycle tombstone for group membership) — hard delete
    // remains correct here.
    await tx.groupMember.deleteMany({
      where: {
        userId,
        group: {
          orgId: org.id,
        },
      },
    });
    await tx.orgMember.update({
      where: { id: lockedMember.id },
      data: { status: 'REMOVED', statusChangedAt: now },
    });
    await deps?.afterMembershipStatusWrite?.();

    const revokeDeps = { now: () => now, prisma: tx };
    await (
      deps?.revokeRefreshTokenFamiliesForUserOrganisation ??
      revokeRefreshTokenFamiliesForUserOrganisation
    )(userId, org.id, revokeDeps);
    await (deps?.revokeRefreshTokensForUserDomain ?? revokeRefreshTokensForUserDomain)(
      userId,
      org.domain,
      revokeDeps,
    );
  });

  await auditOrg({
    orgId: org.id,
    actorUserId,
    actor: params.actor,
    action: 'member.removed',
    targetType: 'org_member',
    targetId: member.id,
    metadata: { userId, role: member.role },
  });

  return { removed: true };
}
