import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

import { listTeams, selfJoinTeam } from '../../src/services/team.service.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

// CLAUDE.md 500-line split of team.service.test.ts: Phase 4 self-join and HIDDEN-team visibility.
// See team.service.test.ts (CRUD) and team.service.members.test.ts (add/remove) for the rest.
// Only the location changed — no assertion here was altered from the pre-split file.
describe('Team service: self-join & visibility', () => {
  useTeamServiceTestEnv();

  describe('Phase 4: self-join (Task 2)', () => {
    function mockOrgAndActor(prisma: PrismaClient) {
      prisma.organisation.findFirst.mockResolvedValue({
        id: 'org-1',
        domain: 'acme.example.com',
        name: 'Acme',
        slug: 'acme',
        ownerId: 'u-owner',
        createdAt: now,
        updatedAt: now,
      });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'm-actor',
        orgId: 'org-1',
        userId: 'u-actor',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      });
    }

    it('allows self-join only when the team joinPolicy is OPEN_TO_ORG', async () => {
      const prisma = makePrismaMock();
      mockOrgAndActor(prisma);
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'OPEN_TO_ORG' });
      prisma.teamMember.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      prisma.teamMember.findFirst.mockResolvedValue(null);
      prisma.teamMember.create.mockResolvedValue({
        id: 'tm-new',
        teamId: 'team-1',
        userId: 'u-actor',
        teamRole: 'member',
        createdAt: now,
        updatedAt: now,
      });

      const member = await selfJoinTeam(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-actor',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(member).toMatchObject({ id: 'tm-new', userId: 'u-actor' });
      expect(prisma.teamMember.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { teamId: 'team-1', userId: 'u-actor' } }),
      );
    });

    it('rejects self-join for any policy other than OPEN_TO_ORG', async () => {
      const prisma = makePrismaMock();
      mockOrgAndActor(prisma);
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'INVITE_ONLY' });

      const promise = selfJoinTeam(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-actor',
          config: makeConfig(),
        },
        { prisma },
      );

      await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
    });

    it('reactivates a previously REMOVED membership instead of duplicating it', async () => {
      const prisma = makePrismaMock();
      mockOrgAndActor(prisma);
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'OPEN_TO_ORG' });
      prisma.teamMember.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-old', status: 'REMOVED' });
      prisma.teamMember.update.mockResolvedValue({
        id: 'tm-old',
        teamId: 'team-1',
        userId: 'u-actor',
        teamRole: 'member',
        createdAt: now,
        updatedAt: now,
      });

      const member = await selfJoinTeam(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-actor',
          config: makeConfig(),
        },
        { prisma },
      );

      expect(member).toMatchObject({ id: 'tm-old', userId: 'u-actor' });
      expect(prisma.teamMember.create).not.toHaveBeenCalled();
      expect(prisma.teamMember.update).toHaveBeenCalledWith({
        where: { id: 'tm-old' },
        data: { status: 'ACTIVE', statusChangedAt: expect.any(Date) },
        select: expect.any(Object),
      });
    });

    it('rejects self-join when the caller already has an ACTIVE membership', async () => {
      const prisma = makePrismaMock();
      mockOrgAndActor(prisma);
      prisma.team.findFirst.mockResolvedValue({ id: 'team-1', joinPolicy: 'OPEN_TO_ORG' });
      prisma.teamMember.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
      prisma.teamMember.findFirst.mockResolvedValue({ id: 'tm-active', status: 'ACTIVE' });

      const promise = selfJoinTeam(
        {
          orgId: 'org-1',
          teamId: 'team-1',
          domain: 'acme.example.com',
          actorUserId: 'u-actor',
          config: makeConfig(),
        },
        { prisma },
      );

      await expect(promise).rejects.toMatchObject({ code: 'BAD_REQUEST', statusCode: 400 });
      expect(prisma.teamMember.update).not.toHaveBeenCalled();
    });
  });

  describe('Phase 4: HIDDEN teams excluded from listing (Task 2)', () => {
    it('filters HIDDEN teams out of the where clause unless the caller is already an ACTIVE member', async () => {
      const prisma = makePrismaMock();

      prisma.organisation.findFirst.mockResolvedValue({
        id: 'org-1',
        domain: 'acme.example.com',
        name: 'Acme',
        slug: 'acme',
        ownerId: 'u-owner',
        createdAt: now,
        updatedAt: now,
      });
      prisma.orgMember.findFirst.mockResolvedValue({
        id: 'm-actor',
        orgId: 'org-1',
        userId: 'u-actor',
        role: 'member',
        createdAt: now,
        updatedAt: now,
      });
      prisma.team.findMany.mockResolvedValue([]);

      await listTeams(
        { orgId: 'org-1', domain: 'acme.example.com', actorUserId: 'u-actor' },
        { prisma },
      );

      expect(prisma.team.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            orgId: 'org-1',
            OR: [
              { NOT: { joinPolicy: 'HIDDEN' } },
              { members: { some: { userId: 'u-actor', status: 'ACTIVE' } } },
            ],
          },
        }),
      );
    });
  });
});
