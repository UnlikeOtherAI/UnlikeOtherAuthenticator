import { describe, expect, it } from 'vitest';

import {
  createTeam,
  deleteTeam,
  getTeam,
  listTeams,
  updateTeam,
} from '../../src/services/team.service.js';
import { makeConfig, makePrismaMock, now, useTeamServiceTestEnv } from './helpers/team-service-test-helpers.js';

// CLAUDE.md 500-line split: team.service.test.ts covers team CRUD (list/create/read/update/
// delete). Membership add/remove lives in team.service.members.test.ts; self-join and HIDDEN-team
// visibility live in team.service.self-join.test.ts. Shared mocks/config/env setup live in
// tests/unit/helpers/team-service-test-helpers.ts. Only the location changed — no assertion here
// was altered from the pre-split file.
describe('Team service', () => {
  useTeamServiceTestEnv();

  it('lists teams for an organisation member', async () => {
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
    prisma.team.findMany.mockResolvedValue([
      {
        id: 'team-new',
        orgId: 'org-1',
        groupId: null,
        name: 'New',
        slug: 'new',
        description: null,
        isDefault: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'team-old',
        orgId: 'org-1',
        groupId: null,
        name: 'Old',
        slug: 'old',
        description: null,
        isDefault: true,
        createdAt: new Date('2026-02-14T00:00:00.000Z'),
        updatedAt: new Date('2026-02-14T00:00:00.000Z'),
      },
    ]);

    const result = await listTeams(
      {
        orgId: 'org-1',
        domain: 'Acme.Example.com',
        actorUserId: 'u-owner',
        limit: 1,
        cursor: 'cursor-team',
      },
      { prisma },
    );

    expect(result).toMatchObject({
      data: [
        {
          id: 'team-new',
          orgId: 'org-1',
          groupId: null,
          name: 'New',
          slug: 'new',
          description: null,
          isDefault: false,
        },
      ],
      next_cursor: 'team-old',
    });
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orgId: 'org-1',
          OR: [
            { NOT: { joinPolicy: 'HIDDEN' } },
            { members: { some: { userId: 'u-owner', status: 'ACTIVE' } } },
          ],
        },
        take: 2,
        cursor: { id: 'cursor-team' },
        skip: 1,
      }),
    );
  });

  it('creates a team when the org is under the team quota', async () => {
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
    prisma.team.count.mockResolvedValue(1);
    prisma.team.create.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering',
      description: 'Core',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const team = await createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Engineering',
        description: 'Core',
        config: makeConfig({ max_teams_per_org: 2 }),
      },
      { prisma },
    );

    expect(team).toMatchObject({
      id: 'team-1',
      orgId: 'org-1',
      name: 'Engineering',
      slug: 'engineering',
      description: 'Core',
    });
  });

  it('derives a numbered slug when the base team slug is already taken', async () => {
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
    prisma.team.count.mockResolvedValue(1);
    prisma.team.findFirst
      .mockResolvedValueOnce({ id: 'existing-team' })
      .mockResolvedValueOnce(null);
    prisma.team.create.mockResolvedValue({
      id: 'team-2',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering-2',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const team = await createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Engineering',
        config: makeConfig(),
      },
      { prisma },
    );

    expect(team.slug).toBe('engineering-2');
    expect(prisma.team.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          slug: 'engineering-2',
        }),
      }),
    );
  });

  it('rejects creating a team when org reaches max_teams_per_org', async () => {
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
    prisma.team.count.mockResolvedValue(2);

    const promise = createTeam(
      {
        orgId: 'org-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Engineering',
        config: makeConfig({ max_teams_per_org: 2 }),
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.team.create).not.toHaveBeenCalled();
  });

  it('reads a team and maps members', async () => {
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
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Engineering',
      slug: 'engineering',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
      members: [
        {
          id: 'tm-owner',
          teamId: 'team-1',
          userId: 'u-owner',
          teamRole: 'lead',
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    const result = await getTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    expect(result).toMatchObject({
      id: 'team-1',
      name: 'Engineering',
      slug: 'engineering',
      members: [{ userId: 'u-owner', teamRole: 'lead' }],
    });
    // Gap-fix A Task 2: absent `?include=invited` must be byte-identical to before — no `invited`
    // key at all (not even an empty array).
    expect(result).not.toHaveProperty('invited');
    expect(prisma.teamInvite.findMany).not.toHaveBeenCalled();
  });

  // include=invited coverage (owner/admin sees pending entries incl. PENDING approvalStatus; a
  // plain member gets []) lives in team.service.invited.test.ts (CLAUDE.md 500-line split).

  it('updates a team name and description', async () => {
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
    prisma.team.findFirst.mockResolvedValue({ id: 'team-1', slug: 'engineering' });
    prisma.team.update.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Platform',
      slug: 'platform',
      description: 'Core infra',
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await updateTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
        name: 'Platform',
        description: 'Core infra',
      },
      { prisma },
    );

    expect(result.name).toBe('Platform');
    expect(result.slug).toBe('platform');
  });

  // icon_url validation coverage (accept https, clear on null, reject junk) lives in
  // team.service.icon-url.test.ts (CLAUDE.md 500-line split).

  it('reassigns remaining users before deleting a team', async () => {
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
    prisma.team.findFirst
      .mockResolvedValueOnce({ id: 'team-1', isDefault: false })
      .mockResolvedValueOnce({ id: 'team-default' });
    prisma.teamMember.findMany.mockResolvedValue([{ userId: 'u-owner' }, { userId: 'u-2' }]);
    prisma.teamMember.count.mockImplementation(async (args: { where: { userId?: string } }) => {
      if (args.where.userId === 'u-owner') return 1;
      return 2;
    });
    prisma.teamMember.create.mockResolvedValue({
      id: 'tm-moved',
      teamId: 'team-default',
      userId: 'u-owner',
      teamRole: 'member',
      createdAt: now,
      updatedAt: now,
    });
    prisma.team.delete.mockResolvedValue({
      id: 'team-1',
      orgId: 'org-1',
      groupId: null,
      name: 'Platform',
      slug: 'platform',
      description: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });

    const result = await deleteTeam(
      {
        orgId: 'org-1',
        teamId: 'team-1',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    expect(result).toEqual({ deleted: true });
    expect(prisma.teamMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          teamId: 'team-default',
          userId: 'u-owner',
        },
      }),
    );
    expect(prisma.team.delete).toHaveBeenCalledWith({ where: { id: 'team-1' } });
  });

  it('rejects deleting the default team', async () => {
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
    prisma.team.findFirst.mockResolvedValue({
      id: 'team-default',
      isDefault: true,
    });

    const promise = deleteTeam(
      {
        orgId: 'org-1',
        teamId: 'team-default',
        domain: 'acme.example.com',
        actorUserId: 'u-owner',
      },
      { prisma },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      statusCode: 400,
    });
    expect(prisma.team.delete).not.toHaveBeenCalled();
  });
});
