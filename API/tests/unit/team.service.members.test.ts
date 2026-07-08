import { describe, expect, it } from 'vitest';

import { addTeamMember, removeTeamMember } from '../../src/services/team.service.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

// CLAUDE.md 500-line split of team.service.test.ts: team membership add/remove. See
// team.service.test.ts (CRUD) and team.service.self-join.test.ts (self-join + HIDDEN visibility)
// for the rest. Only the location changed — no assertion here was altered from the pre-split file.
describe('Team service: members', () => {
  useTeamServiceTestEnv();

  it('prevents adding a user when the team is full', async () => {
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

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('prevents a user from exceeding max_team_memberships_per_user', async () => {
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
    prisma.orgMember.findFirst.mockImplementation((args: { where: { userId: string } }) => {
      const userId = args.where.userId;
      return Promise.resolve({
        id: `m-${userId}`,
        orgId: 'org-1',
        userId,
        role: userId === 'u-owner' ? 'owner' : 'member',
        createdAt: now,
        updatedAt: now,
      });
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(5);

    const promise = addTeamMember(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-target',
        config: makeConfig({ max_members_per_team: 50, max_team_memberships_per_user: 5 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
  });

  it('prevents removing a user from their final team membership', async () => {
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
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'tm-target',
      teamId: 'team-1',
      userId: 'u-target',
      teamRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.teamMember.count.mockResolvedValue(1);

    const promise = removeTeamMember(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-target',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
  });

  it('soft-removes a team member (status REMOVED) instead of deleting the row', async () => {
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
      id: 'm-owner',
      orgId: 'org-1',
      userId: 'u-owner',
      role: 'owner',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1' });
    prisma.teamMember.findFirst.mockResolvedValue({
      id: 'tm-target',
      teamId: 'team-1',
      userId: 'u-target',
      teamRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    // The user still has another ACTIVE team membership, so this is not their last team.
    prisma.teamMember.count.mockResolvedValue(2);
    prisma.teamMember.update.mockResolvedValue({ id: 'tm-target', status: 'REMOVED' });

    const result = await removeTeamMember(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        userId: 'u-target',
      },
      { prisma },
    );

    expect(result).toEqual({ removed: true });
    expect(prisma.teamMember.count).toHaveBeenCalledWith({
      where: { userId: 'u-target', team: { orgId: 'org-1' }, status: 'ACTIVE' },
    });
    expect(prisma.teamMember.delete).not.toHaveBeenCalled();
    expect(prisma.teamMember.update).toHaveBeenCalledWith({
      where: { id: 'tm-target' },
      data: { status: 'REMOVED', statusChangedAt: expect.any(Date) },
    });
  });

  it('reactivates a previously removed team member instead of rejecting as a duplicate', async () => {
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

    const member = await addTeamMember(
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

    expect(member).toMatchObject({ id: 'tm-old', userId: 'u-target' });
    expect(prisma.teamMember.create).not.toHaveBeenCalled();
    expect(prisma.teamMember.update).toHaveBeenCalledWith({
      where: { id: 'tm-old' },
      data: { teamRole: 'member', status: 'ACTIVE', statusChangedAt: expect.any(Date) },
      select: expect.any(Object),
    });
  });
});
