import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import type { OrgActorProvenance } from '../../src/services/org-audit-log.service.js';
import { ORG_AUDIT_ACTOR_METADATA_KEY } from '../../src/services/org-audit-log.service.js';
import {
  addTeamMember,
  changeTeamMemberRole,
  removeTeamMember,
} from '../../src/services/team.service.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

// `auditOrg` writes best-effort through the BYPASSRLS admin client *after* the mutation's own
// transaction commits (design §4.10), so the audit row lands on this client rather than on the
// tenant client the mutation used.
const orgAuditLog = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../src/db/prisma.js', () => ({
  getPrisma: () => {
    throw new Error('getPrisma() must not be reached: every test injects deps.prisma');
  },
  getAdminPrisma: () => ({ orgAuditLog }),
  connectPrisma: async () => {},
  disconnectPrisma: async () => {},
}));

const actor: OrgActorProvenance = {
  via: 'domain_backend',
  sourceDomain: 'api.hugopos.eu',
};

/**
 * The three manager-driven team mutations (`addTeamMember`, `changeTeamMemberRole`,
 * `removeTeamMember`) each declared an `OrgAuditAction` but wrote no row, so an owner/admin — or a
 * product backend calling under the domain pairing — could add, re-role, or remove a
 * team member without leaving a trace. These tests pin the row each one writes and the provenance
 * that distinguishes a domain backend acting from a user acting.
 */
describe('Team service: members audit trail', () => {
  useTeamServiceTestEnv();

  /** Org + an owner actor whose membership lookup answers for any userId. */
  function mockOrgAndOwnerActor(prisma: PrismaClient): void {
    prisma.organisation.findFirst.mockResolvedValue({
      id: 'org-1',
      domain: 'acme.example.com',
      name: 'Acme',
      slug: 'acme',
      ownerId: 'u-owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.orgMember.findFirst.mockImplementation((args: { where: { userId: string } }) => {
      const userId = args.where.userId;
      return Promise.resolve({
        id: `m-${userId}`,
        orgId: 'org-1',
        userId,
        role: 'owner',
        createdAt: now,
        updatedAt: now,
      });
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
  }

  function auditData(): Record<string, unknown> {
    expect(orgAuditLog.create).toHaveBeenCalledTimes(1);
    return orgAuditLog.create.mock.calls[0][0].data;
  }

  describe('addTeamMember', () => {
    function mockFreshAdd(prisma: PrismaClient): void {
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      prisma.teamMember.findFirst.mockResolvedValue(null);
      prisma.teamMember.create.mockResolvedValue({
        id: 'tm-new',
        teamId: 'team-1',
        userId: 'u-target',
        teamRole: 'admin',
        createdAt: now,
        updatedAt: now,
      });
    }

    it('writes a team_member.added row for the created membership', async () => {
      const prisma = makePrismaMock();
      mockFreshAdd(prisma);

      await addTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          teamRole: 'admin',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData()).toEqual({
        orgId: 'org-1',
        actorUserId: 'u-owner',
        action: 'team_member.added',
        targetType: 'team_member',
        targetId: 'tm-new',
        metadata: {
          teamId: 'team-1',
          userId: 'u-target',
          teamRole: 'admin',
          via: 'manager',
        },
      });
    });

    it('records backend actor provenance under the reserved metadata key', async () => {
      const prisma = makePrismaMock();
      mockFreshAdd(prisma);

      await addTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actor,
          userId: 'u-target',
          teamRole: 'admin',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData().metadata).toEqual({
        teamId: 'team-1',
        userId: 'u-target',
        teamRole: 'admin',
        via: 'manager',
        [ORG_AUDIT_ACTOR_METADATA_KEY]: {
          via: 'domain_backend',
          source_domain: 'api.hugopos.eu',
        },
      });
    });

    it('marks a reactivated tombstone so it is not read as a brand-new membership', async () => {
      const prisma = makePrismaMock();
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-old', status: 'REMOVED' });
      prisma.teamMember.update.mockResolvedValue({
        id: 'tm-old',
        teamId: 'team-1',
        userId: 'u-target',
        teamRole: 'member',
        createdAt: now,
        updatedAt: now,
      });

      await addTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData()).toMatchObject({
        action: 'team_member.added',
        targetId: 'tm-old',
        metadata: {
          teamId: 'team-1',
          userId: 'u-target',
          teamRole: 'member',
          via: 'manager',
          reactivated: true,
        },
      });
    });

    it('writes no row when the mutation is rejected', async () => {
      const prisma = makePrismaMock();
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.count.mockResolvedValue(10);

      const promise = addTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          config: makeConfig({ max_members_per_team: 10 }),
        },
        { prisma },
      );

      await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      expect(orgAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('changeTeamMemberRole', () => {
    function mockRoleChange(prisma: PrismaClient): void {
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-target', teamRole: 'member' });
      prisma.teamMember.update.mockResolvedValue({
        id: 'tm-target',
        teamId: 'team-1',
        userId: 'u-target',
        teamRole: 'admin',
        createdAt: now,
        updatedAt: now,
      });
    }

    it('writes a team_member.role_changed row carrying the previous role', async () => {
      const prisma = makePrismaMock();
      mockRoleChange(prisma);

      await changeTeamMemberRole(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          teamRole: 'admin',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData()).toEqual({
        orgId: 'org-1',
        actorUserId: 'u-owner',
        action: 'team_member.role_changed',
        targetType: 'team_member',
        targetId: 'tm-target',
        metadata: {
          teamId: 'team-1',
          userId: 'u-target',
          teamRole: 'admin',
          previousTeamRole: 'member',
          via: 'manager',
        },
      });
    });

    it('records backend actor provenance under the reserved metadata key', async () => {
      const prisma = makePrismaMock();
      mockRoleChange(prisma);

      await changeTeamMemberRole(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actor,
          userId: 'u-target',
          teamRole: 'admin',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData().metadata).toMatchObject({
        [ORG_AUDIT_ACTOR_METADATA_KEY]: {
          via: 'domain_backend',
          source_domain: 'api.hugopos.eu',
        },
      });
    });

    it('writes no row when the member has no ACTIVE membership to re-role', async () => {
      const prisma = makePrismaMock();
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.findFirst.mockResolvedValue(null);

      const promise = changeTeamMemberRole(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          teamRole: 'admin',
          config: makeConfig(),
        },
        { prisma },
      );

      await expect(promise).rejects.toMatchObject({ code: 'NOT_FOUND', statusCode: 404 });
      expect(orgAuditLog.create).not.toHaveBeenCalled();
    });
  });

  describe('removeTeamMember', () => {
    function mockRemoval(prisma: PrismaClient): void {
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-target', teamRole: 'admin' });
      // The user still has another ACTIVE membership, so this is not their last team.
      prisma.teamMember.count.mockResolvedValue(2);
      prisma.teamMember.update.mockResolvedValue({ id: 'tm-target', status: 'REMOVED' });
    }

    it('writes a team_member.removed row for the tombstoned membership', async () => {
      const prisma = makePrismaMock();
      mockRemoval(prisma);

      await removeTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData()).toEqual({
        orgId: 'org-1',
        actorUserId: 'u-owner',
        action: 'team_member.removed',
        targetType: 'team_member',
        targetId: 'tm-target',
        metadata: {
          teamId: 'team-1',
          userId: 'u-target',
          teamRole: 'admin',
          via: 'manager',
        },
      });
    });

    it('records backend actor provenance under the reserved metadata key', async () => {
      const prisma = makePrismaMock();
      mockRemoval(prisma);

      await removeTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actor,
          userId: 'u-target',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(auditData().metadata).toMatchObject({
        [ORG_AUDIT_ACTOR_METADATA_KEY]: {
          via: 'domain_backend',
          source_domain: 'api.hugopos.eu',
        },
      });
    });

    it('writes no row when removal is rejected as the last team membership', async () => {
      const prisma = makePrismaMock();
      mockOrgAndOwnerActor(prisma);
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-target', teamRole: 'member' });
      prisma.teamMember.count.mockResolvedValue(1);

      const promise = removeTeamMember(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-owner',
          userId: 'u-target',
          config: makeConfig(),
        },
        { prisma },
      );

      await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      expect(orgAuditLog.create).not.toHaveBeenCalled();
    });
  });
});
