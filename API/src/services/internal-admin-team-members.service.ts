import type { PrismaClient } from '@prisma/client';

import { getAdminPrisma } from '../db/prisma.js';
import { runInTransaction } from '../db/tenant-context.js';
import { AppError } from '../utils/errors.js';
import { writeAuditLog } from './audit-log.service.js';
import { OrgFeaturesSchema } from './config-org-features.schema.js';
import {
  assertMutableOrganisationMember,
  lockOrganisationMemberships,
} from './organisation-membership-lock.service.js';
import { writeOrgAuditLog, type OrgActorProvenance } from './org-audit-log.service.js';
import { lockRefreshSessionUser } from './refresh-session-lock.service.js';
import { lockTeamMembershipRows } from './team-scope.service.js';
import { assertEntityAccess } from './entity-lifecycle.service.js';
import { requireLifecycleActor } from './internal-admin-lifecycle.service.js';
import { lockProductTeamPolicyExclusive } from './product-team-policy-lock.service.js';

// Platform administration has no caller-supplied product config. Use UOA's standard limits.
const limits = OrgFeaturesSchema.parse({});

export async function addAdminUserToTeam(
  input: {
    userId: string;
    orgId: string;
    teamId: string;
    teamRole: 'member' | 'admin';
    actor: Extract<OrgActorProvenance, { via: 'admin_superuser' }> & { tokenVersion: number };
  },
  deps: { prisma?: PrismaClient } = {},
) {
  if (!['member', 'admin'].includes(input.teamRole)) throw new AppError('BAD_REQUEST', 400);
  const prisma = deps.prisma ?? getAdminPrisma();
  return runInTransaction(prisma, async (tx) => {
    await lockProductTeamPolicyExclusive(tx);
    await requireLifecycleActor(tx, input.actor);
    await lockRefreshSessionUser(input.userId, { prisma: tx });
    await lockOrganisationMemberships(tx, input.orgId, [input.userId]);
    await lockTeamMembershipRows(input, { prisma: tx });

    const org = await tx.organisation.findUniqueOrThrow({ where: { id: input.orgId } });
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { domain: true },
    });
    const team = await tx.team.findFirst({ where: { id: input.teamId, orgId: org.id } });
    if (!user || !team || (user.domain && user.domain !== org.domain)) {
      throw new AppError('BAD_REQUEST', 400);
    }
    await assertEntityAccess(input, tx);
    const member = await tx.orgMember.findUnique({
      where: { orgId_userId: { orgId: org.id, userId: input.userId } },
    });
    if (member?.status === 'DEACTIVATED')
      throw new AppError('BAD_REQUEST', 400, 'MEMBERSHIP_DEACTIVATED');
    const addingOrg = member?.status !== 'ACTIVE';
    if (addingOrg && org.ownerId === input.userId)
      throw new AppError('BAD_REQUEST', 400, 'OWNER_PROTECTED');
    if (!org.ownerId) throw new AppError('FORBIDDEN', 403, 'ACCESS_DENIED');
    if (addingOrg && member) assertMutableOrganisationMember(member, org.ownerId);

    const targetTeams = [{ id: team.id, role: input.teamRole }];
    if (addingOrg) {
      const defaultTeam = await tx.team.findFirst({ where: { orgId: org.id, isDefault: true } });
      if (!defaultTeam) throw new AppError('INTERNAL', 500, 'DEFAULT_TEAM_MISSING');
      await assertEntityAccess({ orgId: org.id, teamId: defaultTeam.id }, tx);
      if (defaultTeam.id !== team.id) targetTeams.push({ id: defaultTeam.id, role: 'member' });
      const count = await tx.orgMember.count({ where: { orgId: org.id, status: 'ACTIVE' } });
      if (count >= limits.max_members_per_org) throw new AppError('BAD_REQUEST', 400);
    }

    // Validate every seat before writing. An Add never changes an active member's role.
    const memberships = await tx.teamMember.findMany({
      where: { userId: input.userId, team: { orgId: org.id } },
    });
    let activeCount = memberships.filter((row) => row.status === 'ACTIVE').length;
    for (const target of targetTeams) {
      const existing = memberships.find((row) => row.teamId === target.id);
      if (existing?.status === 'DEACTIVATED')
        throw new AppError('BAD_REQUEST', 400, 'MEMBERSHIP_DEACTIVATED');
      if (existing?.status === 'ACTIVE') {
        if (target.id === team.id && existing.teamRole !== input.teamRole) {
          throw new AppError('BAD_REQUEST', 400);
        }
        continue;
      }
      if (existing?.teamRole === 'owner') throw new AppError('BAD_REQUEST', 400, 'OWNER_PROTECTED');
      const count = await tx.teamMember.count({ where: { teamId: target.id, status: 'ACTIVE' } });
      if (
        count >= limits.max_members_per_team ||
        ++activeCount > limits.max_team_memberships_per_user
      ) {
        throw new AppError('BAD_REQUEST', 400);
      }
    }

    const now = new Date();
    const audit = { orgId: org.id, actor: input.actor };
    if (addingOrg) {
      const orgMember = await tx.orgMember.upsert({
        where: { orgId_userId: { orgId: org.id, userId: input.userId } },
        create: { orgId: org.id, userId: input.userId, role: 'member' },
        update: { role: 'member', status: 'ACTIVE', statusChangedAt: now },
      });
      await writeOrgAuditLog(
        {
          ...audit,
          action: 'member.added',
          targetType: 'org_member',
          targetId: orgMember.id,
          metadata: { userId: input.userId, role: 'member', reactivated: Boolean(member) },
        },
        { prisma: tx },
      );
    }

    const addedTeamIds: string[] = [];
    for (const target of targetTeams) {
      const existing = memberships.find((row) => row.teamId === target.id);
      if (existing?.status === 'ACTIVE') continue;
      const teamMember = await tx.teamMember.upsert({
        where: { teamId_userId: { teamId: target.id, userId: input.userId } },
        create: { teamId: target.id, userId: input.userId, teamRole: target.role },
        update: { teamRole: target.role, status: 'ACTIVE', statusChangedAt: now },
      });
      addedTeamIds.push(target.id);
      await writeOrgAuditLog(
        {
          ...audit,
          action: 'team_member.added',
          targetType: 'team_member',
          targetId: teamMember.id,
          metadata: {
            userId: input.userId,
            teamId: target.id,
            teamRole: target.role,
            reactivated: Boolean(existing),
          },
        },
        { prisma: tx },
      );
    }
    if (addingOrg || addedTeamIds.length) {
      await writeAuditLog(
        {
          actorEmail: input.actor.email,
          action: 'user.team_added',
          targetDomain: org.domain,
          metadata: {
            userId: input.userId,
            orgId: org.id,
            teamId: team.id,
            teamRole: input.teamRole,
            addedOrganisation: addingOrg,
            addedTeamIds,
          },
        },
        { prisma: tx },
      );
    }
    return {
      ok: true,
      userId: input.userId,
      orgId: org.id,
      teamId: team.id,
      teamRole: input.teamRole,
    };
  });
}
